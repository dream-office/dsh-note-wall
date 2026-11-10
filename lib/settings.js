// dsh-note-wall — Host-side settings store.
//
// Settings live in their own JSON file beside the note store, so a corrupt
// settings file never costs a note. Every field has a default and the document
// is normalized on load: an unknown or malformed value falls back to its own
// default instead of rejecting the whole file, and an unsupported version falls
// back to the full defaults. Writes use the same atomic temp + rename style as
// the note store and are serialized through one queue with rollback, so a
// failed write never leaves the in-memory settings ahead of the file.
//
// `agentWrite.enabled` is a real Host-side gate: `note_wall_add` refuses to
// write unless the user turned it on, so the default install cannot write notes
// from an agent.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NoteError } from './store.js'

/** Settings file format version written by this build. */
export const SETTINGS_VERSION = 1

/** Allowed image display modes; 'thumbnail' is the v1.2.0 default. */
export const IMAGE_DISPLAY_MODES = Object.freeze(['large', 'thumbnail', 'icon'])

/** Allowed alarm presentation modes; 'silent' never shows anything. */
export const GLOBAL_ALARM_MODES = Object.freeze(['overlay', 'banner', 'silent'])

/** Bounds enforced for numeric settings. */
export const SETTINGS_LIMITS = Object.freeze({
  minCategoryHistoryLimit: 1,
  maxCategoryHistoryLimit: 50,
  minVolume: 0,
  maxVolume: 1,
})

