// dsh-note-wall — Host-side ZIP backup and restore.
//
// A backup is a plain ZIP archive so it opens with Windows Explorer,
// `Expand-Archive`, `unzip` or `tar -xf` without the plugin installed:
//
//   notes.json      { format, version, exportedAt, notes, folders }
//   images/<id>     every image referenced by an exported note
//   settings.json   optional wall settings (export ?settings=0 omits it)
//   manifest.json   counts, file list, missing image ids and total bytes
//
// The ZIP codec is hand-written on top of node:zlib: local headers, central
// directory, EOCD, CRC32 and DOS timestamps, UTF-8 file names, no data
// descriptors and no ZIP64. The reader is deliberately strict: it rejects
// encryption, unsupported compression, data descriptors, duplicate names,
// path traversal, CRC mismatches and archives whose declared uncompressed size
// exceeds the import budget, so a malicious archive cannot exhaust memory.
//
// This module also owns the export/import operation itself: it validates the
// whole archive before touching disk, writes a safety backup before a replace,
// stages images atomically, and only then asks the stores to persist the new
// wall. A validation failure never leaves the wall half-imported.
//
// Import policy choices (also visible in the route response):
//   * replace: archive first, then `backups/note-wall-auto-<stamp>.zip`, then
//     images/settings, then one atomic store write, then old image cleanup.
//   * merge: append with fresh ids, map folders by name, never delete and never
//     apply settings unless `applySettings=1` is explicit.
//   * a note whose image is neither in the archive nor already in the wall is
//     skipped and counted in `skippedNotes`, never imported without its image.
//   * `imageCount` is the number of distinct archived images referenced by the
//     notes that survive validation (an identical existing file still counts).

import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { IMAGE_MAX_BYTES, isImageId, mediaTypeForImage, sniffImage } from './images.js'
import { LIMITS, NoteError, normalizeBackupFolder, normalizeBackupNote } from './store.js'
import { parseImportedSettings } from './settings.js'

/** Marker in notes.json so a random JSON file is never mistaken for a backup. */
export const BACKUP_FORMAT = 'dsh-note-wall-backup'

/** Container/document version written by this build. */
export const BACKUP_FORMAT_VERSION = 2

/** Hard bounds applied while reading an uploaded archive. */
export const BACKUP_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 600,
  maxImageCount: 500,
  maxImageBytes: IMAGE_MAX_BYTES,
  maxNotesJsonBytes: 8 * 1024 * 1024,
  maxSettingsBytes: 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
})

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP_UTF8_FLAG = 0x0800
const ZIP_ALLOWED_FLAGS = ZIP_UTF8_FLAG | 0x0002
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** Standard CRC-32 (IEEE) over a buffer, as used by ZIP entries. */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function invalidZip(message = '备份压缩包无效或已损坏。') {
  return new NoteError('backup-invalid-zip', message)
}

function invalidArchive(message = '备份结构无法识别。') {
  return new NoteError('backup-invalid-archive', message)
}

function unsafeArchive(message = '备份包含不安全的文件路径。') {
  return new NoteError('backup-unsafe-archive', message)
}

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  return { dosDate, dosTime }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Local-time `yyyyMMdd-HHmmss`, used for export and auto-backup file names. */
export function backupStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

/** Download name for `GET /backup`. */
export function backupFileName(date = new Date()) {
  return `note-wall-backup-${backupStamp(date)}.zip`
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  throw new TypeError('ZIP entry data must be a string or Buffer')
}

function hasNonAscii(name) {
  for (let index = 0; index < name.length; index += 1) {
    if (name.charCodeAt(index) > 0x7f) return true
  }
  return false
}

/**
 * Build a ZIP archive from `{ name, data }` entries using only Node built-ins.
 *
 * Files are stored (method 0) when deflating does not shrink them and deflated
 * (method 8) otherwise. A name containing a non-ASCII character gets the UTF-8
 * flag; no data descriptors, ZIP64 records or encryption are emitted.
 */
