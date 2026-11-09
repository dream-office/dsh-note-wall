// dsh-note-wall — Host-side note store.
//
// The wall is a plugin-owned list kept in one JSON file under `$DSH_HOME`, so
// every profile using that home shares it. Notes may carry an http(s) link and
// one attached image; image bytes live beside the store and are referenced by a
// generated id. This module owns validation, limits, ordering, atomic writes
// and image cleanup; the HTTP routes in index.js only translate a request into
// one store operation.
//
// Every mutation is serialized through one queue and rolls back its in-memory
// change when the atomic write fails, so the wall never shows a saved note that
// is not on disk.

import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMAGE_MAX_BYTES, isImageId } from './images.js'

/** Note colors the page offers, in palette order. */
export const TONES = Object.freeze(['amber', 'peach', 'sky', 'mint', 'lilac', 'cream'])

/** Limits enforced for every mutation and every upload. */
export const LIMITS = Object.freeze({
  maxNotes: 500,
  maxNoteChars: 500,
  maxTagChars: 24,
  maxLinkChars: 2048,
  maxImageBytes: IMAGE_MAX_BYTES,
})

/** File format version written by this build. */
export const STORE_VERSION = 1

const MAX_ID_CHARS = 80
const HEX_TONE_PATTERN = /^#[0-9a-f]{6}$/

/** Expected validation or protocol failure; index.js maps it to an HTTP status. */
export class NoteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NoteError'
    this.code = code
  }
}

function charCount(value) {
  return Array.from(value).length
}