/** Defaults for every settings field; `agentWrite` starts disabled. */
export const DEFAULT_SETTINGS = Object.freeze({
  agentWrite: Object.freeze({ enabled: false }),
  categoryHistory: Object.freeze({ enabled: false, limit: 8 }),
  folders: Object.freeze({ enabled: false }),
  imageDisplay: 'thumbnail',
  reminders: Object.freeze({
    enabled: false,
    sound: false,
    volume: 0.7,
    notifications: false,
    overdue: true,
  }),
  globalAlarm: Object.freeze({ enabled: false, mode: 'overlay', sound: false }),
  motion: true,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultSettings() {
  return {
    agentWrite: { ...DEFAULT_SETTINGS.agentWrite },
    categoryHistory: { ...DEFAULT_SETTINGS.categoryHistory },
    folders: { ...DEFAULT_SETTINGS.folders },
    imageDisplay: DEFAULT_SETTINGS.imageDisplay,
    reminders: { ...DEFAULT_SETTINGS.reminders },
    globalAlarm: { ...DEFAULT_SETTINGS.globalAlarm },
    motion: DEFAULT_SETTINGS.motion,
  }
}

function cloneSettings(settings) {
  return {
    agentWrite: { ...settings.agentWrite },
    categoryHistory: { ...settings.categoryHistory },
    folders: { ...settings.folders },
    imageDisplay: settings.imageDisplay,
    reminders: { ...settings.reminders },
    globalAlarm: { ...settings.globalAlarm },
    motion: settings.motion,
  }
}

function toIso(ms) {
  return new Date(ms).toISOString()
}

// --- Load-time normalization (tolerant: bad fields fall back, never throw) ---

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function readEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

function readIntegerInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function readNumberInRange(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

/** Rebuild a settings document from storage, defaulting every malformed field. */
function normalizeStoredSettings(raw) {
  const settings = defaultSettings()
  if (!isPlainObject(raw)) return settings

  const agentWrite = isPlainObject(raw.agentWrite) ? raw.agentWrite : {}
  settings.agentWrite.enabled = readBoolean(agentWrite.enabled, settings.agentWrite.enabled)

  const categoryHistory = isPlainObject(raw.categoryHistory) ? raw.categoryHistory : {}
  settings.categoryHistory.enabled = readBoolean(categoryHistory.enabled, settings.categoryHistory.enabled)
  settings.categoryHistory.limit = readIntegerInRange(
    categoryHistory.limit,
    SETTINGS_LIMITS.minCategoryHistoryLimit,
    SETTINGS_LIMITS.maxCategoryHistoryLimit,
    settings.categoryHistory.limit,
  )

  const folders = isPlainObject(raw.folders) ? raw.folders : {}
  settings.folders.enabled = readBoolean(folders.enabled, settings.folders.enabled)

  settings.imageDisplay = readEnum(raw.imageDisplay, IMAGE_DISPLAY_MODES, settings.imageDisplay)

  const reminders = isPlainObject(raw.reminders) ? raw.reminders : {}
  settings.reminders.enabled = readBoolean(reminders.enabled, settings.reminders.enabled)
  settings.reminders.sound = readBoolean(reminders.sound, settings.reminders.sound)
  settings.reminders.volume = readNumberInRange(
    reminders.volume,
    SETTINGS_LIMITS.minVolume,
    SETTINGS_LIMITS.maxVolume,
    settings.reminders.volume,
  )
  settings.reminders.notifications = readBoolean(reminders.notifications, settings.reminders.notifications)
  settings.reminders.overdue = readBoolean(reminders.overdue, settings.reminders.overdue)

  const globalAlarm = isPlainObject(raw.globalAlarm) ? raw.globalAlarm : {}
  settings.globalAlarm.enabled = readBoolean(globalAlarm.enabled, settings.globalAlarm.enabled)
  settings.globalAlarm.mode = readEnum(globalAlarm.mode, GLOBAL_ALARM_MODES, settings.globalAlarm.mode)
  settings.globalAlarm.sound = readBoolean(globalAlarm.sound, settings.globalAlarm.sound)

  settings.motion = readBoolean(raw.motion, settings.motion)
  return settings
}

// --- Update-time validation (strict: bad input is a coded error) ------------

function invalidValue(field) {
  return new NoteError('settings-value-invalid', `设置项 ${field} 的值无效。`)
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw invalidValue(field)
  return value
}

function requireEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalidValue(field)
  return value
}

function requireIntegerInRange(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalidValue(field)
  return value
}

function requireNumberInRange(value, min, max, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalidValue(field)
  }
  return value
}

function readGroup(patch, key) {
  const value = patch[key]
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw invalidValue(key)
  return value
}

/**
 * Merge one request patch into a cloned settings object. Unknown keys and a
 * `version` field are ignored so an older Host tolerates a newer caller, while
 * every known field is validated strictly.
 */
function applySettingsPatch(target, patch) {
  if (!isPlainObject(patch)) throw new NoteError('settings-invalid', '设置必须是 JSON 对象。')

  const agentWrite = readGroup(patch, 'agentWrite')
  if (agentWrite !== undefined && agentWrite.enabled !== undefined) {
    target.agentWrite.enabled = requireBoolean(agentWrite.enabled, 'agentWrite.enabled')
  }

  const categoryHistory = readGroup(patch, 'categoryHistory')
  if (categoryHistory !== undefined) {
    if (categoryHistory.enabled !== undefined) {
      target.categoryHistory.enabled = requireBoolean(categoryHistory.enabled, 'categoryHistory.enabled')
    }
    if (categoryHistory.limit !== undefined) {
      target.categoryHistory.limit = requireIntegerInRange(
        categoryHistory.limit,
        SETTINGS_LIMITS.minCategoryHistoryLimit,
        SETTINGS_LIMITS.maxCategoryHistoryLimit,
        'categoryHistory.limit',
      )
    }
  }

  const folders = readGroup(patch, 'folders')
  if (folders !== undefined && folders.enabled !== undefined) {
    target.folders.enabled = requireBoolean(folders.enabled, 'folders.enabled')
  }

  if (patch.imageDisplay !== undefined) {
    target.imageDisplay = requireEnum(patch.imageDisplay, IMAGE_DISPLAY_MODES, 'imageDisplay')
  }

  const reminders = readGroup(patch, 'reminders')
  if (reminders !== undefined) {
    if (reminders.enabled !== undefined) target.reminders.enabled = requireBoolean(reminders.enabled, 'reminders.enabled')
    if (reminders.sound !== undefined) target.reminders.sound = requireBoolean(reminders.sound, 'reminders.sound')
    if (reminders.volume !== undefined) {
      target.reminders.volume = requireNumberInRange(
        reminders.volume,
        SETTINGS_LIMITS.minVolume,
        SETTINGS_LIMITS.maxVolume,
        'reminders.volume',
      )
    }
    if (reminders.notifications !== undefined) {
      target.reminders.notifications = requireBoolean(reminders.notifications, 'reminders.notifications')
    }
    if (reminders.overdue !== undefined) target.reminders.overdue = requireBoolean(reminders.overdue, 'reminders.overdue')
  }

  const globalAlarm = readGroup(patch, 'globalAlarm')
  if (globalAlarm !== undefined) {
    if (globalAlarm.enabled !== undefined) target.globalAlarm.enabled = requireBoolean(globalAlarm.enabled, 'globalAlarm.enabled')
    if (globalAlarm.mode !== undefined) target.globalAlarm.mode = requireEnum(globalAlarm.mode, GLOBAL_ALARM_MODES, 'globalAlarm.mode')
    if (globalAlarm.sound !== undefined) target.globalAlarm.sound = requireBoolean(globalAlarm.sound, 'globalAlarm.sound')
  }

  if (patch.motion !== undefined) target.motion = requireBoolean(patch.motion, 'motion')
}

function sameSettings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class SettingsStore {
  constructor({ dir, logger = console, now = () => Date.now() }) {
    if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('SettingsStore needs a directory')
    this.dir = dir
    this.file = join(dir, 'settings.json')
    this.logger = logger
    this.now = now
    this.settings = defaultSettings()
    this.loaded = false
    this.mutationQueue = Promise.resolve()
  }

  /**
   * Read settings from disk. A missing file means the defaults and is not
   * created until the first update; an unreadable or corrupt file also means
   * the defaults, and a corrupt file is preserved next to the store.
   */
  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.settings = defaultSettings()
        this.loaded = true
        return this.get()
      }
      // Settings are not worth failing the plugin for: keep defaults and let a
      // real write error surface on the next update.
      this.logger.warn?.('[note-wall] 无法读取便签墙设置，使用默认值', error)
      this.settings = defaultSettings()
      this.loaded = true
      return this.get()
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!isPlainObject(parsed)) {
      this.logger.warn?.('[note-wall] 便签墙设置无法识别，将保留原文件并使用默认值')
      await this.quarantine()
      this.settings = defaultSettings()
      this.loaded = true
      return this.get()
    }
    if (parsed.version !== undefined && parsed.version !== SETTINGS_VERSION) {
      // A file written by an unknown build: keep it untouched and use the
      // defaults rather than guessing at a future schema.
      this.logger.warn?.('[note-wall] 便签墙设置版本不受支持，使用默认值')
      this.settings = defaultSettings()
      this.loaded = true
      return this.get()
    }

    this.settings = normalizeStoredSettings(parsed)
    this.loaded = true
    return this.get()
  }

  /** Keep an unrecognized settings file next to the store instead of deleting it. */
  async quarantine() {
    const stamp = toIso(this.now()).replace(/[:.]/g, '-')
    const target = join(this.dir, `settings.corrupt-${stamp}.json`)
    try {
      await rename(this.file, target)
      this.logger.warn?.(`[note-wall] 无法识别的便签墙设置已改名保留：${target}`)
      return true
    } catch (error) {
      this.logger.error?.('[note-wall] 无法保留无法识别的便签墙设置', error)
      return false
    }
  }

  /** Detached copy of the current settings, including the format version. */
  get() {
    return { version: SETTINGS_VERSION, ...cloneSettings(this.settings) }
  }

  /** Serialize one mutation: mutate, write, and roll back on a write failure. */
  enqueue(task) {
    const run = this.mutationQueue.catch(() => {}).then(task)
    this.mutationQueue = run
    return run
  }

  /** Merge a partial patch, persist it, and return the normalized settings. */
  async update(patch) {
    return this.enqueue(async () => {
      const next = cloneSettings(this.settings)
      applySettingsPatch(next, patch)
      if (sameSettings(next, this.settings)) return this.get()
      const previous = this.settings
      this.settings = next
      try {
        await this.writeSnapshot()
      } catch (error) {
        this.settings = previous
        throw error
      }
      return this.get()
    })
  }

  /** Restore every default and persist the reset document. */
  async reset() {
    return this.enqueue(async () => {
      const previous = this.settings
      this.settings = defaultSettings()
      try {
        await this.writeSnapshot()
      } catch (error) {
        this.settings = previous
        throw error
      }
      return this.get()
    })
  }

  /** Atomic write: a per-call temp file, then a rename over the settings file. */
  async writeSnapshot() {
    await mkdir(this.dir, { recursive: true })
    const snapshot = { version: SETTINGS_VERSION, ...cloneSettings(this.settings) }
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
      this.logger.error?.('[note-wall] 便签墙设置保存失败', error)
    }
  }
}