export function buildZip(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('buildZip needs an entry array')
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const { dosDate, dosTime } = dosDateTime(now)
  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('ZIP entry must be an object')
    const name = entry.name
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('ZIP entry name is required')
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > 0xffff) throw new TypeError('ZIP entry name is too long')
    const data = asBuffer(entry.data)
    const checksum = crc32(data)
    const deflated = deflateRawSync(data, { level: 6 })
    const method = deflated.length < data.length ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE
    const payload = method === ZIP_METHOD_DEFLATE ? deflated : data
    const flags = hasNonAscii(name) ? ZIP_UTF8_FLAG : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    localChunks.push(local, nameBytes, payload)
    centralChunks.push(central, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }

  const centralStart = offset
  const central = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, central, eocd])
}

function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let position = buffer.length - 22; position >= lowest; position -= 1) {
    if (buffer.readUInt32LE(position) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(position + 20)
    if (position + 22 + commentLength === buffer.length) return position
  }
  return -1
}

function isUnsafeEntryName(name) {
  if (name.length === 0 || name.length > 255) return true
  if (name.includes('\\') || name.includes('\u0000')) return true
  if (name.startsWith('/')) return true
  if (/^[A-Za-z]:/.test(name)) return true
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  const segments = name.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return true
  return false
}

/**
 * Parse a ZIP archive defensively. Returns `{ name, data }` entries in central
 * directory order. Every structural limit is checked before an entry is
 * inflated, and the uncompressed payload is capped by the declared size plus
 * the archive-wide budget.
 */
export function readZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw invalidZip()
  const maxArchiveBytes = options.maxArchiveBytes ?? BACKUP_LIMITS.maxArchiveBytes
  const maxEntries = options.maxEntries ?? BACKUP_LIMITS.maxEntries
  const maxTotalUncompressedBytes = options.maxTotalUncompressedBytes ?? BACKUP_LIMITS.maxTotalUncompressedBytes
  if (buffer.length > maxArchiveBytes) {
    throw new NoteError('backup-too-large', '备份压缩包超过大小上限。')
  }
  if (buffer.length < 22) throw invalidZip()

  const eocd = findEocd(buffer)
  if (eocd < 0) throw invalidZip('找不到 ZIP 目录结尾记录。')

  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const entriesTotal = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
    throw invalidZip('不支持分卷 ZIP 压缩包。')
  }
  if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw invalidZip('不支持 ZIP64 压缩包。')
  }
  if (entriesTotal > maxEntries) {
    throw new NoteError('backup-too-large', '备份压缩包里的文件数量过多。')
  }
  if (centralOffset + centralSize > eocd) throw invalidZip()

  const entries = []
  const names = new Set()
  const ranges = []
  let totalUncompressed = 0
  let cursor = centralOffset

  for (let index = 0; index < entriesTotal; index += 1) {
    if (cursor + 46 > centralOffset + centralSize) throw invalidZip()
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) throw invalidZip()
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crcExpected = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const diskStart = buffer.readUInt16LE(cursor + 34)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralOffset + centralSize) throw invalidZip()

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw invalidZip('不支持加密的 ZIP 压缩包。')
    }
    if ((flags & 0x0008) !== 0) throw invalidZip('不支持带数据描述符的 ZIP 条目。')
    if ((flags & ~ZIP_ALLOWED_FLAGS) !== 0) throw invalidZip('ZIP 条目使用了不支持的标志位。')
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
      throw invalidZip('ZIP 条目使用了不支持的压缩方式。')
    }
    if (diskStart !== 0) throw invalidZip()
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw invalidZip('不支持 ZIP64 压缩包。')
    }

    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    let name
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    } catch {
      throw invalidZip('ZIP 文件名不是合法的 UTF-8。')
    }
    if (Buffer.byteLength(name, 'utf8') !== nameBytes.length) throw invalidZip()
    if (isUnsafeEntryName(name)) throw unsafeArchive('ZIP 内包含不安全的文件路径。')
    if (names.has(name)) throw invalidZip('ZIP 内包含重复的文件名。')
    names.add(name)

    const dataEnd = (() => {
      if (localOffset + 30 > centralOffset) throw invalidZip()
      if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) throw invalidZip()
      const localFlags = buffer.readUInt16LE(localOffset + 6)
      const localMethod = buffer.readUInt16LE(localOffset + 8)
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      if (localFlags !== flags || localMethod !== method) throw invalidZip()
      if (localNameLength !== nameLength) throw invalidZip()
      // Without a data descriptor the local header must agree with the central
      // directory, so our view of the bytes is exactly what Explorer will see.
      if (buffer.readUInt32LE(localOffset + 14) !== crcExpected) throw invalidZip()
      if (buffer.readUInt32LE(localOffset + 18) !== compressedSize) throw invalidZip()
      if (buffer.readUInt32LE(localOffset + 22) !== uncompressedSize) throw invalidZip()
      const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength)
      if (!localName.equals(nameBytes)) throw invalidZip()
      const start = localOffset + 30 + localNameLength + localExtraLength
      return start + compressedSize
    })()
    if (dataEnd > centralOffset) throw invalidZip()
    ranges.push({ start: localOffset, end: dataEnd })

    totalUncompressed += uncompressedSize
    if (totalUncompressed > maxTotalUncompressedBytes) {
      throw new NoteError('backup-too-large', '备份解压后的总大小超过上限。')
    }

    const dataStart = dataEnd - compressedSize
    const payload = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === ZIP_METHOD_STORE) {
      if (compressedSize !== uncompressedSize) throw invalidZip()
      data = Buffer.from(payload)
    } else {
      try {
        data = inflateRawSync(payload, { maxOutputLength: Math.max(1, uncompressedSize) })
      } catch {
        throw invalidZip('ZIP 条目解压失败。')
      }
      if (data.length !== uncompressedSize) throw invalidZip()
    }
    if (crc32(data) !== crcExpected) throw invalidZip('ZIP 条目校验和不匹配。')

    entries.push({ name, data })
    cursor = next
  }

  if (cursor !== centralOffset + centralSize) throw invalidZip()

  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw invalidZip('ZIP 条目数据范围重叠。')
  }

  // A ZIP64 EOCD record must not hide in the central directory offset area.
  if (buffer.length >= 20) {
    const locator = eocd - 20
    if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
      throw invalidZip('不支持 ZIP64 压缩包。')
    }
  }
  if (buffer.length >= 56 && buffer.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE) {
    throw invalidZip('不支持 ZIP64 压缩包。')
  }

  return entries
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonEntry(entry, label) {
  const text = entry.data.toString('utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(text)
  } catch {
    throw invalidArchive(`${label} 不是合法的 JSON。`)
  }
}