function normalizeText(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

function normalizeTag(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return undefined
  return value.trim()
}

function normalizeTone(value) {
  if (typeof value !== 'string') return undefined
  if (TONES.includes(value)) return value
  const tone = value.trim().toLowerCase()
  return HEX_TONE_PATTERN.test(tone) ? tone : undefined
}

function normalizeLink(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return undefined
  const link = value.trim()
  if (link.length === 0) return ''
  if (charCount(link) > LIMITS.maxLinkChars) return undefined
  try {
    const parsed = new URL(link)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function normalizeImage(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || !isImageId(value)) return undefined
  return value
}

/** Request-facing link parsing: throws a coded error instead of returning undefined. */
function parseLinkInput(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new NoteError('note-link-invalid', '链接必须是 http 或 https 地址。')
  const link = value.trim()
  if (link.length === 0) return ''
  if (charCount(link) > LIMITS.maxLinkChars) {
    throw new NoteError('note-link-too-long', `链接最多 ${LIMITS.maxLinkChars} 个字符。`)
  }
  const normalized = normalizeLink(link)
  if (normalized === undefined) throw new NoteError('note-link-invalid', '链接必须是 http 或 https 地址。')
  return normalized
}

function parseImageInput(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new NoteError('note-image-invalid', '图片标识无效。')
  const image = value.trim()
  if (image.length === 0) return ''
  if (!isImageId(image)) {
    throw new NoteError('note-image-invalid', '图片标识无效。')
  }
  return image
}

function toIso(ms) {
  return new Date(ms).toISOString()
}

function cloneRecord(record) {
  return {
    id: record.id,
    text: record.text,
    tag: record.tag,
    tone: record.tone,
    link: record.link,
    image: record.image,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Rebuild one stored record, dropping anything malformed. */
function normalizeStored(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0 || id.length > MAX_ID_CHARS) return undefined
  const text = normalizeText(raw.text)
  if (text === undefined || charCount(text) > LIMITS.maxNoteChars) return undefined
  const tag = normalizeTag(raw.tag)
  if (tag === undefined || charCount(tag) > LIMITS.maxTagChars) return undefined
  // A malformed stored link or image reference must not cost the note text.
  const link = normalizeLink(raw.link) ?? ''
  const image = normalizeImage(raw.image) ?? ''
  const createdMs = Date.parse(raw.createdAt)
  if (!Number.isFinite(createdMs)) return undefined
  const updatedMs = Date.parse(raw.updatedAt)
  return {
    id,
    text,
    tag,
    tone: normalizeTone(raw.tone) ?? 'amber',
    link,
    image,
    createdAt: toIso(createdMs),
    updatedAt: toIso(Number.isFinite(updatedMs) ? updatedMs : createdMs),
  }
}

/** Newest first; ids break ties so ordering is stable across reloads. */
function compareNotes(a, b) {
  const left = Date.parse(a.createdAt)
  const right = Date.parse(b.createdAt)
  if (left !== right) return right - left
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function isValidDocument(parsed) {
  return parsed !== null
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.version === STORE_VERSION
    && Array.isArray(parsed.notes)
}

export class NoteStore {
  constructor({ dir, imagesDir, logger = console, now = () => Date.now() }) {
    if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('NoteStore needs a directory')
    this.dir = dir
    this.imagesDir = typeof imagesDir === 'string' && imagesDir.length > 0 ? imagesDir : join(dir, 'images')
    this.file = join(dir, 'store.json')
    this.logger = logger
    this.now = now
    this.notes = []
    this.loaded = false
    this.mutationQueue = Promise.resolve()
  }

  /**
   * Read the wall from disk. A missing file means an empty wall; an unreadable
   * or unrecognized file is quarantined, and if it cannot be preserved the load
   * fails so the route stops serving and never overwrites the original.
   */
  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.notes = []
        this.loaded = true
        return this.list()
      }
      this.loaded = true
      throw error
    }

    let parsed
    let unrecognized = false
    try {
      parsed = JSON.parse(raw)
    } catch {
      unrecognized = true
    }
    if (!unrecognized && !isValidDocument(parsed)) unrecognized = true

    if (unrecognized) {
      this.logger.warn?.('[note-wall] 便签存储无法识别，将保留原文件并重新开始')
      const preserved = await this.quarantine()
      if (!preserved) {
        this.loaded = true
        throw new NoteError('store-corrupt-unreadable', '便签存储损坏且无法保留原文件，已停止读写以保护数据。')
      }
      this.notes = []
      this.loaded = true
      return this.list()
    }

    const seen = new Set()
    const notes = []
    for (const entry of parsed.notes) {
      const record = normalizeStored(entry)
      if (record === undefined || seen.has(record.id)) continue
      seen.add(record.id)
      notes.push(record)
    }
    this.notes = notes.sort(compareNotes).slice(0, LIMITS.maxNotes)
    this.loaded = true
    return this.list()
  }

  /** Keep an unrecognized file next to the store instead of deleting user data. */
  async quarantine() {
    const stamp = toIso(this.now()).replace(/[:.]/g, '-')
    const target = join(this.dir, `store.corrupt-${stamp}.json`)
    try {
      await rename(this.file, target)
      this.logger.warn?.(`[note-wall] 无法识别的便签存储已改名保留：${target}`)
      return true
    } catch (error) {
      this.logger.error?.('[note-wall] 无法保留无法识别的便签存储', error)
      return false
    }
  }

  /** Ordered copy of the wall; callers never receive internal records. */
  list() {
    return this.notes.slice().sort(compareNotes).map(cloneRecord)
  }

  /** Serialize one mutation: mutate, write, and roll back on a write failure. */
  enqueue(task) {
    const run = this.mutationQueue.catch(() => {}).then(task)
    this.mutationQueue = run
    return run
  }

  async add(input) {
    return this.enqueue(async () => {
      const payload = input !== null && typeof input === 'object' ? input : {}
      const text = normalizeText(payload.text)
      if (text === undefined) throw new NoteError('note-text-required', '便签内容不能为空。')
      if (charCount(text) > LIMITS.maxNoteChars) {
        throw new NoteError('note-text-too-long', `便签最多 ${LIMITS.maxNoteChars} 个字符。`)
      }
      const tag = normalizeTag(payload.tag)
      if (tag === undefined) throw new NoteError('note-tag-invalid', '分类必须是文本。')
      if (charCount(tag) > LIMITS.maxTagChars) {
        throw new NoteError('note-tag-too-long', `分类最多 ${LIMITS.maxTagChars} 个字符。`)
      }
      const link = parseLinkInput(payload.link)
      const image = parseImageInput(payload.image)
      if (image) await this.assertImageExists(image)
      const tone = payload.tone === undefined ? 'amber' : normalizeTone(payload.tone)
      if (tone === undefined) throw new NoteError('note-tone-invalid', '未知的便签颜色。')
      if (this.notes.length >= LIMITS.maxNotes) {
        throw new NoteError('note-limit-reached', `便签墙最多 ${LIMITS.maxNotes} 条，请先删除一些。`)
      }
      const stamp = toIso(this.now())
      const record = { id: randomUUID(), text, tag, tone, link, image, createdAt: stamp, updatedAt: stamp }
      const previous = this.notes
      this.notes = [record, ...previous]
      try {
        await this.writeSnapshot(this.notes)
      } catch (error) {
        this.notes = previous
        throw error
      }
      return cloneRecord(record)
    })
  }

  async update(input) {
    return this.enqueue(async () => {
      const payload = input !== null && typeof input === 'object' ? input : {}
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      if (id.length === 0) throw new NoteError('note-id-required', '缺少便签 id。')
      const index = this.notes.findIndex(note => note.id === id)
      if (index < 0) throw new NoteError('note-not-found', '这条便签已不存在。')
      const current = this.notes[index]
      if (payload.baseUpdatedAt !== undefined && payload.baseUpdatedAt !== current.updatedAt) {
        throw new NoteError('note-conflict', '这条便签已在别处修改，请重新打开后再编辑。')
      }
      const next = { ...current }
      if (payload.text !== undefined) {
        const text = normalizeText(payload.text)
        if (text === undefined) throw new NoteError('note-text-required', '便签内容不能为空。')
        if (charCount(text) > LIMITS.maxNoteChars) {
          throw new NoteError('note-text-too-long', `便签最多 ${LIMITS.maxNoteChars} 个字符。`)
        }
        next.text = text
      }
      if (payload.tag !== undefined) {
        const tag = normalizeTag(payload.tag)
        if (tag === undefined) throw new NoteError('note-tag-invalid', '分类必须是文本。')
        if (charCount(tag) > LIMITS.maxTagChars) {
          throw new NoteError('note-tag-too-long', `分类最多 ${LIMITS.maxTagChars} 个字符。`)
        }
        next.tag = tag
      }
      if (payload.link !== undefined) next.link = parseLinkInput(payload.link)
      if (payload.image !== undefined) {
        next.image = parseImageInput(payload.image)
        if (next.image) await this.assertImageExists(next.image)
      }
      if (payload.tone !== undefined) {
        const tone = normalizeTone(payload.tone)
        if (tone === undefined) throw new NoteError('note-tone-invalid', '未知的便签颜色。')
        next.tone = tone
      }
      if (
        payload.text === undefined
        && payload.tag === undefined
        && payload.tone === undefined
        && payload.link === undefined
        && payload.image === undefined
      ) {
        throw new NoteError('note-nothing-to-update', '没有需要更新的内容。')
      }
      next.updatedAt = toIso(this.now())
      const previousNotes = this.notes
      this.notes = previousNotes.slice()
      this.notes[index] = next
      try {
        await this.writeSnapshot(this.notes)
      } catch (error) {
        this.notes = previousNotes
        throw error
      }
      await this.cleanupImage(current.image)
      return cloneRecord(next)
    })
  }

  /** Idempotent: removing an already-missing note reports false. */
  async remove(input) {
    return this.enqueue(async () => {
      const payload = input !== null && typeof input === 'object' ? input : {}
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      if (id.length === 0) throw new NoteError('note-id-required', '缺少便签 id。')
      const index = this.notes.findIndex(note => note.id === id)
      if (index < 0) return false
      const previous = this.notes
      const removed = previous[index]
      this.notes = previous.slice()
      this.notes.splice(index, 1)
      try {
        await this.writeSnapshot(this.notes)
      } catch (error) {
        this.notes = previous
        throw error
      }
      await this.cleanupImage(removed.image)
      return true
    })
  }

  /** Drop an uploaded image that no note references (compose abandoned mid-save). */
  async discardImage(input) {
    return this.enqueue(async () => {
      const payload = input !== null && typeof input === 'object' ? input : {}
      const id = typeof payload.id === 'string' ? payload.id.trim() : ''
      if (!isImageId(id)) throw new NoteError('note-image-invalid', '图片标识无效。')
      if (this.notes.some(note => note.image === id)) return false
      try {
        await unlink(join(this.imagesDir, id))
        return true
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return true
        this.logger.warn?.('[note-wall] 无法删除未引用的图片', error)
        return false
      }
    })
  }

  /** Best-effort image removal that never removes a file another note uses. */
  async cleanupImage(image) {
    if (!isImageId(image)) return
    if (this.notes.some(note => note.image === image)) return
    try {
      await unlink(join(this.imagesDir, image))
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
        this.logger.warn?.('[note-wall] 无法删除便签图片', error)
      }
    }
  }

  /** A note may only reference an image file that exists right now. */
  async assertImageExists(image) {
    try {
      await access(join(this.imagesDir, image))
    } catch {
      throw new NoteError('note-image-missing', '图片不存在或已被清理，请重新选择。')
    }
  }

  /** Atomic write: a per-call temp file, then a rename over the store. */
  async writeSnapshot(notes) {
    await mkdir(this.dir, { recursive: true })
    const snapshot = { version: STORE_VERSION, notes: notes.map(cloneRecord) }
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temp, this.file)
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        // The temp file is best-effort cleanup; the original error matters.
      }
      throw error
    }
  }

  /** Best-effort drain used by the plugin unload effect. */
  async flush() {
    try {
      await this.mutationQueue
    } catch (error) {
      this.logger.error?.('[note-wall] 便签保存失败', error)
    }
  }
}