function limitEntry(entry, maxBytes, label) {
  if (entry.data.length > maxBytes) {
    throw new NoteError('backup-too-large', `${label} 超过大小上限。`)
  }
}

/**
 * Turn raw ZIP entries into the backup document, manifest, optional settings
 * and image map. Any unknown path, unsupported image or malformed JSON rejects
 * the whole archive before any wall data is touched.
 */
export function parseArchive(buffer, options = {}) {
  const wantSettings = options.wantSettings === true
  const entries = readZip(buffer, {
    maxArchiveBytes: BACKUP_LIMITS.maxArchiveBytes,
    maxEntries: BACKUP_LIMITS.maxEntries,
    maxTotalUncompressedBytes: BACKUP_LIMITS.maxTotalUncompressedBytes,
  })

  let notesEntry
  let manifestEntry
  let settingsEntry
  const images = new Map()
  for (const entry of entries) {
    if (entry.name === 'notes.json') {
      notesEntry = entry
      continue
    }
    if (entry.name === 'manifest.json') {
      manifestEntry = entry
      continue
    }
    if (entry.name === 'settings.json') {
      settingsEntry = entry
      continue
    }
    const match = /^images\/([^/]+)$/.exec(entry.name)
    if (match === null || !isImageId(match[1])) {
      throw invalidArchive(`备份里有无法识别的文件：${entry.name}`)
    }
    const id = match[1]
    if (images.has(id)) throw invalidArchive('备份里有重复的图片文件。')
    images.set(id, entry.data)
  }

  if (notesEntry === undefined) throw invalidArchive('备份缺少 notes.json。')
  if (manifestEntry === undefined) throw invalidArchive('备份缺少 manifest.json。')
  limitEntry(notesEntry, BACKUP_LIMITS.maxNotesJsonBytes, 'notes.json')
  limitEntry(manifestEntry, BACKUP_LIMITS.maxManifestBytes, 'manifest.json')

  const document = parseJsonEntry(notesEntry, 'notes.json')
  if (!isPlainObject(document)
    || document.format !== BACKUP_FORMAT
    || document.version !== BACKUP_FORMAT_VERSION
    || !Array.isArray(document.notes)
    || !Array.isArray(document.folders)) {
    throw invalidArchive('不是便签墙 v2 备份文件。')
  }

  const manifest = parseJsonEntry(manifestEntry, 'manifest.json')
  if (!isPlainObject(manifest) || manifest.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.files)) {
    throw invalidArchive('备份清单格式不正确。')
  }

  if (images.size > BACKUP_LIMITS.maxImageCount) {
    throw new NoteError('backup-too-large', `备份里的图片不能超过 ${BACKUP_LIMITS.maxImageCount} 张。`)
  }
  for (const [id, data] of images) {
    if (data.length > BACKUP_LIMITS.maxImageBytes) {
      throw new NoteError('backup-too-large', '备份里的单张图片超过 3 MB 上限。')
    }
    const sniffed = sniffImage(data)
    if (sniffed === undefined || sniffed.mediaType !== mediaTypeForImage(id)) {
      throw invalidArchive('备份里的图片内容与文件扩展名不一致。')
    }
  }

  let settings
  if (wantSettings && settingsEntry !== undefined) {
    limitEntry(settingsEntry, BACKUP_LIMITS.maxSettingsBytes, 'settings.json')
    let rawSettings
    try {
      rawSettings = parseJsonEntry(settingsEntry, 'settings.json')
    } catch {
      throw new NoteError('backup-settings-invalid', 'settings.json 不是合法的 JSON。')
    }
    try {
      settings = parseImportedSettings(rawSettings)
    } catch (error) {
      if (error instanceof NoteError) {
        throw new NoteError('backup-settings-invalid', `备份里的设置无效：${error.message}`)
      }
      throw new NoteError('backup-settings-invalid', '备份里的设置无效。')
    }
  }

  return {
    document,
    manifest,
    images,
    settings,
    hasSettings: settingsEntry !== undefined,
  }
}

function normalizeFolders(document) {
  const folders = []
  const folderIds = new Set()
  for (const raw of document.folders) {
    if (folders.length >= LIMITS.maxFolders) break
    const folder = normalizeBackupFolder(raw)
    if (folder === undefined || folderIds.has(folder.id)) continue
    folderIds.add(folder.id)
    folders.push(folder)
  }
  return { folders, folderIds }
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Normalize notes and count the ones that cannot be imported. A note whose
 * image is neither in the archive nor already in the wall is skipped and
 * counted instead of being imported without its picture.
 */
async function selectNotes(document, folderIds, images, imagesDir) {
  const notes = []
  const seen = new Set()
  let skippedNotes = 0
  for (const raw of document.notes) {
    if (notes.length >= LIMITS.maxNotes) {
      skippedNotes += 1
      continue
    }
    const note = normalizeBackupNote(raw, folderIds)
    if (note === undefined || seen.has(note.id)) {
      skippedNotes += 1
      continue
    }
    seen.add(note.id)
    if (note.image.length > 0 && !images.has(note.image)) {
      if (!(await fileExists(join(imagesDir, note.image)))) {
        skippedNotes += 1
        continue
      }
    }
    notes.push(note)
  }
  return { notes, skippedNotes }
}

async function uniqueImageId(originalId, reserved) {
  const dot = originalId.lastIndexOf('.')
  const extension = dot >= 0 ? originalId.slice(dot) : ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${randomUUID()}${extension}`
    if (reserved.has(candidate)) continue
    return candidate
  }
  throw new NoteError('backup-invalid-archive', '无法为图片分配新的标识。')
}

/**
 * Resolve every referenced image. An id whose target file exists with the same
 * bytes is reused; a collision with different bytes gets a fresh id and the
 * note is rewritten. Images that need to be written are returned as installs.
 */
async function planImages(notes, archiveImages, imagesDir) {
  const mapping = new Map()
  const installs = []
  const referenced = new Set()
  const reserved = new Set(archiveImages.keys())

  for (const note of notes) {
    if (note.image.length === 0) continue
    if (!archiveImages.has(note.image)) {
      // Kept because the same image already exists in the wall.
      referenced.add(note.image)
      continue
    }
    if (mapping.has(note.image)) {
      note.image = mapping.get(note.image)
      referenced.add(note.image)
      continue
    }
    const data = archiveImages.get(note.image)
    let targetId = note.image
    let existing
    try {
      existing = await readFile(join(imagesDir, targetId))
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw new NoteError('backup-invalid-archive', '无法读取便签墙里的图片文件。')
      }
    }
    if (existing !== undefined) {
      if (existing.equals(data)) {
        mapping.set(note.image, targetId)
        referenced.add(targetId)
        continue
      }
      targetId = await uniqueImageId(note.image, reserved)
      reserved.add(targetId)
    }
    mapping.set(note.image, targetId)
    note.image = targetId
    installs.push({ id: targetId, data })
    referenced.add(targetId)
  }
  return { installs, referenced, imageCount: mapping.size }
}

/**
 * Append imported folders by name. Existing names are reused; otherwise a new
 * folder with a fresh id is created. Returns the id map plus the records to
 * append.
 */
function planMergeFolders(folders, existingFolders) {
  const mapping = new Map()
  const newFolders = []
  const byName = new Map()
  for (const folder of existingFolders) {
    if (!byName.has(folder.name)) byName.set(folder.name, folder.id)
  }
  for (const folder of folders) {
    if (byName.has(folder.name)) {
      mapping.set(folder.id, byName.get(folder.name))
      continue
    }
    if (existingFolders.length + newFolders.length >= LIMITS.maxFolders) continue
    const record = { id: randomUUID(), name: folder.name, createdAt: folder.createdAt }
    byName.set(record.name, record.id)
    mapping.set(folder.id, record.id)
    newFolders.push(record)
  }
  return { mapping, newFolders }
}

function cloneNotesWithNewIds(notes, folderMapping) {
  return notes.map((note) => ({
    ...note,
    id: randomUUID(),
    folderId: note.folderId.length > 0 ? (folderMapping.get(note.folderId) ?? '') : '',
  }))
}

function referencedImageIds(notes) {
  const ids = new Set()
  for (const note of notes) {
    if (note.image.length > 0) ids.add(note.image)
  }
  return ids
}

export class BackupService {
  constructor({ store, settingsStore, dataDir, imagesDir, logger = console, now = () => Date.now() }) {
    if (store === undefined || settingsStore === undefined) {
      throw new TypeError('BackupService needs a note store and a settings store')
    }
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('BackupService needs a data directory')
    this.store = store
    this.settingsStore = settingsStore
    this.dataDir = dataDir
    this.imagesDir = typeof imagesDir === 'string' && imagesDir.length > 0 ? imagesDir : join(dataDir, 'images')
    this.backupsDir = join(dataDir, 'backups')
    this.logger = logger
    this.now = now
  }

  /** Build the current wall as a ZIP archive (used by GET and the safety copy). */
  async exportArchive(options = {}) {
    const includeSettings = options.includeSettings !== false
    const now = new Date(this.now())
    const notes = this.store.list()
    const folders = this.store.listFolders()
    const seen = new Set()
    const imageEntries = []
    const missingImages = []
    for (const note of notes) {
      if (note.image.length === 0 || seen.has(note.image)) continue
      seen.add(note.image)
      try {
        const data = await readFile(join(this.imagesDir, note.image))
        imageEntries.push({ name: `images/${note.image}`, data })
      } catch (error) {
        if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
          this.logger.warn?.('[note-wall] 无法读取导出图片', error)
        }
        missingImages.push(note.image)
      }
    }

    const exportedAt = now.toISOString()
    const document = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      exportedAt,
      notes,
      folders,
    }
    const notesData = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const settingsData = includeSettings
      ? Buffer.from(`${JSON.stringify(this.settingsStore.get(), null, 2)}\n`, 'utf8')
      : undefined

    const files = [{ path: 'notes.json', bytes: notesData.length }]
    for (const image of imageEntries) files.push({ path: image.name, bytes: image.data.length })
    if (settingsData !== undefined) files.push({ path: 'settings.json', bytes: settingsData.length })
    // Sum of the payload files; the manifest itself is not measurable before
    // it is written, so it is not part of totalBytes or files.
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const manifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: exportedAt,
      noteCount: notes.length,
      folderCount: folders.length,
      imageCount: imageEntries.length,
      settingsIncluded: settingsData !== undefined,
      totalBytes,
      files,
      missingImages,
    }
    const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const entries = [{ name: 'notes.json', data: notesData }, ...imageEntries]
    if (settingsData !== undefined) entries.push({ name: 'settings.json', data: settingsData })
    entries.push({ name: 'manifest.json', data: manifestData })

    return { buffer: buildZip(entries, { now }), filename: backupFileName(now), manifest, document }
  }

  async listImageFileNames() {
    try {
      return await readdir(this.imagesDir)
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
        this.logger.warn?.('[note-wall] 无法读取图片目录', error)
      }
      return []
    }
  }

  async installImages(installs) {
    const created = []
    if (installs.length === 0) return created
    try {
      await mkdir(this.imagesDir, { recursive: true })
      for (const item of installs) {
        const target = join(this.imagesDir, item.id)
        const temp = join(this.imagesDir, `.import-${process.pid}-${randomUUID()}.tmp`)
        try {
          await writeFile(temp, item.data)
          await rename(temp, target)
        } catch (error) {
          try {
            await unlink(temp)
          } catch {
            // Best-effort temp cleanup; the original error matters.
          }
          throw error
        }
        created.push(item.id)
      }
      return created
    } catch (error) {
      await this.removeCreatedImages(created, new Set())
      throw error
    }
  }

  /** Remove only files this import created; never an image the wall still uses. */
  async removeCreatedImages(ids, keep) {
    for (const id of ids) {
      if (keep.has(id)) continue
      try {
        await unlink(join(this.imagesDir, id))
      } catch (error) {
        if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
          this.logger.warn?.('[note-wall] 无法清理导入图片', error)
        }
      }
    }
  }

  async removeOldImages(oldNames, keep) {
    for (const name of oldNames) {
      if (!isImageId(name) || keep.has(name)) continue
      try {
        await unlink(join(this.imagesDir, name))
      } catch (error) {
        if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
          this.logger.warn?.('[note-wall] 无法清理旧图片', error)
        }
      }
    }
  }

  /** Write a ZIP of the current wall before a replace. Failure aborts the import. */
  async createSafetyBackup() {
    try {
      const archive = await this.exportArchive({ includeSettings: true })
      await mkdir(this.backupsDir, { recursive: true })
      const base = `note-wall-auto-${backupStamp(new Date(this.now()))}`
      let filename = `${base}.zip`
      let counter = 0
      while (await fileExists(join(this.backupsDir, filename))) {
        counter += 1
        filename = `${base}-${counter}.zip`
      }
      const target = join(this.backupsDir, filename)
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, archive.buffer)
        await rename(temp, target)
      } catch (error) {
        try {
          await unlink(temp)
        } catch {
          // Best-effort temp cleanup; the original error matters.
        }
        throw error
      }
      return filename
    } catch (error) {
      this.logger.error?.('[note-wall] 自动备份失败', error)
      throw new NoteError('backup-safety-failed', '导入前的自动备份失败，已取消导入。')
    }
  }

  async rollbackSettings(previous) {
    try {
      await this.settingsStore.update(previous)
    } catch (error) {
      this.logger.error?.('[note-wall] 导入失败后无法恢复设置', error)
    }
  }

  async applySettings(settings) {
    try {
      await this.settingsStore.update(settings)
    } catch (error) {
      this.logger.error?.('[note-wall] 无法写入导入的设置', error)
      throw new NoteError('backup-settings-failed', '备份里的设置无法写入，已取消导入。')
    }
  }

  async replaceWall(parsed, settingsPlan, previousSettings) {
    const { folders, folderIds } = normalizeFolders(parsed.document)
    const selected = await selectNotes(parsed.document, folderIds, parsed.images, this.imagesDir)
    const notes = selected.notes
    const planned = await planImages(notes, parsed.images, this.imagesDir)
    const { installs, referenced } = planned

    const oldNotes = this.store.list()
    const oldImages = referencedImageIds(oldNotes)
    const oldImageNames = await this.listImageFileNames()
    const safetyBackup = await this.createSafetyBackup()

    let created = []
    let settingsApplied = false
    try {
      created = await this.installImages(installs)
      if (settingsPlan !== undefined) {
        await this.applySettings(settingsPlan)
        settingsApplied = true
      }
      let result
      try {
        result = await this.store.replaceAll({ notes, folders })
      } catch (error) {
        if (settingsApplied) await this.rollbackSettings(previousSettings)
        throw error
      }
      await this.removeOldImages(oldImageNames, referenced)
      return {
        mode: 'replace',
        importedNotes: result.notes,
        skippedNotes: selected.skippedNotes,
        importedFolders: result.folders,
        imageCount: planned.imageCount,
        settingsIncluded: parsed.hasSettings,
        settingsApplied,
        safetyBackup,
      }
    } catch (error) {
      await this.removeCreatedImages(created, oldImages)
      throw error
    }
  }

  async mergeWall(parsed, settingsPlan, previousSettings) {
    const { folders, folderIds } = normalizeFolders(parsed.document)
    const selected = await selectNotes(parsed.document, folderIds, parsed.images, this.imagesDir)
    const { installs, imageCount } = await planImages(selected.notes, parsed.images, this.imagesDir)

    const existingFolders = this.store.listFolders()
    const { mapping, newFolders } = planMergeFolders(folders, existingFolders)
    const mergeNotes = cloneNotesWithNewIds(selected.notes, mapping)
    const oldImages = referencedImageIds(this.store.list())

    let created = []
    let settingsApplied = false
    try {
      created = await this.installImages(installs)
      if (settingsPlan !== undefined) {
        await this.applySettings(settingsPlan)
        settingsApplied = true
      }
      let result
      try {
        result = await this.store.mergeSnapshot({ notes: mergeNotes, folders: newFolders })
      } catch (error) {
        if (settingsApplied) await this.rollbackSettings(previousSettings)
        throw error
      }
      await this.removeCreatedImages(created, referencedImageIds(this.store.list()))
      return {
        mode: 'merge',
        importedNotes: result.importedNotes,
        skippedNotes: selected.skippedNotes + result.skippedNotes,
        importedFolders: result.importedFolders,
        imageCount,
        settingsIncluded: parsed.hasSettings,
        settingsApplied,
        safetyBackup: null,
      }
    } catch (error) {
      await this.removeCreatedImages(created, oldImages)
      throw error
    }
  }

  /**
   * Import a ZIP archive. `applySettings` may be `true`, `false` or undefined
   * (undefined means "apply for replace, never for merge"). The archive is
   * parsed and validated completely before the wall is touched.
   */
  async importArchive(buffer, options = {}) {
    const mode = options.mode
    if (mode !== 'replace' && mode !== 'merge') {
      throw new NoteError('backup-mode-invalid', '导入模式必须是 replace 或 merge。')
    }
    const applySettings = options.applySettings === undefined ? mode === 'replace' : options.applySettings === true
    const previousSettings = this.settingsStore.get()
    const parsed = parseArchive(buffer, { wantSettings: applySettings })
    const settingsPlan = applySettings ? parsed.settings : undefined
    if (mode === 'replace') return this.replaceWall(parsed, settingsPlan, previousSettings)
    return this.mergeWall(parsed, settingsPlan, previousSettings)
  }
}
