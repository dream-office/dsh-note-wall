window.__ModuleLoader__.load({
  id: 'dsh-note-wall',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // dsh-note-wall — browser half, hand-written module-loader client.
    //
    // Registers two shell surfaces:
    //   sidebar.panellist  id  note-wall  — sticky-note glyph that opens the wall
    //   main               key note-wall  — the note wall page
    //
    // All traffic goes to the plugin's own same-origin route. No bundler, no JSX,
    // no client package imports; chrome colors come from --dsw-alias-* tokens,
    // while the pastel note fills are the plugin's own artwork.

    const API_PATH = '/plugins/dsh-note-wall/api'
    const IMAGE_UPLOAD_PATH = '/plugins/dsh-note-wall/image'
    const IMAGE_PATH_PREFIX = '/plugins/dsh-note-wall/image/'
    const API_HEADERS = { 'content-type': 'application/json', 'x-dsh-note-wall': '1' }
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    // Used until the host reports its own limits in `state`.
    const DEFAULT_LIMITS = {
      maxNotes: 500,
      maxNoteChars: 500,
      maxTagChars: 24,
      maxLinkChars: 2048,
      maxImageBytes: 3 * 1024 * 1024,
      maxFolders: 100,
      maxFolderNameChars: 40,
    }
    const CLOCK_INTERVAL_MS = 30000

    // v1.2.0 client defaults mirror lib/settings.js. Every optional feature is
    // off except the compact thumbnail display, which is the user preference;
    // the panel lets the user opt into the rest explicitly.
    const DEFAULT_CLIENT_SETTINGS = {
      agentWrite: { enabled: false },
      categoryHistory: { enabled: false, limit: 8 },
      folders: { enabled: false },
      imageDisplay: 'thumbnail',
      reminders: { enabled: false, sound: false, volume: 0.7, notifications: false, overdue: true },
      globalAlarm: { enabled: false, mode: 'overlay', sound: false },
      motion: true,
    }
    const IMAGE_DISPLAY_MODES = ['thumbnail', 'icon', 'large']
    const GLOBAL_ALARM_MODES = ['overlay', 'banner', 'silent']
    const CATEGORY_HISTORY_KEY = 'dsh-note-wall:categories-v1'
    const SETTINGS_EVENT = 'dsh-note-wall:settings'
    const NOTES_EVENT = 'dsh-note-wall:notes-changed'
    const SETTINGS_PANEL_ID = 'nw-settings-panel'
    const REMINDER_OVERLAY_ID = 'note-wall-reminders'
    const REMINDER_INTERVAL_MS = 30000

    // A-version signature (see DESIGN-SIGNATURE.md): footer mark + console line
    // + a three-tap author note. No storage, no network, no data collection.
    const SIGNATURE_CLICK_COUNT = 3
    const SIGNATURE_CLICK_WINDOW_MS = 2000
    const SIGNATURE_PANEL_ID = 'nw-signature-note'
    const SIGNATURE_QUOTE_ZH = '把灵感，一张一张贴起来。'
    const SIGNATURE_QUOTE_EN = 'Pinning down inspiration, one note at a time.'
    const SIGNATURE_CONSOLE_TEXT = 'dsh-note-wall · dream-office · 把灵感，一张一张贴起来'

    const TONES = [
      { key: 'amber', zh: '暖黄', en: 'Amber' },
      { key: 'peach', zh: '蜜桃', en: 'Peach' },
      { key: 'sky', zh: '天蓝', en: 'Sky' },
      { key: 'mint', zh: '薄荷', en: 'Mint' },
      { key: 'lilac', zh: '丁香', en: 'Lilac' },
      { key: 'cream', zh: '奶油', en: 'Cream' },
    ]
    const TONE_KEYS = TONES.map(function (definition) { return definition.key })
    const HEX_TONE = /^#[0-9a-f]{6}$/i
    const PREFS_KEY = 'dsh-note-wall:prefs-v1'
    const DEFAULT_TONE = 'amber'

    function isPresetTone(tone) {
      return TONE_KEYS.indexOf(tone) >= 0
    }

    function isCustomTone(tone) {
      return typeof tone === 'string' && HEX_TONE.test(tone)
    }

    function isValidTone(tone) {
      return isPresetTone(tone) || isCustomTone(tone)
    }

    function toneClass(tone) {
      if (isPresetTone(tone)) return ' nw-tone-' + tone
      if (isCustomTone(tone)) return ' nw-tone-custom'
      return ''
    }

    function toneStyle(tone) {
      return isCustomTone(tone) ? { '--nw-accent': tone } : undefined
    }

    function readPrefs() {
      const fallback = { motion: true, tone: DEFAULT_TONE }
      try {
        if (typeof localStorage === 'undefined') return fallback
        const raw = localStorage.getItem(PREFS_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return {
          motion: !parsed || parsed.motion !== false,
          tone: parsed && isValidTone(parsed.tone) ? String(parsed.tone).toLowerCase() : DEFAULT_TONE,
        }
      } catch (error) {
        return fallback
      }
    }

    function writePrefs(next) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch (error) {
        // Preference persistence is optional; the page still works without it.
      }
    }

    // ---------------------------------------------------------------------------
    // Pure note helpers (search/filter/import/export; tested through the hook)
    // ---------------------------------------------------------------------------

    function normalizeQuery(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : ''
    }

    function noteMatchesQuery(note, query) {
      const term = normalizeQuery(query)
      if (term.length === 0) return true
      const haystack = [note && note.text, note && note.tag, note && note.link]
        .filter(function (value) { return typeof value === 'string' })
        .join('\n')
        .toLowerCase()
      return haystack.indexOf(term) >= 0
    }

    function noteMatchesFilter(note, filters) {
      const options = filters || {}
      if (!noteMatchesQuery(note, options.query)) return false
      if (options.tone && options.tone !== 'all') {
        if (options.tone === 'custom') {
          if (!isCustomTone(note && note.tone)) return false
        } else if (!note || note.tone !== options.tone) {
          return false
        }
      }
      if (options.tag && options.tag !== 'all' && (!note || note.tag !== options.tag)) return false
      if (options.folderId !== undefined && options.folderId !== 'all') {
        const folderId = note && typeof note.folderId === 'string' ? note.folderId : ''
        if (folderId !== options.folderId) return false
      }
      return true
    }

    function filterNotes(notes, filters) {
      return (Array.isArray(notes) ? notes : []).filter(function (note) {
        return noteMatchesFilter(note, filters)
      })
    }

    function cloneSettingsDocument(settings) {
      return JSON.parse(JSON.stringify(settings !== null && typeof settings === 'object' ? settings : DEFAULT_CLIENT_SETTINGS))
    }

    function readBooleanSetting(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function readEnumSetting(value, allowed, fallback) {
      return typeof value === 'string' && allowed.indexOf(value) >= 0 ? value : fallback
    }

    function readNumberSetting(value, min, max, fallback) {
      return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
    }

    function readIntegerSetting(value, min, max, fallback) {
      return Number.isInteger(value) && value >= min && value <= max ? value : fallback
    }

    /** Tolerant client-side view of the Host settings document. */
    function normalizeClientSettings(raw) {
      const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const base = cloneSettingsDocument(DEFAULT_CLIENT_SETTINGS)
      const sourceGroup = function (key) {
        const value = source[key]
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      }
      const agentWrite = sourceGroup('agentWrite')
      base.agentWrite.enabled = readBooleanSetting(agentWrite.enabled, base.agentWrite.enabled)

      const categoryHistory = sourceGroup('categoryHistory')
      base.categoryHistory.enabled = readBooleanSetting(categoryHistory.enabled, base.categoryHistory.enabled)
      base.categoryHistory.limit = readIntegerSetting(categoryHistory.limit, 1, 50, base.categoryHistory.limit)

      const folders = sourceGroup('folders')
      base.folders.enabled = readBooleanSetting(folders.enabled, base.folders.enabled)

      base.imageDisplay = readEnumSetting(source.imageDisplay, IMAGE_DISPLAY_MODES, base.imageDisplay)

      const reminders = sourceGroup('reminders')
      base.reminders.enabled = readBooleanSetting(reminders.enabled, base.reminders.enabled)
      base.reminders.sound = readBooleanSetting(reminders.sound, base.reminders.sound)
      base.reminders.volume = readNumberSetting(reminders.volume, 0, 1, base.reminders.volume)
      base.reminders.notifications = readBooleanSetting(reminders.notifications, base.reminders.notifications)
      base.reminders.overdue = readBooleanSetting(reminders.overdue, base.reminders.overdue)

      const globalAlarm = sourceGroup('globalAlarm')
      base.globalAlarm.enabled = readBooleanSetting(globalAlarm.enabled, base.globalAlarm.enabled)
      base.globalAlarm.mode = readEnumSetting(globalAlarm.mode, GLOBAL_ALARM_MODES, base.globalAlarm.mode)
      base.globalAlarm.sound = readBooleanSetting(globalAlarm.sound, base.globalAlarm.sound)

      base.motion = readBooleanSetting(source.motion, base.motion)
      return base
    }

    /** A settings sub-document is enabled only when it explicitly says so. */
    function featureEnabled(settings, key) {
      if (settings === null || typeof settings !== 'object') return false
      const group = settings[key]
      return group !== null && typeof group === 'object' && group.enabled === true
    }

    function resolveImageDisplay(value) {
      if (typeof value === 'string') {
        return IMAGE_DISPLAY_MODES.indexOf(value) >= 0 ? value : DEFAULT_CLIENT_SETTINGS.imageDisplay
      }
      const settings = value !== null && typeof value === 'object' ? value : {}
      return readEnumSetting(settings.imageDisplay, IMAGE_DISPLAY_MODES, DEFAULT_CLIENT_SETTINGS.imageDisplay)
    }

    /**
     * Folder filter options in display order: all / uncategorized ('') / each
     * folder. Kept pure so the page and the tests agree on the exact list.
     */
    function normalizeFolders(list) {
      const folders = []
      for (const folder of Array.isArray(list) ? list : []) {
        if (folder === null || typeof folder !== 'object') continue
        if (typeof folder.id !== 'string' || folder.id.length === 0) continue
        if (typeof folder.name !== 'string' || folder.name.length === 0) continue
        if (folders.some(function (item) { return item.id === folder.id })) continue
        folders.push({ id: folder.id, name: folder.name })
      }
      return folders
    }

    function folderFilterOptions(folders) {
      return [{ id: 'all' }, { id: '' }].concat(normalizeFolders(folders))
    }

    function padTwo(value) {
      return value < 10 ? '0' + value : String(value)
    }

    /** ISO timestamp -> the `YYYY-MM-DDTHH:mm` local value a datetime-local wants. */
    function toLocalDateTimeInput(iso) {
      if (typeof iso !== 'string' || iso.trim().length === 0) return ''
      const ms = Date.parse(iso)
      if (!Number.isFinite(ms)) return ''
      const date = new Date(ms)
      return date.getFullYear()
        + '-' + padTwo(date.getMonth() + 1)
        + '-' + padTwo(date.getDate())
        + 'T' + padTwo(date.getHours())
        + ':' + padTwo(date.getMinutes())
    }

    const LOCAL_DATE_TIME_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

    /** `YYYY-MM-DDTHH:mm` local value -> normalized ISO; '' means no reminder. */
    function fromLocalDateTimeInput(value) {
      if (typeof value !== 'string') return ''
      const text = value.trim()
      if (text.length === 0) return ''
      const match = LOCAL_DATE_TIME_INPUT.exec(text)
      if (match === null) return ''
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const hour = Number(match[4])
      const minute = Number(match[5])
      const second = match[6] === undefined ? 0 : Number(match[6])
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return ''
      const date = new Date(year, month - 1, day, hour, minute, second, 0)
      // Reject values the Date constructor would silently roll over (Feb 30).
      if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
        || date.getHours() !== hour
        || date.getMinutes() !== minute
      ) {
        return ''
      }
      return date.toISOString()
    }

    function isReminderDue(note, nowMs) {
      if (note === null || typeof note !== 'object') return false
      if (typeof note.remindAt !== 'string' || note.remindAt.length === 0) return false
      const dueMs = Date.parse(note.remindAt)
      const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
      return Number.isFinite(dueMs) && dueMs <= now
    }

    /** Global reminder UI is armed only when both features say so and mode !== silent. */
    function globalAlarmActive(settings) {
      if (!featureEnabled(settings, 'reminders')) return false
      if (!featureEnabled(settings, 'globalAlarm')) return false
      return readEnumSetting(settings.globalAlarm.mode, GLOBAL_ALARM_MODES, 'overlay') !== 'silent'
    }

    function shouldNotifyReminder(settings) {
      if (!globalAlarmActive(settings)) return false
      return settings.reminders.notifications === true
    }

    function shouldPlayReminderSound(settings) {
      if (!globalAlarmActive(settings)) return false
      return settings.reminders.sound === true
    }

    function categoryHistorySize(limit) {
      return readIntegerSetting(limit, 1, 50, DEFAULT_CLIENT_SETTINGS.categoryHistory.limit)
    }

    /** Move a tag to the front, dedupe, trim; an empty tag only trims the list. */
    function nextCategoryHistory(list, tag, limit) {
      const size = categoryHistorySize(limit)
      const value = typeof tag === 'string' ? tag.trim() : ''
      const next = []
      if (value.length > 0) next.push(value)
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item !== 'string') continue
        const candidate = item.trim()
        if (candidate.length === 0 || candidate === value || next.indexOf(candidate) >= 0) continue
        next.push(candidate)
        if (next.length >= size) break
      }
      return next.slice(0, size)
    }

    function readCategoryHistory() {
      try {
        if (typeof localStorage === 'undefined') return []
        const raw = localStorage.getItem(CATEGORY_HISTORY_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const history = []
        for (const item of parsed) {
          if (typeof item !== 'string') continue
          const value = item.trim()
          if (value.length === 0 || history.indexOf(value) >= 0) continue
          history.push(value)
          if (history.length >= 50) break
        }
        return history
      } catch (error) {
        return []
      }
    }

    function writeCategoryHistory(list) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(CATEGORY_HISTORY_KEY, JSON.stringify(Array.isArray(list) ? list : []))
      } catch (error) {
        // The history is a convenience; failing to persist it never breaks a note.
      }
    }

    /**
     * Build the flat/nested Host patch for a settings dialog draft. Only fields
     * that actually differ are sent, and unknown hosts fields stay untouched.
     */
    function settingsPatch(current, draft) {
      const before = current !== null && typeof current === 'object' ? current : DEFAULT_CLIENT_SETTINGS
      const after = draft !== null && typeof draft === 'object' ? draft : DEFAULT_CLIENT_SETTINGS
      const patch = {}
      for (const group of ['agentWrite', 'categoryHistory', 'folders', 'reminders', 'globalAlarm']) {
        const beforeGroup = before[group] !== null && typeof before[group] === 'object' ? before[group] : {}
        const afterGroup = after[group] !== null && typeof after[group] === 'object' ? after[group] : {}
        let groupPatch
        for (const field of Object.keys(afterGroup)) {
          if (afterGroup[field] === beforeGroup[field]) continue
          if (groupPatch === undefined) groupPatch = {}
          groupPatch[field] = afterGroup[field]
        }
        if (groupPatch !== undefined) patch[group] = groupPatch
      }
      if (after.imageDisplay !== before.imageDisplay) patch.imageDisplay = after.imageDisplay
      if ((after.motion === true) !== (before.motion === true)) patch.motion = after.motion === true
      return patch
    }

    function reminderKey(note) {
      if (note === null || typeof note !== 'object') return ''
      return String(note.id) + '@' + String(note.remindAt)
    }

    function notificationPermissionState() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        return typeof Notification.permission === 'string' ? Notification.permission : 'default'
      } catch (error) {
        return 'unsupported'
      }
    }

    /** Must run synchronously inside a user gesture; never called on page load. */
    function requestNotificationPermission() {
      try {
        if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return
        if (Notification.permission !== 'default') return
        const result = Notification.requestPermission()
        if (result && typeof result.catch === 'function') result.catch(function () {})
      } catch (error) {
        // Denied or unsupported: the page keeps working without notifications.
      }
    }

    function showReminderNotification(note, t) {
      try {
        if (notificationPermissionState() !== 'granted') return
        const body = note && typeof note.text === 'string' ? note.text.slice(0, 160) : ''
        const notification = new Notification(t('便签提醒', 'Note reminder'), {
          body: body,
          tag: 'dsh-note-wall:' + String(note && note.id),
        })
        if (notification && typeof notification.close === 'function') {
          setTimeout(function () { try { notification.close() } catch (error) {} }, 12000)
        }
      } catch (error) {
        // Some shells expose Notification but refuse construction.
      }
    }

    function playReminderSound(volume) {
      try {
        const Ctor = typeof window !== 'undefined'
          ? window.AudioContext || window.webkitAudioContext
          : undefined
        if (typeof Ctor !== 'function') return
        const context = new Ctor()
        const level = typeof volume === 'number' && Number.isFinite(volume)
          ? Math.max(0, Math.min(1, volume))
          : DEFAULT_CLIENT_SETTINGS.reminders.volume
        const gain = context.createGain()
        gain.gain.value = level * 0.2
        const oscillator = context.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.value = 880
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start()
        oscillator.stop(context.currentTime + 0.16)
        if (typeof context.resume === 'function') {
          const resumed = context.resume()
          if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {})
        }
        setTimeout(function () {
          try { if (typeof context.close === 'function') context.close() } catch (error) {}
        }, 900)
      } catch (error) {
        // Audio is optional; an autoplay refusal must never break the page.
      }
    }

    let settingsCache = null

    function publishSettings(settings) {
      const next = normalizeClientSettings(settings)
      settingsCache = next
      try {
        if (
          typeof window !== 'undefined'
          && typeof window.dispatchEvent === 'function'
          && typeof CustomEvent === 'function'
        ) {
          window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }))
        }
      } catch (error) {
        // The event is an optimization; the overlay also reads settings itself.
      }
    }

    /** Tell the wall page that another surface (the overlay) changed notes. */
    function publishNotesChanged() {
      try {
        if (
          typeof window !== 'undefined'
          && typeof window.dispatchEvent === 'function'
          && typeof CustomEvent === 'function'
        ) {
          window.dispatchEvent(new CustomEvent(NOTES_EVENT))
        }
      } catch (error) {
        // The page still refreshes on its own next action.
      }
    }

    function isImportableLink(link, maxChars) {
      if (Array.from(link).length > maxChars) return false
      try {
        const url = new URL(link)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch (error) {
        return false
      }
    }

    function serializeNotes(notes) {
      const list = (Array.isArray(notes) ? notes : []).map(function (note) {
        return {
          text: typeof note.text === 'string' ? note.text : '',
          tag: typeof note.tag === 'string' ? note.tag : '',
          tone: typeof note.tone === 'string' ? note.tone : DEFAULT_TONE,
          link: typeof note.link === 'string' ? note.link : '',
        }
      })
      return JSON.stringify({
        app: 'dsh-note-wall',
        version: 1,
        exportedAt: new Date().toISOString(),
        notes: list,
      }, null, 2)
    }

    function parseImportPayload(raw, limits) {
      const caps = limits || DEFAULT_LIMITS
      let parsed
      try {
        parsed = JSON.parse(String(raw || ''))
      } catch (error) {
        throw Object.assign(new Error('import-json'), { code: 'import-json' })
      }
      const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.notes)
          ? parsed.notes
          : undefined
      if (list === undefined) throw Object.assign(new Error('import-shape'), { code: 'import-shape' })
      const notes = []
      let skipped = 0
      for (const item of list) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          skipped += 1
          continue
        }
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (text.length === 0 || Array.from(text).length > caps.maxNoteChars) {
          skipped += 1
          continue
        }
        const tag = typeof item.tag === 'string' ? item.tag.trim() : ''
        if (Array.from(tag).length > caps.maxTagChars) {
          skipped += 1
          continue
        }
        const link = typeof item.link === 'string' ? item.link.trim() : ''
        if (link.length > 0 && !isImportableLink(link, caps.maxLinkChars)) {
          skipped += 1
          continue
        }
        let tone = DEFAULT_TONE
        if (item.tone !== undefined && item.tone !== null && item.tone !== '') {
          if (typeof item.tone !== 'string' || !isValidTone(item.tone)) {
            skipped += 1
            continue
          }
          tone = item.tone.toLowerCase()
        }
        notes.push({ text: text, tag: tag, tone: tone, link: link })
      }
      return { notes: notes, skipped: skipped }
    }

    /**
     * Pure three-tap tracker for the footer signature. Keeps only the taps that
     * are still inside the window; the third tap inside it opens the note and
     * clears the streak. Exposed on a test-only global so the real client file
     * can be exercised without a browser.
     */
    function signatureTap(taps, nowMs, windowMs) {
      const span = typeof windowMs === 'number' && windowMs > 0 ? windowMs : SIGNATURE_CLICK_WINDOW_MS
      const recent = []
      const history = Array.isArray(taps) ? taps : []
      for (const tap of history) {
        if (typeof tap === 'number' && nowMs - tap <= span) recent.push(tap)
      }
      recent.push(nowMs)
      if (recent.length >= SIGNATURE_CLICK_COUNT) return { taps: [], opened: true }
      return { taps: recent.slice(-(SIGNATURE_CLICK_COUNT - 1)), opened: false }
    }

    let signatureConsolePrinted = false

    function printSignatureConsole() {
      if (signatureConsolePrinted) return
      signatureConsolePrinted = true
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info(SIGNATURE_CONSOLE_TEXT)
        }
      } catch (error) {
        // A console line must never block plugin activation.
      }
    }

    if (typeof window !== 'undefined' && window.__DSH_NOTE_WALL_TEST__ && typeof window.__DSH_NOTE_WALL_TEST__ === 'object') {
      window.__DSH_NOTE_WALL_TEST__.signatureTap = signatureTap
      window.__DSH_NOTE_WALL_TEST__.signatureWindowMs = SIGNATURE_CLICK_WINDOW_MS
      window.__DSH_NOTE_WALL_TEST__.signatureConsoleText = SIGNATURE_CONSOLE_TEXT
      window.__DSH_NOTE_WALL_TEST__.filterNotes = filterNotes
      window.__DSH_NOTE_WALL_TEST__.serializeNotes = serializeNotes
      window.__DSH_NOTE_WALL_TEST__.parseImportPayload = parseImportPayload
      window.__DSH_NOTE_WALL_TEST__.DEFAULT_LIMITS = DEFAULT_LIMITS
      window.__DSH_NOTE_WALL_TEST__.DEFAULT_CLIENT_SETTINGS = DEFAULT_CLIENT_SETTINGS
      window.__DSH_NOTE_WALL_TEST__.normalizeClientSettings = normalizeClientSettings
      window.__DSH_NOTE_WALL_TEST__.featureEnabled = featureEnabled
      window.__DSH_NOTE_WALL_TEST__.resolveImageDisplay = resolveImageDisplay
      window.__DSH_NOTE_WALL_TEST__.folderFilterOptions = folderFilterOptions
      window.__DSH_NOTE_WALL_TEST__.toLocalDateTimeInput = toLocalDateTimeInput
      window.__DSH_NOTE_WALL_TEST__.fromLocalDateTimeInput = fromLocalDateTimeInput
      window.__DSH_NOTE_WALL_TEST__.isReminderDue = isReminderDue
      window.__DSH_NOTE_WALL_TEST__.globalAlarmActive = globalAlarmActive
      window.__DSH_NOTE_WALL_TEST__.shouldNotifyReminder = shouldNotifyReminder
      window.__DSH_NOTE_WALL_TEST__.shouldPlayReminderSound = shouldPlayReminderSound
      window.__DSH_NOTE_WALL_TEST__.nextCategoryHistory = nextCategoryHistory
      window.__DSH_NOTE_WALL_TEST__.settingsPatch = settingsPatch
      window.__DSH_NOTE_WALL_TEST__.NoteCard = NoteCard
      window.__DSH_NOTE_WALL_TEST__.NoteWallPage = NoteWallPage
    }

    // ---------------------------------------------------------------------------
    // HTTP
    // ---------------------------------------------------------------------------

    async function readApiResult(response) {
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        const failure = new Error('HTTP ' + response.status)
        failure.status = response.status
        failure.code = 'bad-response'
        throw failure
      }
      if (!response.ok || !body || body.ok !== true) {
        const info = body && body.error ? body.error : null
        const failure = new Error(
          info && info.message
            ? String(info.message)
            : info && info.code
              ? String(info.code)
              : 'HTTP ' + response.status,
        )
        failure.code = info && typeof info.code === 'string' ? info.code : ''
        failure.status = response.status
        throw failure
      }
      return body.value
    }

    async function apiCall(action, payload, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this shell')
      const options = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: API_HEADERS,
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      }
      if (signal) options.signal = signal
      return readApiResult(await fetch(API_PATH, options))
    }

    async function uploadImage(file, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this shell')
      const options = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': file.type, 'x-dsh-note-wall': '1' },
        body: file,
      }
      if (signal) options.signal = signal
      return readApiResult(await fetch(IMAGE_UPLOAD_PATH, options))
    }

    // ---------------------------------------------------------------------------
    // Locale and formatting helpers
    // ---------------------------------------------------------------------------

    function isZhLocale(ctx) {
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        return active.toLowerCase().indexOf('zh') === 0
      } catch (error) {
        return false
      }
    }

    function useLocaleActive(ctx) {
      const subscribe = React.useCallback(function (listener) {
        const locale = ctx ? ctx.locale : null
        if (!locale || typeof locale.subscribe !== 'function') return function () {}
        const off = locale.subscribe(listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        try {
          const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
          return snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        } catch (error) {
          return ''
        }
      }, [ctx])
      const active = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof active === 'string' ? active : ''
    }

    function useText(ctx) {
      const active = useLocaleActive(ctx)
      return React.useMemo(function () {
        const zh = String(active || '').toLowerCase().indexOf('zh') === 0
        return function (zhText, enText) {
          return zh ? zhText : enText
        }
      }, [active])
    }

    function themeColorScheme(ctx) {
      try {
        const theme = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : undefined
        const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null
        const scheme = snapshot && snapshot.active && snapshot.active.colorScheme
        return scheme === 'dark' ? 'dark' : 'light'
      } catch (error) {
        return 'light'
      }
    }

    function useColorScheme(ctx) {
      const subscribe = React.useCallback(function (listener) {
        if (!ctx || typeof ctx.on !== 'function') return function () {}
        const off = ctx.on('theme/change', listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        return themeColorScheme(ctx)
      }, [ctx])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function toneName(t, definition) {
      return t(definition.zh, definition.en)
    }

    function formatRelative(iso, nowMs, t, locale) {
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const diff = Math.max(0, nowMs - then)
      const minute = 60000
      if (diff < minute) return t('刚刚', 'Just now')
      if (diff < 60 * minute) {
        const minutes = Math.floor(diff / minute)
        return t(minutes + ' 分钟前', minutes + ' min ago')
      }
      if (diff < 24 * 60 * minute) {
        const hours = Math.floor(diff / (60 * minute))
        return t(hours + ' 小时前', hours + ' h ago')
      }
      if (diff < 7 * 24 * 60 * minute) {
        const days = Math.floor(diff / (24 * 60 * minute))
        return t(days + ' 天前', days + ' d ago')
      }
      const date = new Date(then)
      return t(
        date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日',
        date.toLocaleDateString(locale || undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      )
    }

    function formatAbsolute(iso, locale) {
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      try {
        return new Date(then).toLocaleString(locale || undefined)
      } catch (error) {
        return new Date(then).toString()
      }
    }

    /** Short local reminder label (month/day + hour:minute) for cards and overlay. */
    function formatReminderTime(iso, locale) {
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      try {
        return new Date(then).toLocaleString(locale || undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch (error) {
        return formatAbsolute(iso, locale)
      }
    }

    function imageUrl(id) {
      return IMAGE_PATH_PREFIX + encodeURIComponent(id)
    }

    function shortenUrl(link) {
      try {
        const url = new URL(link)
        const rest = (url.pathname === '/' ? '' : url.pathname) + url.search
        const tail = rest.length > 30 ? rest.slice(0, 30) + '…' : rest
        return url.host + tail
      } catch (error) {
        return link.length > 42 ? link.slice(0, 42) + '…' : link
      }
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return Math.round(value) + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function revokeObjectUrl(url) {
      if (!url) return
      try {
        URL.revokeObjectURL(url)
      } catch (error) {
        // A URL from another document generation is already gone.
      }
    }

    function errorText(t, error, limits) {
      const codes = limits || DEFAULT_LIMITS
      const code = error && error.code ? String(error.code) : ''
      const messages = {
        forbidden: t('请求被拒绝，请从本机 Harness 页面打开便签墙。', 'The request was rejected; open this page from the local Harness.'),
        'method-not-allowed': t('请求方式不被允许。', 'That request method is not allowed.'),
        'unsupported-media-type': t('请求格式不正确。', 'Unsupported request format.'),
        'invalid-json': t('请求内容不是合法 JSON。', 'The request body is not valid JSON.'),
        'invalid-body': t('请求内容不完整。', 'The request body is incomplete.'),
        'request-aborted': t('请求中断了，请再试一次。', 'The request was interrupted; try again.'),
        'body-too-large': t('内容太长，无法保存。', 'The content is too large to save.'),
        'bad-response': t('便签服务返回了无法识别的内容。', 'The note service returned an unexpected response.'),
        'note-text-required': t('先写点什么再添加到墙上。', 'Write something before adding it to the wall.'),
        'note-text-too-long': t('便签最多 ' + codes.maxNoteChars + ' 个字符。', 'Notes are limited to ' + codes.maxNoteChars + ' characters.'),
        'note-tag-invalid': t('分类必须是文本。', 'The category must be text.'),
        'note-tag-too-long': t('分类最多 ' + codes.maxTagChars + ' 个字符。', 'Categories are limited to ' + codes.maxTagChars + ' characters.'),
        'note-tone-invalid': t('这个便签颜色不可用。', 'That note color is not available.'),
        'note-limit-reached': t('便签墙最多 ' + codes.maxNotes + ' 条，先删掉几条吧。', 'The wall holds up to ' + codes.maxNotes + ' notes; delete a few first.'),
        'note-id-required': t('缺少便签标识。', 'The note id is missing.'),
        'note-not-found': t('这条便签已经不存在了。', 'That note no longer exists.'),
        'note-nothing-to-update': t('没有需要保存的修改。', 'There is nothing to save.'),
        'note-link-invalid': t('链接必须是 http 或 https 地址。', 'The link must be an http or https address.'),
        'note-link-too-long': t('链接最多 ' + codes.maxLinkChars + ' 个字符。', 'Links are limited to ' + codes.maxLinkChars + ' characters.'),
        'note-image-invalid': t('图片标识无效。', 'That image reference is not valid.'),
        'note-image-missing': t('图片不存在或已被清理，请重新选择。', 'That image is gone; please pick it again.'),
        'note-conflict': t('这条便签已在别处修改，请重新打开后再编辑。', 'This note changed elsewhere; reopen it before editing.'),
        'image-too-large': t('图片不能超过 ' + formatBytes(codes.maxImageBytes) + '。', 'Images are limited to ' + formatBytes(codes.maxImageBytes) + '.'),
        'image-type-invalid': t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.'),
        'image-empty': t('图片内容为空。', 'The image is empty.'),
        'image-write-failed': t('图片保存失败，请查看 Harness 日志。', 'Saving the image failed; check the Harness log.'),
        'import-json': t('JSON 格式不正确。', 'That JSON is not valid.'),
        'import-shape': t('JSON 里没有 notes 数组。', 'The JSON has no notes array.'),
        'store-unavailable': t('便签存储暂时不可用，请查看 Harness 日志。', 'Note storage is unavailable; check the Harness log.'),
        'store-corrupt-unreadable': t('便签存储损坏且无法保留原文件，读写已停止。', 'Note storage is damaged and could not be preserved; reads and writes are stopped.'),
        'settings-unavailable': t('便签墙设置暂时不可用，请查看 Harness 日志。', 'Note wall settings are unavailable; check the Harness log.'),
        'settings-invalid': t('设置内容不完整。', 'The settings payload is incomplete.'),
        'settings-value-invalid': t('有一项设置的值无效，未保存。', 'One setting value is invalid, so nothing was saved.'),
        'note-remind-invalid': t('提醒时间无法识别。', 'That reminder time is not valid.'),
        'note-folder-invalid': t('文件夹不存在，请刷新后再试。', 'That folder does not exist; refresh and try again.'),
        'folder-name-required': t('文件夹名称不能为空。', 'A folder name is required.'),
        'folder-name-too-long': t('文件夹名称最多 ' + codes.maxFolderNameChars + ' 个字符。', 'Folder names are limited to ' + codes.maxFolderNameChars + ' characters.'),
        'folder-duplicate': t('已经有同名文件夹了。', 'A folder with that name already exists.'),
        'folder-limit-reached': t('最多只能有 ' + codes.maxFolders + ' 个文件夹。', 'The wall holds up to ' + codes.maxFolders + ' folders.'),
        'folder-not-found': t('这个文件夹已不存在。', 'That folder no longer exists.'),
        'internal': t('便签保存失败，请查看 Harness 日志。', 'Saving the note failed; check the Harness log.'),
        'unknown-action': t('未知操作。', 'Unknown action.'),
      }
      if (messages[code]) return messages[code]
      if (error && error.message) return String(error.message)
      return t('操作失败，请重试。', 'Something went wrong; try again.')
    }

    // ---------------------------------------------------------------------------
    // Icon glyphs (currentColor only; no theme tokens needed inside the svg)
    // ---------------------------------------------------------------------------

    function svgProps(size) {
      return {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      }
    }

    function NoteGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', svgProps(size),
        h('path', { key: 'body', d: 'M6 3.5h9L19.5 8v11.6a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5z' }),
        h('path', { key: 'fold', d: 'M15 3.6V8h4.4' }),
        h('path', { key: 'line-a', d: 'M8.5 12.4h6.4' }),
        h('path', { key: 'line-b', d: 'M8.5 15.9h4' }),
      )
    }

    function PlusGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size), h('path', { d: 'M12 5v14M5 12h14' }))
    }

    function PencilGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('path', { key: 'body', d: 'M4 20l4.2-1 10.3-10.3a2.1 2.1 0 0 0-3-3L5.2 16 4 20z' }),
        h('path', { key: 'tip', d: 'M13.6 7.4l3 3' }),
      )
    }

    function TrashGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('path', { key: 'lid', d: 'M4 7h16' }),
        h('path', { key: 'handle', d: 'M9.2 7V5.4A1.4 1.4 0 0 1 10.6 4h2.8a1.4 1.4 0 0 1 1.4 1.4V7' }),
        h('path', { key: 'body', d: 'M6.6 7l.8 11.9a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7' }),
        h('path', { key: 'line-a', d: 'M10.4 11v5.2' }),
        h('path', { key: 'line-b', d: 'M13.6 11v5.2' }),
      )
    }

    function LinkGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 13
      return h('svg', svgProps(size),
        h('path', { key: 'a', d: 'M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4' }),
        h('path', { key: 'b', d: 'M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4' }),
      )
    }

    function ImageGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('rect', { key: 'frame', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
        h('circle', { key: 'sun', cx: 9, cy: 10, r: 1.6 }),
        h('path', { key: 'hill', d: 'M5.2 17.4l4.4-4.4 3.2 3.2 2.4-2.4 3.6 3.6' }),
      )
    }

    function CloseGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size),
        h('path', { key: 'x', d: 'M6 6l12 12M18 6L6 18' }),
      )
    }

    function SparkleGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size),
        h('path', { key: 'big', d: 'M12 3.5l1.7 4.6 4.8 1.7-4.8 1.7L12 16.1l-1.7-4.6-4.8-1.7 4.8-1.7z' }),
        h('path', { key: 'small', d: 'M18.2 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' }),
      )
    }

    function GearGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('circle', { key: 'hub', cx: 12, cy: 12, r: 3.2 }),
        h('path', {
          key: 'ring',
          d: 'M12 3.4v2.1M12 18.5v2.1M3.4 12h2.1M18.5 12h2.1M5.9 5.9l1.5 1.5M16.6 16.6l1.5 1.5M18.1 5.9l-1.5 1.5M7.4 16.6l-1.5 1.5',
        }),
      )
    }

    function ClockGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 13
      return h('svg', svgProps(size),
        h('circle', { key: 'face', cx: 12, cy: 12, r: 8.4 }),
        h('path', { key: 'hands', d: 'M12 7.6V12l3 1.8' }),
      )
    }

    function FolderGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size),
        h('path', { key: 'body', d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z' }),
      )
    }

    function EmptyStackGlyph() {
      return h('svg', {
        width: 120,
        height: 88,
        viewBox: '0 0 120 88',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { key: 'back', x: 14, y: 22, width: 62, height: 52, rx: 11, fill: '#D9CBF7', transform: 'rotate(-8 45 48)' }),
        h('rect', { key: 'middle', x: 30, y: 14, width: 62, height: 52, rx: 11, fill: '#BFE9DD', transform: 'rotate(5 61 40)' }),
        h('rect', { key: 'front', x: 42, y: 22, width: 62, height: 52, rx: 11, fill: '#F8E5B0' }),
        h('path', { key: 'lines', d: 'M52 40h40M52 50h28', stroke: '#8A6A1C', strokeWidth: 2.4, strokeLinecap: 'round' }),
      )
    }

    // ---------------------------------------------------------------------------
    // Scoped stylesheet, rendered as a style element inside the page root
    // ---------------------------------------------------------------------------

    const CSS = `
.nw-root{height:100%;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.nw-root::-webkit-scrollbar{width:10px;height:10px}
.nw-root::-webkit-scrollbar-track{background:transparent}
.nw-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
.nw-page{max-width:1120px;margin:0 auto;padding:28px 32px 48px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px;min-height:100%}
.nw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.nw-title{margin:0;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.nw-sub{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.nw-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nw-head-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nw-motion-toggle{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);font-family:inherit;font-size:11.5px;cursor:pointer}
.nw-motion-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nw-motion-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-motion-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.nw-motion-on .nw-motion-dot{background:var(--dsw-alias-brand-primary)}
.nw-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nw-search{flex:1 1 220px;min-width:150px;height:32px;box-sizing:border-box;padding:0 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px}
.nw-search::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent);opacity:1}
.nw-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-filter{height:32px;padding:0 8px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;cursor:pointer}
.nw-filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.nw-export{display:inline-flex;align-items:center;text-decoration:none}
.nw-banner-success{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}

.nw-tone-amber{--nw-accent:#F0C24B}
.nw-tone-peach{--nw-accent:#F2A6BC}
.nw-tone-sky{--nw-accent:#8FC4F0}
.nw-tone-mint{--nw-accent:#7FD3C0}
.nw-tone-lilac{--nw-accent:#B79CF0}
.nw-tone-cream{--nw-accent:#E4D3AE}

/* Dark theme: keep the tinted surfaces darker so the host's light text keeps
   full contrast instead of sitting on a mid-tone olive/brown card. */
.nw-dark .nw-compose{background:color-mix(in srgb,var(--nw-accent) 26%,var(--dsw-alias-bg-layer-1))}
.nw-dark .nw-note{background:color-mix(in srgb,var(--nw-accent) 22%,var(--dsw-alias-bg-layer-1))}

/* A custom color can be arbitrarily dark or light, so keep its surface near the
   theme surface and express the hue through a tinted border instead of dropping
   the text/placeholder contrast. */
.nw-tone-custom.nw-compose{background:color-mix(in srgb,var(--nw-accent) 22%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--nw-accent) 58%,var(--dsw-alias-border-l1))}
.nw-tone-custom.nw-note{background:color-mix(in srgb,var(--nw-accent) 20%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--nw-accent) 58%,var(--dsw-alias-border-l1))}
.nw-dark .nw-tone-custom.nw-compose{background:color-mix(in srgb,var(--nw-accent) 17%,var(--dsw-alias-bg-layer-1))}
.nw-dark .nw-tone-custom.nw-note{background:color-mix(in srgb,var(--nw-accent) 15%,var(--dsw-alias-bg-layer-1))}

.nw-compose{border-radius:22px;padding:20px 22px 14px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--nw-accent) 52%,var(--dsw-alias-bg-layer-1))}
.nw-compose:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-compose-dragging{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-compose-input{display:block;width:100%;box-sizing:border-box;min-height:92px;padding:0;border:none;outline:none;background:transparent;resize:none;font-family:inherit;font-size:17.5px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.nw-compose-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 70%,transparent);opacity:1}
.nw-compose-input:focus-visible{outline:none}
.nw-compose-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:10px}
.nw-palette{display:flex;align-items:center;gap:4px;padding:2px}
.nw-swatch{position:relative;width:24px;height:24px;padding:0;border:none;border-radius:50%;background:transparent;cursor:pointer;flex:none;transition:transform .12s ease}
.nw-swatch::before{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--nw-accent);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.nw-motion .nw-swatch:hover{transform:scale(1.06)}
.nw-swatch-selected::before{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 3px var(--dsw-alias-label-primary)}
.nw-swatch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-swatch-small::before{inset:5px}
.nw-swatch-custom::before{background:var(--nw-custom,conic-gradient(from 210deg,#F0C24B,#F2A6BC,#8FC4F0,#7FD3C0,#B79CF0,#F0C24B))}
.nw-tag-input{width:128px;height:30px;padding:0 9px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.nw-tag-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 68%,transparent);opacity:1}
.nw-tag-input:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent)}
.nw-tag-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-bg-layer-1)}
.nw-link-field{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);min-width:0}
.nw-link-field:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent)}
.nw-link-field:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-bg-layer-1)}
.nw-link-input{width:132px;min-width:64px;border:none;outline:none;background:transparent;font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.nw-link-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent);opacity:1}
.nw-attach-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border-radius:999px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 30%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);font-family:inherit;font-size:12.5px;cursor:pointer}
.nw-attach-btn:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 65%,transparent);color:var(--dsw-alias-label-primary)}
.nw-attach-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-file-input{display:none}
.nw-compose-preview{display:flex;align-items:center;gap:10px;margin-top:10px;padding:6px 8px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.nw-preview-thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
.nw-preview-meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;font-size:11px;color:var(--dsw-alias-label-secondary)}
.nw-preview-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-compose-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.nw-kbd{font-size:11.5px;letter-spacing:.02em;color:color-mix(in srgb,var(--dsw-alias-label-primary) 68%,transparent);white-space:nowrap}
.nw-add{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 16px;border:none;border-radius:999px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background-color .15s ease}
.nw-add:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.nw-add:disabled{background:var(--dsw-alias-button-primary-dimmed);cursor:default}
.nw-add:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

.nw-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));align-items:start}
.nw-note{display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:18px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--nw-accent) 42%,var(--dsw-alias-bg-layer-1));box-sizing:border-box}
.nw-note:hover{border-color:var(--dsw-alias-border-l2)}
.nw-note-editing:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note-body{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.nw-note-tag{font-size:12px;font-weight:600;letter-spacing:.04em;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent)}
.nw-note-text{margin:0;font-size:16px;line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.nw-note-thumb{display:block;width:96px;height:96px;border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}
.nw-note-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.nw-note-thumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note-link{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;font-size:12px;color:var(--dsw-alias-link);text-decoration:none;padding:2px 0}
.nw-note-link:hover{text-decoration:underline}
.nw-note-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.nw-note-link-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-note-editor{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.nw-edit-input{display:block;width:100%;box-sizing:border-box;min-height:82px;padding:0;border:none;outline:none;background:transparent;resize:vertical;font-family:inherit;font-size:15px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.nw-edit-input:focus-visible{outline:none}
.nw-edit-tag{width:100%;box-sizing:border-box;height:26px;padding:0;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-edit-tag::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nw-edit-tag:focus-visible{outline:none;border-bottom-color:var(--dsw-alias-brand-primary)}
.nw-edit-link{width:100%;box-sizing:border-box;height:26px;padding:0;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-edit-link::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nw-edit-link:focus-visible{outline:none;border-bottom-color:var(--dsw-alias-brand-primary)}
.nw-edit-image{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:6px;border-radius:10px;border:.5px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.nw-edit-image img{display:block;width:100%;max-height:180px;height:auto;object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.nw-edit-image-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.nw-edit-palette{display:flex;align-items:center;gap:4px;padding-top:2px}
.nw-note-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 72%,transparent)}
.nw-note-time{flex:none}
.nw-note-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:wrap;opacity:.55;transition:opacity .12s ease}
.nw-note:hover .nw-note-actions,.nw-note:focus-within .nw-note-actions{opacity:1}
.nw-confirm-text{font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent)}
.nw-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);cursor:pointer}
.nw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nw-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-mini{height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;cursor:pointer}
.nw-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nw-mini:disabled{opacity:.6;cursor:default}
.nw-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-mini-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base)}
.nw-mini-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.nw-mini-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.nw-mini-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

/* v1.2.0: settings dialog, folders, reminders, category history */
.nw-settings-backdrop{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-start;justify-content:center;padding:64px 16px 24px;box-sizing:border-box;overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base) 34%,transparent)}
.nw-settings{width:min(540px,100%);max-height:calc(100vh - 96px);overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:18px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.18)}
.nw-settings-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.nw-settings-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nw-settings-body{display:flex;flex-direction:column;gap:14px}
.nw-set-section{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.nw-set-section-title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
.nw-set-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;min-height:22px}
.nw-set-row input[type="checkbox"]{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.nw-set-row:has(input:disabled){opacity:.5;cursor:default}
.nw-set-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.nw-set-inline select{height:26px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px}
.nw-set-range{width:150px;accent-color:var(--dsw-alias-brand-primary)}
.nw-set-val{min-width:36px;font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.nw-set-hint{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.nw-set-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:2px}
.nw-set-foot-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.nw-folder-panel{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.nw-folder-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nw-folder-input{height:28px;min-width:0;flex:1 1 150px;box-sizing:border-box;padding:0 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px}
.nw-folder-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--dsw-alias-label-primary);min-height:26px}
.nw-folder-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 120px}
.nw-folder-empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.nw-select-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}
.nw-select-bar select{height:26px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px}
.nw-note-select{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 80%,transparent);cursor:pointer}
.nw-select-check{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.nw-note-folder{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;max-width:100%;padding:1px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);font-size:11px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 82%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-note-remind{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;max-width:100%;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 78%,transparent)}
.nw-note-remind-due{border-color:var(--dsw-alias-state-error-secondary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary)}
.nw-remind-field{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent)}
.nw-remind-field:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-bg-layer-1)}
.nw-remind-input{width:148px;min-width:96px;border:none;outline:none;background:transparent;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary)}
.nw-edit-remind{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.nw-edit-remind input[type="datetime-local"]{height:26px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px}
.nw-cat-history{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px}
.nw-cat-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.nw-cat-chip{height:24px;padding:0 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);font-family:inherit;font-size:11.5px;cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-cat-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nw-cat-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-note-image{display:block;width:100%;border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.nw-note-image img{display:block;width:100%;max-height:190px;height:auto;object-fit:cover}
.nw-note-image:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note-thumb-icon{border-radius:8px}

.nw-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.6;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nw-banner-error{border-color:var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1))}
.nw-banner-text{flex:1;min-width:0;overflow-wrap:anywhere}
.nw-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:44px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-spinner{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:nw-spin .9s linear infinite;flex:none}
.nw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:52px 20px;border-radius:22px;border:.5px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);text-align:center}
.nw-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nw-empty-hint{max-width:420px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.nw-page-foot{display:flex;align-items:flex-end;justify-content:flex-start;margin-top:auto;padding-top:8px}
.nw-signature-wrap{position:relative;display:inline-flex;flex-direction:column;align-items:flex-start;gap:8px;max-width:100%}
.nw-signature{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 2px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;letter-spacing:.02em;opacity:.55;cursor:pointer;user-select:none}
.nw-signature:hover,.nw-signature:focus-visible{opacity:1}
.nw-signature:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-signature-mark{width:10px;height:10px;border-radius:3px;background:#5B57F0;flex:none}
.nw-dark .nw-signature-mark{background:#8B87FF}
.nw-signature-pop{display:flex;align-items:center;gap:12px;max-width:min(100%,360px);box-sizing:border-box;padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nw-signature-quote{margin:0;font-size:13px;line-height:1.6;min-width:0;overflow-wrap:anywhere}
.nw-signature-close{flex:none}
.nw-motion .nw-signature{transition:opacity .12s ease}
.nw-motion .nw-signature-pop{animation:nw-signature-in .16s ease-out}
@keyframes nw-signature-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes nw-spin{to{transform:rotate(360deg)}}
.nw-motion .nw-compose{transition:background-color .18s ease}
.nw-motion .nw-note{animation:nw-note-in .22s ease-out backwards;transition:transform .16s ease,border-color .18s ease,background-color .18s ease}
.nw-motion .nw-note:hover{transform:translateY(-2px)}
.nw-motion .nw-add:not(:disabled):active{transform:scale(.97)}
.nw-motion .nw-swatch-selected::before{animation:nw-pop .18s ease-out}
.nw-motion .nw-compose:focus-within{animation:nw-focus .25s ease-out}
@keyframes nw-note-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
@keyframes nw-pop{0%{transform:scale(.82)}100%{transform:scale(1)}}
@keyframes nw-focus{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
@media (max-width:720px){.nw-page{padding:20px 16px 36px}.nw-compose{padding:16px 16px 12px;border-radius:18px}.nw-compose-input{min-height:76px;font-size:16.5px}.nw-compose-actions{margin-left:0;width:100%;justify-content:flex-end}.nw-kbd{display:none}.nw-tag-input{width:104px}.nw-grid{grid-template-columns:1fr}.nw-count{font-size:11px}}
@media (prefers-reduced-motion:reduce){.nw-swatch,.nw-note,.nw-note-actions,.nw-compose,.nw-add,.nw-spinner{transition:none;animation:none}.nw-motion .nw-note{animation:none;transform:none}.nw-motion .nw-note:hover{transform:none}.nw-motion .nw-compose:focus-within{animation:none}.nw-motion .nw-swatch-selected::before{animation:none}.nw-motion .nw-add:not(:disabled):active{transform:none}.nw-motion .nw-swatch:hover{transform:none}.nw-motion .nw-signature{transition:none}.nw-motion .nw-signature-pop{animation:none}}
`

    // The reminder surface lives in `shell.overlay`, a fixed layer owned by the
    // host frame. The layer is click-through; only the reminder card opts into
    // pointer events, so the rest of the Harness UI stays usable. No global
    // stylesheet is injected and nothing is written to document.body/head.
    const OVERLAY_CSS = `
.nw-ov-layer{position:fixed;inset:0;z-index:950;display:flex;align-items:flex-end;justify-content:flex-end;padding:18px;box-sizing:border-box;pointer-events:none}
.nw-ov-layer.nw-ov-banner{align-items:flex-start;justify-content:center}
.nw-ov-card{pointer-events:auto;display:flex;flex-direction:column;gap:8px;width:min(330px,100%);max-height:min(62vh,440px);overflow:auto;box-sizing:border-box;padding:12px 14px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 14px 38px rgba(0,0,0,.22);font-size:12px;line-height:1.55}
.nw-ov-banner .nw-ov-card{width:min(480px,100%);max-height:min(42vh,320px)}
.nw-ov-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.nw-ov-title{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nw-ov-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nw-ov-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.nw-ov-item{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary)) 7%,var(--dsw-alias-bg-layer-1))}
.nw-ov-item-due{border-color:var(--dsw-alias-state-error-secondary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
.nw-ov-item-body{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.nw-ov-item-text{margin:0;font-size:12.5px;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nw-ov-item-time{font-size:10.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent)}
.nw-ov-item-due .nw-ov-item-time{color:var(--dsw-alias-state-error-primary)}
.nw-ov-error{margin:0;font-size:11.5px;color:var(--dsw-alias-state-error-primary)}
.nw-ov-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.nw-ov-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;cursor:pointer}
.nw-ov-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nw-ov-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-ov-btn-primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base)}
.nw-ov-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.nw-ov-btn:disabled{opacity:.6;cursor:default}
`

    function Styles() {
      return h('style', null, CSS)
    }

    // ---------------------------------------------------------------------------
    // Page pieces
    // ---------------------------------------------------------------------------

    function EmptyWall(props) {
      const t = props.t
      return h('div', { className: 'nw-empty' },
        h(EmptyStackGlyph, null),
        h('div', { className: 'nw-empty-title' }, t('墙上还是一张白纸', 'The wall is still blank')),
        h('div', { className: 'nw-empty-hint' },
          t(
            '在上面写下第一个灵感，按 ⌘/Ctrl + Enter 就能贴上墙。',
            'Write your first idea above and press ⌘/Ctrl + Enter to pin it up.',
          ),
        ),
      )
    }

    function NoteCard(props) {
      const note = props.note
      const editing = props.editing
      const t = props.t
      const limits = props.limits || DEFAULT_LIMITS
      const edited = note.updatedAt !== note.createdAt
      const tone = editing !== null ? editing.tone : note.tone
      const pending = props.pending || null
      const busy = pending !== null
      const confirmRef = React.useRef(null)
      const editFileRef = React.useRef(null)
      const editColorRef = React.useRef(null)

      React.useEffect(function () {
        if (props.confirming && confirmRef.current && typeof confirmRef.current.focus === 'function') {
          confirmRef.current.focus()
        }
      }, [props.confirming])

      const attachedPreview = editing !== null
        ? (editing.imagePreview || (editing.image ? imageUrl(editing.image) : ''))
        : ''

      const imageDisplay = resolveImageDisplay(props.imageDisplay)
      const remindersEnabled = props.remindersEnabled === true
      const remindersOn = featureEnabled(props.settings, 'reminders') || remindersEnabled
      const folderLabel = editing === null && typeof props.folderName === 'string' ? props.folderName : ''
      const selectable = props.selectable === true && editing === null
      const reminderIso = editing === null && remindersOn && typeof note.remindAt === 'string' ? note.remindAt : ''
      const reminderDue = reminderIso.length > 0 && isReminderDue(note, props.now)

      function pickEditImage() {
        if (editFileRef.current) editFileRef.current.click()
      }

      function onEditFilePicked(event) {
        const files = event.target.files
        const file = files && files.length > 0 ? files[0] : null
        event.target.value = ''
        if (file) props.onEditImageFile(file)
      }

      const editor = editing !== null
        ? h('div', { className: 'nw-note-editor' },
            h('textarea', {
              className: 'nw-edit-input',
              value: editing.text,
              rows: 3,
              maxLength: limits.maxNoteChars,
              autoFocus: true,
              'aria-label': t('编辑便签', 'Edit note'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { text: event.target.value }))
              },
            }),
            h('input', {
              className: 'nw-edit-tag',
              type: 'text',
              value: editing.tag,
              maxLength: limits.maxTagChars,
              placeholder: t('分类（可选）', 'Category (optional)'),
              'aria-label': t('分类（可选）', 'Category (optional)'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { tag: event.target.value }))
              },
            }),
            h('input', {
              className: 'nw-edit-link',
              type: 'text',
              value: editing.link || '',
              maxLength: limits.maxLinkChars,
              placeholder: t('链接（可选）', 'Link (optional)'),
              'aria-label': t('链接（可选）', 'Link (optional)'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { link: event.target.value }))
              },
            }),
            remindersEnabled
              ? h('div', { className: 'nw-edit-remind' },
                  h('span', null, t('提醒时间', 'Remind at')),
                  h('input', {
                    type: 'datetime-local',
                    value: typeof editing.remindInput === 'string' ? editing.remindInput : '',
                    'aria-label': t('提醒时间', 'Reminder time'),
                    onChange: function (event) {
                      props.onChangeEdit(Object.assign({}, editing, {
                        remindInput: event.target.value,
                        remindTouched: true,
                      }))
                    },
                  }),
                  (typeof editing.remindInput === 'string' && editing.remindInput.length > 0)
                    ? h('button', {
                        type: 'button',
                        className: 'nw-mini',
                        onClick: function () {
                          props.onChangeEdit(Object.assign({}, editing, { remindInput: '', remindTouched: true }))
                        },
                      }, t('清除提醒', 'Clear reminder'))
                    : null,
                )
              : null,
            attachedPreview
              ? h('div', { className: 'nw-edit-image' },
                  h('img', { src: attachedPreview, alt: '', draggable: false }),
                  h('div', { className: 'nw-edit-image-actions' },
                    h('button', {
                      type: 'button',
                      className: 'nw-mini',
                      onClick: pickEditImage,
                    }, t('换一张', 'Replace')),
                    h('button', {
                      type: 'button',
                      className: 'nw-mini',
                      onClick: props.onClearEditImage,
                    }, t('移除图片', 'Remove image')),
                    h('input', {
                      ref: editFileRef,
                      type: 'file',
                      className: 'nw-file-input',
                      accept: IMAGE_TYPES.join(','),
                      onChange: onEditFilePicked,
                    }),
                  ),
                )
              : h('div', { className: 'nw-edit-image-actions' },
                  h('button', {
                    type: 'button',
                    className: 'nw-attach-btn',
                    onClick: pickEditImage,
                  },
                    h(ImageGlyph, { size: 14 }),
                    h('span', null, t('添加图片', 'Add image')),
                  ),
                  h('input', {
                    ref: editFileRef,
                    type: 'file',
                    className: 'nw-file-input',
                    accept: IMAGE_TYPES.join(','),
                    onChange: onEditFilePicked,
                  }),
                ),
            h('div', { className: 'nw-edit-palette', role: 'group', 'aria-label': t('便签颜色', 'Note color') },
              TONES.map(function (definition) {
                const name = toneName(t, definition)
                return h('button', {
                  key: definition.key,
                  type: 'button',
                  className: 'nw-swatch nw-swatch-small nw-tone-' + definition.key + (editing.tone === definition.key ? ' nw-swatch-selected' : ''),
                  'aria-label': name,
                  'aria-pressed': editing.tone === definition.key,
                  title: name,
                  onClick: function () {
                    props.onChangeEdit(Object.assign({}, editing, { tone: definition.key }))
                  },
                })
              }),
              h('button', {
                key: 'custom',
                type: 'button',
                className: 'nw-swatch nw-swatch-small nw-swatch-custom' + (isCustomTone(editing.tone) ? ' nw-swatch-selected' : ''),
                style: isCustomTone(editing.tone) ? { '--nw-custom': editing.tone } : undefined,
                'aria-label': t('自定义颜色', 'Custom color'),
                'aria-pressed': isCustomTone(editing.tone),
                title: t('自定义颜色', 'Custom color'),
                onClick: function () { if (editColorRef.current) editColorRef.current.click() },
              }),
              h('input', {
                ref: editColorRef,
                type: 'color',
                className: 'nw-file-input',
                value: isCustomTone(editing.tone) ? editing.tone : '#f0c24b',
                'aria-label': t('自定义颜色', 'Custom color'),
                onChange: function (event) {
                  props.onChangeEdit(Object.assign({}, editing, { tone: String(event.target.value).toLowerCase() }))
                },
              }),
            ),
          )
        : h('div', { className: 'nw-note-body' },
            note.tag ? h('div', { className: 'nw-note-tag' }, note.tag) : null,
            folderLabel
              ? h('div', { className: 'nw-note-folder', title: folderLabel },
                  h(FolderGlyph, { size: 11 }),
                  h('span', null, folderLabel),
                )
              : null,
            h('p', { className: 'nw-note-text' }, note.text),
            note.link
              ? h('a', {
                  className: 'nw-note-link',
                  href: note.link,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: note.link,
                },
                  h(LinkGlyph, { size: 13 }),
                  h('span', { className: 'nw-note-link-text' }, shortenUrl(note.link)),
                )
              : null,
            reminderIso.length > 0
              ? h('div', {
                  className: 'nw-note-remind' + (reminderDue ? ' nw-note-remind-due' : ''),
                  title: formatAbsolute(reminderIso, props.locale),
                },
                  h(ClockGlyph, { size: 12 }),
                  h('span', null,
                    formatReminderTime(reminderIso, props.locale)
                      + (reminderDue ? t(' · 已到期', ' · due') : ''),
                  ),
                )
              : null,
          )

      const image = editing === null && note.image ? imageUrl(note.image) : ''
      let imageNode = null
      if (image) {
        if (imageDisplay === 'large') {
          imageNode = h('a', {
            className: 'nw-note-image',
            href: image,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: t('打开大图', 'Open full image'),
            'aria-label': t('打开便签大图', 'Open note image'),
          }, h('img', { src: image, alt: t('便签图片', 'Note image'), loading: 'lazy', draggable: false }))
        } else {
          const size = imageDisplay === 'icon' ? 32 : 96
          imageNode = h('a', {
            className: 'nw-note-thumb' + (imageDisplay === 'icon' ? ' nw-note-thumb-icon' : ''),
            href: image,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: t('打开大图', 'Open full image'),
            'aria-label': t('打开便签大图', 'Open note image'),
            style: { width: size, height: size },
          }, h('img', { src: image, alt: t('便签图片', 'Note image'), loading: 'lazy', draggable: false }))
        }
      }

      let actions
      if (editing !== null) {
        actions = [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'nw-mini',
            disabled: busy,
            onClick: props.onCancelEdit,
          }, t('取消', 'Cancel')),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'nw-mini nw-mini-primary',
            disabled: busy,
            onClick: props.onSaveEdit,
          }, pending === 'save' ? t('保存中…', 'Saving…') : t('保存', 'Save')),
        ]
      } else if (props.confirming) {
        actions = [
          h('span', { key: 'ask', className: 'nw-confirm-text' }, t('删除这条便签？', 'Delete this note?')),
          h('button', {
            key: 'cancel-delete',
            type: 'button',
            className: 'nw-mini',
            disabled: busy,
            onClick: props.onCancelDelete,
          }, t('取消', 'Cancel')),
          h('button', {
            key: 'confirm-delete',
            type: 'button',
            className: 'nw-mini nw-mini-danger',
            disabled: busy,
            ref: confirmRef,
            onClick: function () { props.onDelete(note) },
          }, pending === 'delete' ? t('删除中…', 'Deleting…') : t('删除', 'Delete')),
        ]
      } else {
        actions = [
          h('button', {
            key: 'edit',
            type: 'button',
            className: 'nw-iconbtn',
            title: t('编辑', 'Edit'),
            'aria-label': t('编辑便签', 'Edit note'),
            onClick: function () { props.onBeginEdit(note) },
          }, h(PencilGlyph, { size: 15 })),
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'nw-iconbtn',
            title: t('删除', 'Delete'),
            'aria-label': t('删除便签', 'Delete note'),
            onClick: props.onAskDelete,
          }, h(TrashGlyph, { size: 15 })),
        ]
      }

      return h('article', {
        className: 'nw-note' + toneClass(tone) + (editing !== null ? ' nw-note-editing' : ''),
        style: toneStyle(tone),
        tabIndex: 0,
        'aria-label': t('便签：', 'Note: ') + (note.tag ? note.tag + ' · ' : '') + note.text,
        onKeyDown: function (event) {
          if (event.key !== 'Escape') return
          if (editing !== null) {
            event.preventDefault()
            props.onCancelEdit()
            return
          }
          if (props.confirming) {
            event.preventDefault()
            props.onCancelDelete()
          }
        },
      },
        selectable
          ? h('label', { className: 'nw-note-select' },
              h('input', {
                type: 'checkbox',
                className: 'nw-select-check',
                checked: props.selected === true,
                disabled: busy,
                'aria-label': t('选择便签', 'Select note'),
                onChange: function () { props.onToggleSelect(note) },
              }),
              h('span', null, t('选择', 'Select')),
            )
          : null,
        imageNode,
        editor,
        h('footer', { className: 'nw-note-foot' },
          h('span', { className: 'nw-note-time', title: formatAbsolute(note.createdAt, props.locale) },
            formatRelative(note.createdAt, props.now, t, props.locale) + (edited ? t(' · 已编辑', ' · edited') : ''),
          ),
          h('div', { className: 'nw-note-actions' }, actions),
        ),
      )
    }

    function notificationPermissionLabel(t) {
      switch (notificationPermissionState()) {
        case 'granted':
          return t('浏览器通知已允许。', 'Browser notifications are allowed.')
        case 'denied':
          return t('浏览器通知已被拒绝，需要在浏览器设置里恢复。', 'Browser notifications are blocked; allow them in the browser settings.')
        case 'unsupported':
          return t('当前环境不支持浏览器通知。', 'This shell does not support browser notifications.')
        default:
          return t('保存开启通知的设置时会请求权限，不会自动弹窗。', 'Permission is requested when you save with notifications on; nothing is requested automatically.')
      }
    }

    /**
     * The note-wall settings surface. It deliberately stays inside the note
     * wall page (not the Harness settings slot): this batch only persists Host
     * settings and every control starts from the values the Host reported.
     */
    function SettingsPanel(props) {
      const settings = props.settings
      const t = props.t
      const [draft, setDraft] = React.useState(function () { return cloneSettingsDocument(settings) })
      const busy = props.busy === true

      React.useEffect(function () {
        setDraft(cloneSettingsDocument(settings))
      }, [settings])

      function patchGroup(group, field, value) {
        setDraft(function (current) {
          const next = cloneSettingsDocument(current)
          next[group][field] = value
          return next
        })
      }

      function patchField(field, value) {
        setDraft(function (current) {
          const next = cloneSettingsDocument(current)
          next[field] = value
          return next
        })
      }

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (busy) return
        props.onSave(settingsPatch(settings, draft))
      }

      function row(label, checked, onChange, disabled) {
        return h('label', { className: 'nw-set-row' },
          h('input', {
            type: 'checkbox',
            checked: checked === true,
            disabled: disabled === true || busy,
            onChange: function (event) { onChange(event.target.checked) },
          }),
          h('span', null, label),
        )
      }

      const categoryLimits = [4, 8, 12]
      if (categoryLimits.indexOf(draft.categoryHistory.limit) < 0) categoryLimits.push(draft.categoryHistory.limit)
      categoryLimits.sort(function (left, right) { return left - right })

      const imageOptions = [
        { value: 'thumbnail', label: t('缩略图', 'Thumbnail') },
        { value: 'icon', label: t('图标', 'Icon') },
        { value: 'large', label: t('大图', 'Large') },
      ]

      const alarmModeOptions = [
        { value: 'overlay', label: t('浮层卡片', 'Floating card') },
        { value: 'banner', label: t('顶部横幅', 'Top banner') },
        { value: 'silent', label: t('仅数据', 'Data only') },
      ]

      return h('div', {
        className: 'nw-settings-backdrop',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose()
        },
      },
        h('div', {
          id: SETTINGS_PANEL_ID,
          className: 'nw-settings',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('便签墙设置', 'Note wall settings'),
        },
          h('div', { className: 'nw-settings-head' },
            h('h3', { className: 'nw-settings-title' }, t('便签墙设置', 'Note wall settings')),
            h('button', {
              type: 'button',
              className: 'nw-iconbtn',
              'aria-label': t('关闭设置', 'Close settings'),
              title: t('关闭设置', 'Close settings'),
              ref: props.closeButtonRef,
              onClick: props.onClose,
            }, h(CloseGlyph, { size: 14 })),
          ),
          props.error
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert' },
                h('span', { className: 'nw-banner-text' }, props.error),
              )
            : null,
          props.notice
            ? h('div', { className: 'nw-banner nw-banner-success', role: 'status' },
                h('span', { className: 'nw-banner-text' }, props.notice),
              )
            : null,
          h('div', { className: 'nw-settings-body' },
            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('分类历史', 'Category history')),
              row(t('显示最近使用的分类', 'Show recently used categories'), draft.categoryHistory.enabled,
                function (value) { patchGroup('categoryHistory', 'enabled', value) }),
              h('div', { className: 'nw-set-inline' },
                h('span', null, t('保留数量', 'Keep')),
                h('select', {
                  value: String(draft.categoryHistory.limit),
                  disabled: busy || !draft.categoryHistory.enabled,
                  'aria-label': t('保留分类数量', 'Category history size'),
                  onChange: function (event) {
                    patchGroup('categoryHistory', 'limit', Number(event.target.value))
                  },
                }, categoryLimits.map(function (limit) {
                  return h('option', { key: limit, value: String(limit) }, String(limit) + ' ' + t('个', 'tags'))
                })),
              ),
              h('p', { className: 'nw-set-hint' }, t('只记录在本机浏览器里，不参与便签数据。', 'Stored only in this browser; it never touches note data.')),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('文件夹', 'Folders')),
              row(t('启用文件夹', 'Enable folders'), draft.folders.enabled,
                function (value) { patchGroup('folders', 'enabled', value) }),
              h('p', { className: 'nw-set-hint' }, t('关闭后只隐藏文件夹界面，已保存的分组不会删除。', 'Turning this off only hides the folder UI; saved assignments are kept.')),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('卡片图片', 'Card image')),
              h('div', { className: 'nw-set-inline' },
                h('span', null, t('显示方式', 'Display')),
                h('select', {
                  value: draft.imageDisplay,
                  disabled: busy,
                  'aria-label': t('卡片图片显示方式', 'Card image display'),
                  onChange: function (event) { patchField('imageDisplay', event.target.value) },
                }, imageOptions.map(function (option) {
                  return h('option', { key: option.value, value: option.value }, option.label)
                })),
              ),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('提醒', 'Reminders')),
              row(t('启用提醒', 'Enable reminders'), draft.reminders.enabled,
                function (value) { patchGroup('reminders', 'enabled', value) }),
              row(t('提醒声音', 'Reminder sound'), draft.reminders.sound,
                function (value) { patchGroup('reminders', 'sound', value) }, !draft.reminders.enabled),
              h('div', { className: 'nw-set-inline' },
                h('span', null, t('音量', 'Volume')),
                h('input', {
                  type: 'range',
                  className: 'nw-set-range',
                  min: 0,
                  max: 1,
                  step: 0.05,
                  value: draft.reminders.volume,
                  disabled: busy || !draft.reminders.enabled || !draft.reminders.sound,
                  'aria-label': t('提醒音量', 'Reminder volume'),
                  onChange: function (event) {
                    patchGroup('reminders', 'volume', Number(event.target.value))
                  },
                }),
                h('span', { className: 'nw-set-val' }, Math.round(draft.reminders.volume * 100) + '%'),
              ),
              row(t('浏览器通知', 'Browser notifications'), draft.reminders.notifications,
                function (value) { patchGroup('reminders', 'notifications', value) }, !draft.reminders.enabled),
              h('p', { className: 'nw-set-hint' }, notificationPermissionLabel(t)),
              row(t('打开页面时补发已逾期提醒', 'Catch up overdue reminders on load'), draft.reminders.overdue,
                function (value) { patchGroup('reminders', 'overdue', value) }, !draft.reminders.enabled),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('主界面 / 全局提醒', 'Main surface / global alarm')),
              row(t('在 Harness 主界面显示提醒', 'Show reminders over the Harness shell'), draft.globalAlarm.enabled,
                function (value) { patchGroup('globalAlarm', 'enabled', value) }),
              h('div', { className: 'nw-set-inline' },
                h('span', null, t('展示方式', 'Presentation')),
                h('select', {
                  value: draft.globalAlarm.mode,
                  disabled: busy || !draft.globalAlarm.enabled,
                  'aria-label': t('全局提醒展示方式', 'Global alarm presentation'),
                  onChange: function (event) { patchGroup('globalAlarm', 'mode', event.target.value) },
                }, alarmModeOptions.map(function (option) {
                  return h('option', { key: option.value, value: option.value }, option.label)
                })),
              ),
              h('p', { className: 'nw-set-hint' }, t('浮层/横幅出现在 Harness 界面角落；「仅数据」不显示、不响铃、不通知。', 'Overlay/banner appears over the Harness shell; "Data only" shows, rings and notifies nothing.')),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('AI 写入', 'Agent writes')),
              row(t('允许 AI 工具向便签墙写入', 'Allow agent tools to add notes'), draft.agentWrite.enabled,
                function (value) { patchGroup('agentWrite', 'enabled', value) }),
              h('p', { className: 'nw-set-hint' }, t('关闭时 note_wall_add 会被 Harness 端拒绝。', 'When off, the Host rejects note_wall_add.')),
            ),

            h('div', { className: 'nw-set-section' },
              h('div', { className: 'nw-set-section-title' }, t('动效', 'Motion')),
              row(t('启用界面动效', 'Enable interface motion'), draft.motion,
                function (value) { patchField('motion', value) }),
            ),
          ),
          h('div', { className: 'nw-set-foot' },
            h('button', {
              type: 'button',
              className: 'nw-mini nw-mini-danger',
              disabled: busy,
              onClick: props.onReset,
            }, t('恢复默认', 'Restore defaults')),
            h('div', { className: 'nw-set-foot-actions' },
              h('button', {
                type: 'button',
                className: 'nw-mini',
                disabled: busy,
                onClick: props.onClose,
              }, t('取消', 'Cancel')),
              h('button', {
                type: 'button',
                className: 'nw-mini nw-mini-primary',
                disabled: busy,
                onClick: submit,
              }, busy ? t('保存中…', 'Saving…') : t('保存设置', 'Save settings')),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------------
    // shell.overlay reminder surface
    // ---------------------------------------------------------------------------

    function ReminderOverlay(props) {
      const t = useText(props && props.ctx)
      const [settings, setSettings] = React.useState(function () { return settingsCache })
      const [due, setDue] = React.useState([])
      const [error, setError] = React.useState('')
      const tRef = React.useRef(t)
      const settingsRef = React.useRef(settings)
      const notifiedRef = React.useRef({})
      const dismissedRef = React.useRef({})
      const aliveRef = React.useRef(true)
      const active = globalAlarmActive(settings)

      React.useEffect(function () {
        tRef.current = t
      }, [t])

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      function adoptSettings(value) {
        const next = normalizeClientSettings(value)
        settingsRef.current = next
        settingsCache = next
        setSettings(function (current) {
          return JSON.stringify(current) === JSON.stringify(next) ? current : next
        })
      }

      // Read the Host settings once on mount and follow page-side saves through
      // the module-level event. Nothing here runs a timer until the alarm is on.
      React.useEffect(function () {
        let cancelled = false
        function onSettingsEvent(event) {
          if (cancelled) return
          adoptSettings(event && event.detail)
        }
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener(SETTINGS_EVENT, onSettingsEvent)
          }
        } catch (eventError) {
          // The initial settings read below is still enough to gate everything.
        }
        apiCall('settings')
          .then(function (value) {
            if (!cancelled) adoptSettings(value && value.settings)
          })
          .catch(function () {
            // An unreadable settings document means "off": never alert silently.
          })
        return function () {
          cancelled = true
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
              window.removeEventListener(SETTINGS_EVENT, onSettingsEvent)
            }
          } catch (eventError) {}
        }
      }, [])

      React.useEffect(function () {
        if (active) return
        setDue([])
        setError('')
      }, [active])

      React.useEffect(function () {
        if (!active) return function () {}
        let cancelled = false
        const startedAt = Date.now()
        let timer = null

        async function tick(first) {
          let stateValue
          let settingsValue
          try {
            const results = await Promise.all([apiCall('state'), apiCall('settings')])
            stateValue = results[0]
            settingsValue = results[1] && results[1].settings
          } catch (requestError) {
            return
          }
          if (cancelled) return
          if (settingsValue !== undefined) adoptSettings(settingsValue)
          const current = normalizeClientSettings(settingsValue !== undefined ? settingsValue : settingsRef.current)
          if (!globalAlarmActive(current)) return
          const nowMs = Date.now()
          const notes = stateValue && Array.isArray(stateValue.notes) ? stateValue.notes : []
          const catchUp = current.reminders.overdue === true
          const dueNotes = notes.filter(function (note) {
            if (!isReminderDue(note, nowMs)) return false
            if (dismissedRef.current[reminderKey(note)] === true) return false
            if (first && !catchUp) {
              const dueMs = Date.parse(note.remindAt)
              return Number.isFinite(dueMs) && dueMs > startedAt
            }
            return true
          })
          setDue(dueNotes)
          const fresh = dueNotes.filter(function (note) {
            return notifiedRef.current[reminderKey(note)] !== true
          })
          if (fresh.length === 0) return
          for (const note of fresh) notifiedRef.current[reminderKey(note)] = true
          if (shouldPlayReminderSound(current)) playReminderSound(current.reminders.volume)
          if (shouldNotifyReminder(current)) {
            for (const note of fresh) showReminderNotification(note, tRef.current)
          }
        }

        void tick(true)
        timer = setInterval(function () { void tick(false) }, REMINDER_INTERVAL_MS)
        return function () {
          cancelled = true
          clearInterval(timer)
        }
      }, [active])

      async function completeNote(note) {
        setError('')
        try {
          await apiCall('update', { id: note.id, remindAt: '' })
          if (!aliveRef.current) return
          dismissedRef.current[reminderKey(note)] = true
          setDue(function (current) {
            return current.filter(function (item) { return item.id !== note.id })
          })
          publishNotesChanged()
        } catch (completeError) {
          if (aliveRef.current) {
            setError(t('提醒没能清除，请稍后再试。', 'Could not clear that reminder; try again.'))
          }
        }
      }

      async function completeAll() {
        const target = due.slice()
        if (target.length === 0) return
        setError('')
        const failed = {}
        let cleared = 0
        for (const note of target) {
          try {
            await apiCall('update', { id: note.id, remindAt: '' })
            dismissedRef.current[reminderKey(note)] = true
            cleared += 1
          } catch (completeError) {
            failed[note.id] = true
          }
        }
        if (!aliveRef.current) return
        if (cleared > 0) publishNotesChanged()
        setDue(function (current) {
          return current.filter(function (item) { return failed[item.id] === true })
        })
        if (Object.keys(failed).length > 0) {
          setError(t('有提醒没能清除，请稍后再试。', 'Some reminders could not be cleared; try again.'))
        }
      }

      function dismissAll() {
        for (const note of due) dismissedRef.current[reminderKey(note)] = true
        setDue([])
        setError('')
      }

      if (!active || due.length === 0) return null
      const banner = settings.globalAlarm.mode === 'banner'
      return h(React.Fragment, null,
        h('style', { key: 'reminder-css' }, OVERLAY_CSS),
        h('div', {
          key: 'reminder-layer',
          className: 'nw-ov-layer' + (banner ? ' nw-ov-banner' : ''),
          role: 'region',
          'aria-label': t('便签提醒', 'Note reminders'),
          'aria-live': 'polite',
        },
          h('div', { className: 'nw-ov-card' },
            h('div', { className: 'nw-ov-head' },
              h('span', { className: 'nw-ov-title' },
                h(ClockGlyph, { size: 14 }),
                h('span', null, t('便签提醒', 'Note reminders')),
                h('span', { className: 'nw-ov-count' }, String(due.length)),
              ),
              h('button', {
                type: 'button',
                className: 'nw-ov-btn',
                'aria-label': t('稍后再说', 'Dismiss'),
                title: t('稍后再说', 'Dismiss'),
                onClick: dismissAll,
              }, h(CloseGlyph, { size: 13 })),
            ),
            error ? h('p', { className: 'nw-ov-error', role: 'alert' }, error) : null,
            h('ul', { className: 'nw-ov-list' }, due.map(function (note) {
              return h('li', { key: reminderKey(note), className: 'nw-ov-item nw-ov-item-due' },
                h('div', { className: 'nw-ov-item-body' },
                  h('p', { className: 'nw-ov-item-text' }, note.text),
                  h('span', { className: 'nw-ov-item-time' }, formatReminderTime(note.remindAt, undefined)),
                ),
                h('button', {
                  type: 'button',
                  className: 'nw-ov-btn nw-ov-btn-primary',
                  onClick: function () { void completeNote(note) },
                }, t('完成', 'Done')),
              )
            })),
            h('div', { className: 'nw-ov-actions' },
              h('button', { type: 'button', className: 'nw-ov-btn', onClick: dismissAll },
                t('稍后再说', 'Later')),
              h('button', {
                type: 'button',
                className: 'nw-ov-btn nw-ov-btn-primary',
                onClick: function () { void completeAll() },
              }, t('全部完成', 'Complete all')),
            ),
          ),
        ),
      )
    }

    function NoteWallPage(props) {
      const ctx = props.ctx
      const t = useText(ctx)
      const activeLocale = useLocaleActive(ctx)
      const colorScheme = useColorScheme(ctx)
      const [notes, setNotes] = React.useState([])
      const [limits, setLimits] = React.useState(DEFAULT_LIMITS)
      const [status, setStatus] = React.useState('loading')
      const [loadError, setLoadError] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [draftTag, setDraftTag] = React.useState('')
      const [draftLink, setDraftLink] = React.useState('')
      const [tone, setTone] = React.useState(function () { return readPrefs().tone })
      const [motion, setMotion] = React.useState(function () { return readPrefs().motion })
      const [query, setQuery] = React.useState('')
      const [filterTone, setFilterTone] = React.useState('all')
      const [filterTag, setFilterTag] = React.useState('all')
      const [notice, setNotice] = React.useState('')
      const [composeFile, setComposeFile] = React.useState(null)
      const [composePreview, setComposePreview] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [now, setNow] = React.useState(function () { return Date.now() })
      const [signatureOpen, setSignatureOpen] = React.useState(false)
      // `initialSettings` exists so a test can render the page with a feature on
      // without a Host; the live page always replaces it with the fetched value.
      const [settings, setSettings] = React.useState(function () {
        return props.initialSettings === undefined
          ? normalizeClientSettings(DEFAULT_CLIENT_SETTINGS)
          : normalizeClientSettings(props.initialSettings)
      })
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [settingsBusy, setSettingsBusy] = React.useState(null)
      const [settingsLoadError, setSettingsLoadError] = React.useState('')
      const [settingsError, setSettingsError] = React.useState('')
      const [settingsNotice, setSettingsNotice] = React.useState('')
      const [folders, setFolders] = React.useState([])
      const [filterFolder, setFilterFolder] = React.useState('all')
      const [folderPanelOpen, setFolderPanelOpen] = React.useState(false)
      const [newFolderName, setNewFolderName] = React.useState('')
      const [renamingFolderId, setRenamingFolderId] = React.useState('')
      const [renameFolderValue, setRenameFolderValue] = React.useState('')
      const [deletingFolderId, setDeletingFolderId] = React.useState('')
      const [selectionMode, setSelectionMode] = React.useState(false)
      const [selected, setSelected] = React.useState({})
      const [selectionFolderId, setSelectionFolderId] = React.useState('')
      const [draftRemindAt, setDraftRemindAt] = React.useState('')
      const [categoryHistory, setCategoryHistory] = React.useState(readCategoryHistory)
      const textareaRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const colorInputRef = React.useRef(null)
      const searchRef = React.useRef(null)
      const importRef = React.useRef(null)
      const signatureButtonRef = React.useRef(null)
      const signatureCloseRef = React.useRef(null)
      const settingsButtonRef = React.useRef(null)
      const settingsCloseRef = React.useRef(null)
      const settingsWasOpenRef = React.useRef(false)
      const signatureWasOpenRef = React.useRef(false)
      const signatureTapsRef = React.useRef([])
      const aliveRef = React.useRef(true)
      const limitsRef = React.useRef(DEFAULT_LIMITS)
      const loadSeqRef = React.useRef(0)
      const hasDataRef = React.useRef(false)
      const pendingRef = React.useRef(false)
      const tRef = React.useRef(t)
      const composePreviewRef = React.useRef('')
      const editPreviewRef = React.useRef('')
      const settingsRef = React.useRef(DEFAULT_CLIENT_SETTINGS)
      const motionRef = React.useRef(motion)
      const toneRef = React.useRef(tone)
      settingsRef.current = settings
      motionRef.current = motion
      toneRef.current = tone

      const foldersEnabled = featureEnabled(settings, 'folders')
      const remindersEnabled = featureEnabled(settings, 'reminders')
      const categoryHistoryEnabled = featureEnabled(settings, 'categoryHistory')
      const folderNames = React.useMemo(function () {
        const map = {}
        for (const folder of folders) map[folder.id] = folder.name
        return map
      }, [folders])

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      React.useEffect(function () {
        return function () {
          revokeObjectUrl(composePreviewRef.current)
          revokeObjectUrl(editPreviewRef.current)
          composePreviewRef.current = ''
          editPreviewRef.current = ''
        }
      }, [])

      React.useEffect(function () {
        tRef.current = t
      }, [t])

      React.useEffect(function () {
        const controller = new AbortController()
        const loadId = loadSeqRef.current + 1
        loadSeqRef.current = loadId
        setStatus(function (current) { return hasDataRef.current ? current : 'loading' })
        setLoadError('')
        apiCall('state', null, controller.signal)
          .then(function (value) {
            if (loadSeqRef.current !== loadId) return
            if (value && Array.isArray(value.notes)) {
              accept(value)
            } else {
              setStatus('error')
              setLoadError(errorText(tRef.current, { code: 'bad-response' }, limitsRef.current))
            }
          })
          .catch(function (error) {
            if (loadSeqRef.current !== loadId || (error && error.name === 'AbortError')) return
            const message = errorText(tRef.current, error, limitsRef.current)
            if (hasDataRef.current) {
              setActionError(message)
            } else {
              setStatus('error')
              setLoadError(message)
            }
          })
        return function () { controller.abort() }
      }, [reloadKey])

      // Settings load in parallel with the notes. A failed read falls back to
      // the all-off defaults (safe: nothing is scheduled or shown) and leaves a
      // visible banner instead of silently pretending the features are on.
      React.useEffect(function () {
        const controller = new AbortController()
        apiCall('settings', null, controller.signal)
          .then(function (value) {
            if (!aliveRef.current) return
            const next = normalizeClientSettings(value && value.settings)
            setSettings(next)
            setSettingsLoadError('')
            setMotion(next.motion)
            writePrefs({ motion: next.motion, tone: toneRef.current })
            publishSettings(next)
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return
            if (!aliveRef.current) return
            const fallback = normalizeClientSettings(null)
            setSettings(fallback)
            setSettingsLoadError(errorText(tRef.current, error, limitsRef.current))
          })
        return function () { controller.abort() }
      }, [reloadKey])

      // The overlay can clear a reminder while the wall page is open; refresh
      // the visible notes so the chip disappears without another user action.
      React.useEffect(function () {
        function onNotesChanged() {
          setReloadKey(function (value) { return value + 1 })
        }
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener(NOTES_EVENT, onNotesChanged)
          }
        } catch (error) {
          // Without the event the page still shows the chip until its next action.
        }
        return function () {
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
              window.removeEventListener(NOTES_EVENT, onNotesChanged)
            }
          } catch (error) {}
        }
      }, [])

      React.useEffect(function () {
        const element = textareaRef.current
        if (element && typeof element.focus === 'function') element.focus()
      }, [])

      React.useEffect(function () {
        const timer = setInterval(function () {
          if (aliveRef.current) setNow(Date.now())
        }, CLOCK_INTERVAL_MS)
        return function () { clearInterval(timer) }
      }, [])

      React.useEffect(function () {
        if (signatureOpen) {
          signatureWasOpenRef.current = true
          if (signatureCloseRef.current && typeof signatureCloseRef.current.focus === 'function') {
            signatureCloseRef.current.focus()
          }
          return
        }
        if (signatureWasOpenRef.current) {
          signatureWasOpenRef.current = false
          if (signatureButtonRef.current && typeof signatureButtonRef.current.focus === 'function') {
            signatureButtonRef.current.focus()
          }
        }
      }, [signatureOpen])

      React.useEffect(function () {
        if (!signatureOpen) return function () {}
        function onSignatureKeyDown(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setSignatureOpen(false)
        }
        document.addEventListener('keydown', onSignatureKeyDown)
        return function () { document.removeEventListener('keydown', onSignatureKeyDown) }
      }, [signatureOpen])

      React.useEffect(function () {
        if (settingsOpen) {
          settingsWasOpenRef.current = true
          setSettingsError('')
          setSettingsNotice('')
          if (settingsCloseRef.current && typeof settingsCloseRef.current.focus === 'function') {
            settingsCloseRef.current.focus()
          }
          return
        }
        if (settingsWasOpenRef.current) {
          settingsWasOpenRef.current = false
          if (settingsButtonRef.current && typeof settingsButtonRef.current.focus === 'function') {
            settingsButtonRef.current.focus()
          }
        }
      }, [settingsOpen])

      React.useEffect(function () {
        if (!settingsOpen) return function () {}
        function onSettingsKeyDown(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setSettingsOpen(false)
        }
        document.addEventListener('keydown', onSettingsKeyDown)
        return function () { document.removeEventListener('keydown', onSettingsKeyDown) }
      }, [settingsOpen])

      // Turning folders off hides every folder affordance but keeps the data.
      React.useEffect(function () {
        if (foldersEnabled) return
        setFilterFolder('all')
        setFolderPanelOpen(false)
        setSelectionMode(false)
        setSelected({})
        setDeletingFolderId('')
        setRenamingFolderId('')
      }, [foldersEnabled])

      React.useEffect(function () {
        if (!foldersEnabled) return
        if (filterFolder === 'all' || filterFolder === '') return
        if (folders.some(function (folder) { return folder.id === filterFolder })) return
        setFilterFolder('all')
      }, [foldersEnabled, filterFolder, folders])

      React.useEffect(function () {
        if (!foldersEnabled) return
        if (selectionFolderId === '') return
        if (folders.some(function (folder) { return folder.id === selectionFolderId })) return
        setSelectionFolderId('')
      }, [foldersEnabled, selectionFolderId, folders])

      React.useEffect(function () {
        if (!categoryHistoryEnabled) return
        const limit = categoryHistorySize(settings.categoryHistory.limit)
        setCategoryHistory(function (current) {
          if (current.length <= limit) return current
          const next = current.slice(0, limit)
          writeCategoryHistory(next)
          return next
        })
      }, [categoryHistoryEnabled, settings.categoryHistory.limit])

      const tags = React.useMemo(function () {
        const seen = new Set()
        const values = []
        for (const note of notes) {
          if (typeof note.tag !== 'string' || note.tag.length === 0 || seen.has(note.tag)) continue
          seen.add(note.tag)
          values.push(note.tag)
        }
        return values.sort(function (left, right) { return left.localeCompare(right) })
      }, [notes])

      const visibleNotes = React.useMemo(function () {
        return filterNotes(notes, {
          query: query,
          tone: filterTone,
          tag: filterTag,
          folderId: foldersEnabled ? filterFolder : 'all',
        })
      }, [notes, query, filterTone, filterTag, foldersEnabled, filterFolder])

      const activeFilters = query.trim().length > 0
        || filterTone !== 'all'
        || filterTag !== 'all'
        || (foldersEnabled && filterFolder !== 'all')

      const exportHref = React.useMemo(function () {
        return 'data:application/json;charset=utf-8,' + encodeURIComponent(serializeNotes(notes))
      }, [notes])

      React.useEffect(function () {
        if (filterTag !== 'all' && tags.indexOf(filterTag) < 0) setFilterTag('all')
      }, [filterTag, tags])

      React.useEffect(function () {
        function onSearchShortcut(event) {
          if (event.defaultPrevented) return
          if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
          event.preventDefault()
          if (searchRef.current && typeof searchRef.current.focus === 'function') searchRef.current.focus()
        }
        document.addEventListener('keydown', onSearchShortcut)
        return function () { document.removeEventListener('keydown', onSearchShortcut) }
      }, [])

      function accept(value) {
        if (!value || !Array.isArray(value.notes)) return
        if (value.limits && typeof value.limits === 'object') {
          const next = {
            maxNotes: Number(value.limits.maxNotes) || DEFAULT_LIMITS.maxNotes,
            maxNoteChars: Number(value.limits.maxNoteChars) || DEFAULT_LIMITS.maxNoteChars,
            maxTagChars: Number(value.limits.maxTagChars) || DEFAULT_LIMITS.maxTagChars,
            maxLinkChars: Number(value.limits.maxLinkChars) || DEFAULT_LIMITS.maxLinkChars,
            maxImageBytes: Number(value.limits.maxImageBytes) || DEFAULT_LIMITS.maxImageBytes,
            maxFolders: Number(value.limits.maxFolders) || DEFAULT_LIMITS.maxFolders,
            maxFolderNameChars: Number(value.limits.maxFolderNameChars) || DEFAULT_LIMITS.maxFolderNameChars,
          }
          limitsRef.current = next
          setLimits(next)
        }
        setNotes(value.notes)
        if (Array.isArray(value.folders)) setFolders(normalizeFolders(value.folders))
        setStatus('ready')
        setLoadError('')
        hasDataRef.current = true
      }

      function beginPending(kind) {
        pendingRef.current = true
        setPending(kind)
        setActionError('')
        setNotice('')
      }

      function endPending() {
        pendingRef.current = false
        if (aliveRef.current) setPending(null)
      }

      function validateImageFile(file) {
        if (!file) return ''
        if (IMAGE_TYPES.indexOf(file.type) < 0) {
          return t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.')
        }
        if (file.size > limitsRef.current.maxImageBytes) {
          const limit = formatBytes(limitsRef.current.maxImageBytes)
          return t('图片不能超过 ' + limit + '。', 'Images are limited to ' + limit + '.')
        }
        return ''
      }

      function setToneValue(next) {
        const normalized = String(next || '').toLowerCase()
        if (!isValidTone(normalized)) return
        setTone(normalized)
        writePrefs({ motion: motionRef.current, tone: normalized })
      }

      function rememberCategory(tag) {
        if (!featureEnabled(settingsRef.current, 'categoryHistory')) return
        const value = typeof tag === 'string' ? tag.trim() : ''
        if (value.length === 0) return
        const limit = settingsRef.current.categoryHistory.limit
        setCategoryHistory(function (current) {
          const next = nextCategoryHistory(current, value, limit)
          writeCategoryHistory(next)
          return next
        })
      }

      async function saveSettings(patch) {
        if (settingsBusy !== null) return
        if (!patch || Object.keys(patch).length === 0) {
          setSettingsNotice(t('没有需要保存的修改。', 'Nothing to save.'))
          return
        }
        if (patch.reminders && patch.reminders.notifications === true) requestNotificationPermission()
        setSettingsBusy('save')
        setSettingsError('')
        setSettingsNotice('')
        try {
          const value = await apiCall('settingsUpdate', patch)
          if (!aliveRef.current) return
          const next = normalizeClientSettings(value && value.settings)
          setSettings(next)
          setSettingsLoadError('')
          setMotion(next.motion)
          writePrefs({ motion: next.motion, tone: toneRef.current })
          publishSettings(next)
          setSettingsNotice(t('设置已保存。', 'Settings saved.'))
        } catch (error) {
          if (aliveRef.current) setSettingsError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          if (aliveRef.current) setSettingsBusy(null)
        }
      }

      async function resetSettings() {
        if (settingsBusy !== null) return
        setSettingsBusy('reset')
        setSettingsError('')
        setSettingsNotice('')
        try {
          const value = await apiCall('settingsReset')
          if (!aliveRef.current) return
          const next = normalizeClientSettings(value && value.settings)
          setSettings(next)
          setSettingsLoadError('')
          setMotion(next.motion)
          writePrefs({ motion: next.motion, tone: toneRef.current })
          publishSettings(next)
          setSettingsNotice(t('已恢复默认设置。', 'Defaults restored.'))
        } catch (error) {
          if (aliveRef.current) setSettingsError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          if (aliveRef.current) setSettingsBusy(null)
        }
      }

      async function toggleMotion() {
        if (settingsBusy !== null) return
        const next = !motion
        setSettingsBusy('motion')
        try {
          const value = await apiCall('settingsUpdate', { motion: next })
          if (!aliveRef.current) return
          const saved = normalizeClientSettings(value && value.settings)
          setSettings(saved)
          setSettingsLoadError('')
          setMotion(saved.motion)
          writePrefs({ motion: saved.motion, tone: toneRef.current })
          publishSettings(saved)
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          if (aliveRef.current) setSettingsBusy(null)
        }
      }

      async function addFolder(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const name = newFolderName.trim()
        if (name.length === 0 || pendingRef.current) return
        beginPending('folder-add')
        try {
          const value = await apiCall('folderAdd', { name: name })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setNewFolderName('')
          setNotice(t('已新建文件夹。', 'Folder created.'))
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      function beginRenameFolder(folder) {
        setDeletingFolderId('')
        setRenamingFolderId(folder.id)
        setRenameFolderValue(folder.name)
      }

      async function renameFolder(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const id = renamingFolderId
        const name = renameFolderValue.trim()
        if (id.length === 0 || name.length === 0 || pendingRef.current) return
        beginPending('folder-rename')
        try {
          const value = await apiCall('folderRename', { id: id, name: name })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setRenamingFolderId('')
          setRenameFolderValue('')
          setNotice(t('文件夹已重命名。', 'Folder renamed.'))
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      async function removeFolder(folder) {
        if (pendingRef.current) return
        beginPending('folder-remove')
        try {
          const value = await apiCall('folderRemove', { id: folder.id })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setDeletingFolderId('')
          if (filterFolder === folder.id) setFilterFolder('all')
          if (selectionFolderId === folder.id) setSelectionFolderId('')
          setNotice(t('文件夹已删除，里面的便签回到未分类。', 'Folder deleted; its notes are uncategorized again.'))
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      function toggleSelectionMode() {
        setSelectionMode(function (current) { return !current })
        setSelected({})
      }

      function toggleSelected(note) {
        setSelected(function (current) {
          const next = Object.assign({}, current)
          if (next[note.id]) delete next[note.id]
          else next[note.id] = true
          return next
        })
      }

      async function moveSelected() {
        const ids = Object.keys(selected)
        if (ids.length === 0 || pendingRef.current) return
        beginPending('move')
        try {
          const value = await apiCall('moveNotes', { ids: ids, folderId: selectionFolderId })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setSelected({})
          setSelectionMode(false)
          setNotice(t('已移入文件夹。', 'Notes moved.'))
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(tRef.current, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      function clearFilters() {
        setQuery('')
        setFilterTone('all')
        setFilterTag('all')
        setFilterFolder('all')
      }

      function openImport() {
        if (importRef.current) importRef.current.click()
      }

      async function onImportFile(event) {
        const files = event.target.files
        const file = files && files.length > 0 ? files[0] : null
        event.target.value = ''
        if (!file || pendingRef.current) return
        beginPending('import')
        let imported = 0
        let lastValue
        try {
          const raw = await file.text()
          const parsed = parseImportPayload(raw, limitsRef.current)
          if (parsed.notes.length === 0) {
            setActionError(t('没有可导入的便签。', 'No valid notes to import.'))
            return
          }
          for (const note of parsed.notes) {
            lastValue = await apiCall('add', {
              text: note.text,
              tag: note.tag,
              tone: note.tone,
              link: note.link,
              image: '',
            })
            imported += 1
          }
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(lastValue)
          setNotice(t(
            '已导入 ' + imported + ' 条便签' + (parsed.skipped > 0 ? '，跳过 ' + parsed.skipped + ' 条无效记录' : '') + '。',
            'Imported ' + imported + ' note' + (imported === 1 ? '' : 's') + (parsed.skipped > 0 ? ', skipped ' + parsed.skipped + ' invalid' : '') + '.',
          ))
        } catch (error) {
          if (lastValue && aliveRef.current) {
            loadSeqRef.current += 1
            accept(lastValue)
          }
          if (aliveRef.current) {
            const prefix = imported > 0 ? t('已导入 ' + imported + ' 条，之后失败：', imported + ' imported, then failed: ') : ''
            setActionError(prefix + errorText(t, error, limitsRef.current))
          }
        } finally {
          endPending()
        }
      }

      function openSignature() {
        signatureTapsRef.current = []
        setSignatureOpen(true)
      }

      function closeSignature() {
        signatureTapsRef.current = []
        setSignatureOpen(false)
      }

      function onSignatureClick(event) {
        if (signatureOpen) {
          closeSignature()
          return
        }
        // A keyboard-generated click (Enter/Space) opens immediately; the
        // three-tap rule is only for pointer input.
        if (event && event.detail === 0) {
          openSignature()
          return
        }
        const result = signatureTap(signatureTapsRef.current, Date.now(), SIGNATURE_CLICK_WINDOW_MS)
        signatureTapsRef.current = result.taps
        if (result.opened) openSignature()
      }

      function setComposeAttachment(file) {
        const problem = validateImageFile(file)
        if (problem) {
          setActionError(problem)
          return
        }
        revokeObjectUrl(composePreviewRef.current)
        const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
        composePreviewRef.current = url
        setComposeFile(file)
        setComposePreview(url)
      }

      function clearComposeAttachment() {
        revokeObjectUrl(composePreviewRef.current)
        composePreviewRef.current = ''
        setComposeFile(null)
        setComposePreview('')
      }

      function pickComposeImage() {
        if (fileRef.current) fileRef.current.click()
      }

      function onComposeFilePicked(event) {
        const files = event.target.files
        const file = files && files.length > 0 ? files[0] : null
        event.target.value = ''
        if (file) setComposeAttachment(file)
      }

      function onComposePaste(event) {
        const data = event.clipboardData
        if (!data || !data.files) return
        for (let index = 0; index < data.files.length; index += 1) {
          const file = data.files[index]
          if (file && typeof file.type === 'string' && file.type.indexOf('image/') === 0) {
            event.preventDefault()
            setComposeAttachment(file)
            return
          }
        }
      }

      function onComposeDragOver(event) {
        const types = event.dataTransfer && event.dataTransfer.types
        if (!types || types.length === 0) return
        // Claim every drop over the composer so a non-image drop cannot navigate
        // the page away and discard the draft.
        event.preventDefault()
        for (let index = 0; index < types.length; index += 1) {
          if (types[index] === 'Files') {
            setDragging(true)
            return
          }
        }
      }

      function onComposeDragLeave() {
        setDragging(false)
      }

      function onComposeDrop(event) {
        // Always claim the drop; only supported images are attached.
        event.preventDefault()
        setDragging(false)
        const files = event.dataTransfer && event.dataTransfer.files
        if (!files || files.length === 0) return
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          if (file && typeof file.type === 'string' && file.type.indexOf('image/') === 0) {
            setComposeAttachment(file)
            return
          }
        }
        setActionError(t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.'))
      }

      function revokeEditPreview() {
        revokeObjectUrl(editPreviewRef.current)
        editPreviewRef.current = ''
      }

      function attachEditImage(file) {
        if (editing === null || !file) return
        const problem = validateImageFile(file)
        if (problem) {
          setActionError(problem)
          return
        }
        revokeEditPreview()
        const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
        editPreviewRef.current = url
        setEditing(Object.assign({}, editing, { imageFile: file, imagePreview: url, imageTouched: true }))
      }

      function clearEditImage() {
        if (editing === null) return
        revokeEditPreview()
        setEditing(Object.assign({}, editing, { imageFile: null, imagePreview: '', image: '', imageTouched: true }))
      }

      async function addNote(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const text = draft.trim()
        if (text.length === 0 || pendingRef.current) return
        const remindersOn = featureEnabled(settingsRef.current, 'reminders')
        const remindInput = remindersOn ? draftRemindAt.trim() : ''
        const remindAt = fromLocalDateTimeInput(remindInput)
        if (remindInput.length > 0 && remindAt.length === 0) {
          setActionError(t('提醒时间无法识别。', 'That reminder time is not valid.'))
          return
        }
        if (remindAt.length > 0 && shouldNotifyReminder(settingsRef.current)) requestNotificationPermission()
        const tag = draftTag.trim()
        beginPending('add')
        let uploadedId = ''
        try {
          if (composeFile) {
            const uploaded = await uploadImage(composeFile)
            if (!uploaded || typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
              throw Object.assign(new Error('bad upload response'), { code: 'bad-response' })
            }
            uploadedId = uploaded.id
          }
          const value = await apiCall('add', {
            text: text,
            tag: tag,
            tone: tone,
            link: draftLink.trim(),
            image: uploadedId,
            remindAt: remindAt,
          })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          rememberCategory(tag)
          setDraft('')
          setDraftTag('')
          setDraftLink('')
          setDraftRemindAt('')
          clearComposeAttachment()
          if (textareaRef.current && typeof textareaRef.current.focus === 'function') textareaRef.current.focus()
        } catch (error) {
          if (uploadedId) void apiCall('discardImage', { id: uploadedId }).catch(function () {})
          if (aliveRef.current) setActionError(errorText(t, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      function beginEdit(note) {
        revokeEditPreview()
        setConfirming(null)
        setEditing({
          id: note.id,
          text: note.text,
          tag: note.tag || '',
          tone: note.tone,
          link: note.link || '',
          image: note.image || '',
          imageFile: null,
          imagePreview: '',
          imageTouched: false,
          remindAt: note.remindAt || '',
          remindInput: toLocalDateTimeInput(note.remindAt || ''),
          remindTouched: false,
          baseUpdatedAt: note.updatedAt,
        })
      }

      function cancelEdit() {
        revokeEditPreview()
        setEditing(null)
      }

      /**
       * A stale editor is recoverable: reload the wall, adopt the newest revision
       * (and image unless the user changed it locally), then let the user save
       * again instead of locking them out with the same conflict forever.
       */
      async function recoverFromConflict(noteId) {
        try {
          const value = await apiCall('state')
          if (!aliveRef.current) return
          accept(value)
          const latest = value && Array.isArray(value.notes)
            ? value.notes.find(function (item) { return item && item.id === noteId })
            : undefined
          if (!latest) {
            revokeEditPreview()
            setEditing(null)
            setActionError(t('这条便签已在别处删除。', 'That note was deleted elsewhere.'))
            return
          }
          setEditing(function (current) {
            if (!current || current.id !== noteId) return current
            return Object.assign({}, current, {
              baseUpdatedAt: latest.updatedAt,
              image: current.imageTouched ? current.image : latest.image,
              remindAt: current.remindTouched ? current.remindAt : (latest.remindAt || ''),
              remindInput: current.remindTouched ? current.remindInput : toLocalDateTimeInput(latest.remindAt || ''),
            })
          })
          setActionError(t(
            '这条便签已在别处修改。已同步最新版本，再点「保存」会覆盖为你现在的内容。',
            'This note changed elsewhere. The latest version is loaded; saving again will overwrite it with your text.',
          ))
        } catch (refreshError) {
          if (aliveRef.current) {
            setActionError(t(
              '这条便签已在别处修改。请关闭并重新打开编辑，或刷新页面后再试。',
              'This note changed elsewhere. Close and reopen the editor, or reload the page.',
            ))
          }
        }
      }

      async function saveEdit() {
        if (editing === null || pendingRef.current) return
        const text = editing.text.trim()
        if (text.length === 0) {
          setActionError(t('便签内容不能为空。', 'A note cannot be empty.'))
          return
        }
        const remindersOn = featureEnabled(settingsRef.current, 'reminders')
        const remindInput = remindersOn && typeof editing.remindInput === 'string' ? editing.remindInput.trim() : ''
        const remindAt = remindersOn ? fromLocalDateTimeInput(remindInput) : (editing.remindAt || '')
        if (remindersOn && remindInput.length > 0 && remindAt.length === 0) {
          setActionError(t('提醒时间无法识别。', 'That reminder time is not valid.'))
          return
        }
        if (remindAt.length > 0 && shouldNotifyReminder(settingsRef.current)) requestNotificationPermission()
        const savedTag = editing.tag.trim()
        beginPending('save')
        let uploadedId = ''
        try {
          let imageId = editing.image || ''
          if (editing.imageFile) {
            const uploaded = await uploadImage(editing.imageFile)
            if (!uploaded || typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
              throw Object.assign(new Error('bad upload response'), { code: 'bad-response' })
            }
            uploadedId = uploaded.id
            imageId = uploaded.id
          }
          const value = await apiCall('update', {
            id: editing.id,
            text: text,
            tag: savedTag,
            tone: editing.tone,
            link: editing.link.trim(),
            image: imageId,
            remindAt: remindAt,
            baseUpdatedAt: editing.baseUpdatedAt,
          })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          rememberCategory(savedTag)
          revokeEditPreview()
          setEditing(null)
        } catch (error) {
          if (uploadedId) void apiCall('discardImage', { id: uploadedId }).catch(function () {})
          if (aliveRef.current) {
            if (error && error.code === 'note-conflict' && editing !== null) {
              await recoverFromConflict(editing.id)
            } else {
              setActionError(errorText(t, error, limitsRef.current))
            }
          }
        } finally {
          endPending()
        }
      }

      async function removeNote(note) {
        if (pendingRef.current) return
        beginPending('delete')
        try {
          const value = await apiCall('remove', { id: note.id })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setConfirming(null)
          if (editing !== null && editing.id === note.id) {
            revokeEditPreview()
            setEditing(null)
          }
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(t, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      const canAdd = draft.trim().length > 0 && pending === null
      const selectedCount = Object.keys(selected).length
      const countText = notes.length === 0
        ? t('还没有便签', 'No notes yet')
        : activeFilters
          ? t('显示 ' + visibleNotes.length + ' / 共 ' + notes.length + ' 条', visibleNotes.length + ' of ' + notes.length + ' notes')
          : t('共 ' + notes.length + ' 条便签', notes.length + (notes.length === 1 ? ' note' : ' notes'))

      return h('div', {
        className: 'nw-root' + (motion ? ' nw-motion' : '') + (colorScheme === 'dark' ? ' nw-dark' : ''),
      },
        h(Styles, { key: 'styles' }),
        h('div', { className: 'nw-page' },
          h('header', { className: 'nw-head', key: 'head' },
            h('div', null,
              h('h2', { className: 'nw-title' }, t('灵感便签墙', 'Inspiration wall')),
              h('p', { className: 'nw-sub' },
                t('随手记下，等它长成下一个想法。', 'Capture it now — let it grow into the next idea.'),
              ),
            ),
            h('div', { className: 'nw-head-tools' },
              status === 'ready' ? h('span', { className: 'nw-count' }, countText) : null,
              h('button', {
                type: 'button',
                className: 'nw-motion-toggle' + (motion ? ' nw-motion-on' : ''),
                'aria-pressed': motion,
                disabled: settingsBusy !== null,
                title: t('切换便签动效', 'Toggle note motion'),
                onClick: toggleMotion,
              },
                h(SparkleGlyph, { size: 14 }),
                h('span', null, t('动效', 'Motion')),
                h('span', { className: 'nw-motion-dot', 'aria-hidden': 'true' }),
              ),
              h('button', {
                type: 'button',
                className: 'nw-motion-toggle',
                ref: settingsButtonRef,
                'aria-haspopup': 'dialog',
                'aria-expanded': settingsOpen,
                'aria-controls': SETTINGS_PANEL_ID,
                title: t('便签墙设置', 'Note wall settings'),
                onClick: function () { setSettingsOpen(true) },
              },
                h(GearGlyph, { size: 14 }),
                h('span', null, t('设置', 'Settings')),
              ),
            ),
          ),
          h('form', {
            className: 'nw-compose' + toneClass(tone) + (dragging ? ' nw-compose-dragging' : ''),
            style: toneStyle(tone),
            key: 'compose',
            onSubmit: addNote,
            onPaste: onComposePaste,
            onDragOver: onComposeDragOver,
            onDragLeave: onComposeDragLeave,
            onDrop: onComposeDrop,
          },
            h('textarea', {
              ref: textareaRef,
              className: 'nw-compose-input',
              value: draft,
              rows: 3,
              maxLength: limits.maxNoteChars,
              placeholder: t('写下你的下一个灵感…', 'Write down your next idea…'),
              'aria-label': t('新便签内容', 'New note text'),
              onChange: function (event) { setDraft(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void addNote(event)
                }
              },
            }),
            composeFile
              ? h('div', { className: 'nw-compose-preview', key: 'attach' },
                  composePreview
                    ? h('img', { className: 'nw-preview-thumb', src: composePreview, alt: '' })
                    : h('span', { className: 'nw-preview-thumb', 'aria-hidden': 'true' }),
                  h('div', { className: 'nw-preview-meta' },
                    h('span', { className: 'nw-preview-name' }, composeFile.name || t('图片', 'Image')),
                    h('span', null, formatBytes(composeFile.size)),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'nw-iconbtn',
                    title: t('移除图片', 'Remove image'),
                    'aria-label': t('移除图片', 'Remove image'),
                    onClick: clearComposeAttachment,
                  }, h(CloseGlyph, { size: 14 })),
                )
              : null,
            h('div', { className: 'nw-compose-foot' },
              h('div', { className: 'nw-palette', role: 'group', 'aria-label': t('便签颜色', 'Note color') },
                TONES.map(function (definition) {
                  const name = toneName(t, definition)
                  return h('button', {
                    key: definition.key,
                    type: 'button',
                    className: 'nw-swatch nw-tone-' + definition.key + (tone === definition.key ? ' nw-swatch-selected' : ''),
                    'aria-label': name,
                    'aria-pressed': tone === definition.key,
                    title: name,
                    onClick: function () { setToneValue(definition.key) },
                  })
                }),
                h('button', {
                  key: 'custom',
                  type: 'button',
                  className: 'nw-swatch nw-swatch-custom' + (isCustomTone(tone) ? ' nw-swatch-selected' : ''),
                  style: isCustomTone(tone) ? { '--nw-custom': tone } : undefined,
                  'aria-label': t('自定义颜色', 'Custom color'),
                  'aria-pressed': isCustomTone(tone),
                  title: t('自定义颜色', 'Custom color'),
                  onClick: function () { if (colorInputRef.current) colorInputRef.current.click() },
                }),
                h('input', {
                  ref: colorInputRef,
                  type: 'color',
                  className: 'nw-file-input',
                  value: isCustomTone(tone) ? tone : '#f0c24b',
                  'aria-label': t('自定义颜色', 'Custom color'),
                  onChange: function (event) { setToneValue(event.target.value) },
                }),
              ),
              h('input', {
                className: 'nw-tag-input',
                type: 'text',
                value: draftTag,
                maxLength: limits.maxTagChars,
                placeholder: t('分类（可选）', 'Category (optional)'),
                'aria-label': t('分类（可选）', 'Category (optional)'),
                onChange: function (event) { setDraftTag(event.target.value) },
              }),
              h('div', { className: 'nw-link-field' },
                h(LinkGlyph, { size: 13 }),
                h('input', {
                  className: 'nw-link-input',
                  type: 'text',
                  value: draftLink,
                  maxLength: limits.maxLinkChars,
                  placeholder: t('链接（可选）', 'Link (optional)'),
                  'aria-label': t('链接（可选）', 'Link (optional)'),
                  onChange: function (event) { setDraftLink(event.target.value) },
                }),
              ),
              remindersEnabled
                ? h('div', { className: 'nw-remind-field' },
                    h(ClockGlyph, { size: 13 }),
                    h('input', {
                      className: 'nw-remind-input',
                      type: 'datetime-local',
                      value: draftRemindAt,
                      'aria-label': t('提醒时间', 'Reminder time'),
                      onChange: function (event) { setDraftRemindAt(event.target.value) },
                    }),
                    draftRemindAt.length > 0
                      ? h('button', {
                          type: 'button',
                          className: 'nw-iconbtn',
                          title: t('清除提醒', 'Clear reminder'),
                          'aria-label': t('清除提醒', 'Clear reminder'),
                          onClick: function () { setDraftRemindAt('') },
                        }, h(CloseGlyph, { size: 13 }))
                      : null,
                  )
                : null,
              h('button', {
                type: 'button',
                className: 'nw-attach-btn',
                title: t('添加图片（也可粘贴或拖入）', 'Attach an image (or paste/drop one)'),
                'aria-label': t('添加图片', 'Attach image'),
                onClick: pickComposeImage,
              },
                h(ImageGlyph, { size: 15 }),
                h('span', null, t('图片', 'Image')),
              ),
              h('input', {
                ref: fileRef,
                type: 'file',
                className: 'nw-file-input',
                accept: IMAGE_TYPES.join(','),
                onChange: onComposeFilePicked,
              }),
              h('div', { className: 'nw-compose-actions' },
                h('span', { className: 'nw-kbd', 'aria-hidden': 'true' }, '⌘/Ctrl + Enter'),
                h('button', { type: 'submit', className: 'nw-add', disabled: !canAdd },
                  h(PlusGlyph, { size: 14 }),
                  h('span', null, pending === 'add' ? t('添加中…', 'Adding…') : t('添加到墙上', 'Add to the wall')),
                ),
              ),
            ),
            categoryHistoryEnabled && categoryHistory.length > 0
              ? h('div', { className: 'nw-cat-history', role: 'group', 'aria-label': t('最近使用的分类', 'Recent categories') },
                  h('span', { className: 'nw-cat-label' }, t('最近分类', 'Recent')),
                  categoryHistory.map(function (tag) {
                    return h('button', {
                      key: tag,
                      type: 'button',
                      className: 'nw-cat-chip',
                      title: t('使用分类「' + tag + '」', 'Use category "' + tag + '"'),
                      onClick: function () { setDraftTag(tag) },
                    }, tag)
                  }),
                )
              : null,
          ),
          h('div', { className: 'nw-toolbar', key: 'toolbar' },
            h('input', {
              ref: searchRef,
              className: 'nw-search',
              type: 'search',
              value: query,
              placeholder: t('搜索便签（正文 / 标签 / 链接）', 'Search notes (text / tag / link)'),
              'aria-label': t('搜索便签', 'Search notes'),
              onChange: function (event) { setQuery(event.target.value) },
              onKeyDown: function (event) {
                if (event.key !== 'Escape') return
                if (query.length > 0) {
                  event.preventDefault()
                  setQuery('')
                } else if (typeof event.currentTarget.blur === 'function') {
                  event.currentTarget.blur()
                }
              },
            }),
            h('select', {
              className: 'nw-filter',
              value: filterTone,
              'aria-label': t('按颜色筛选', 'Filter by color'),
              onChange: function (event) { setFilterTone(event.target.value) },
            },
              h('option', { value: 'all' }, t('全部颜色', 'All colors')),
              TONES.map(function (definition) {
                return h('option', { key: definition.key, value: definition.key }, toneName(t, definition))
              }),
              h('option', { value: 'custom' }, t('自定义色', 'Custom colors')),
            ),
            h('select', {
              className: 'nw-filter',
              value: filterTag,
              'aria-label': t('按分类筛选', 'Filter by category'),
              onChange: function (event) { setFilterTag(event.target.value) },
            },
              h('option', { value: 'all' }, t('全部分类', 'All categories')),
              tags.map(function (tag) {
                return h('option', { key: tag, value: tag }, tag)
              }),
            ),
            foldersEnabled
              ? h('select', {
                  className: 'nw-filter',
                  value: filterFolder,
                  'aria-label': t('按文件夹筛选', 'Filter by folder'),
                  onChange: function (event) { setFilterFolder(event.target.value) },
                },
                  h('option', { value: 'all' }, t('全部文件夹', 'All folders')),
                  h('option', { value: '' }, t('未分类', 'Uncategorized')),
                  folders.map(function (folder) {
                    return h('option', { key: folder.id, value: folder.id }, folder.name)
                  }),
                )
              : null,
            foldersEnabled
              ? h('button', {
                  type: 'button',
                  className: 'nw-mini' + (folderPanelOpen ? ' nw-mini-primary' : ''),
                  'aria-expanded': folderPanelOpen,
                  'aria-pressed': folderPanelOpen,
                  title: t('管理文件夹', 'Manage folders'),
                  onClick: function () {
                    setFolderPanelOpen(function (current) { return !current })
                    setDeletingFolderId('')
                    setRenamingFolderId('')
                  },
                }, h(FolderGlyph, { size: 13 }), h('span', null, t('文件夹', 'Folders')))
              : null,
            foldersEnabled
              ? h('button', {
                  type: 'button',
                  className: 'nw-mini' + (selectionMode ? ' nw-mini-primary' : ''),
                  'aria-pressed': selectionMode,
                  title: t('多选便签并移入文件夹', 'Select notes and move them into a folder'),
                  onClick: toggleSelectionMode,
                }, selectionMode ? t('退出选择', 'Done selecting') : t('选择', 'Select'))
              : null,
            activeFilters
              ? h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: clearFilters,
                }, t('清除筛选', 'Clear filters'))
              : null,
            h('div', { className: 'nw-toolbar-actions' },
              h('a', {
                className: 'nw-mini nw-export',
                href: exportHref,
                download: 'dsh-note-wall-notes.json',
                title: t('导出便签 JSON（不含图片文件，不是完整备份）', 'Export notes as JSON (image files not included; not a full backup)'),
              }, t('导出 JSON', 'Export JSON')),
              h('button', {
                type: 'button',
                className: 'nw-mini',
                disabled: pending !== null,
                onClick: openImport,
              }, t('导入 JSON', 'Import JSON')),
              h('input', {
                ref: importRef,
                type: 'file',
                className: 'nw-file-input',
                accept: 'application/json,.json',
                onChange: onImportFile,
              }),
            ),
          ),
          foldersEnabled && folderPanelOpen
            ? h('div', {
                className: 'nw-folder-panel',
                role: 'region',
                'aria-label': t('文件夹管理', 'Folder management'),
                key: 'folders',
              },
                h('form', { className: 'nw-folder-form', onSubmit: addFolder },
                  h('input', {
                    className: 'nw-folder-input',
                    type: 'text',
                    value: newFolderName,
                    maxLength: limits.maxFolderNameChars,
                    disabled: pending !== null,
                    placeholder: t('新文件夹名称', 'New folder name'),
                    'aria-label': t('新文件夹名称', 'New folder name'),
                    onChange: function (event) { setNewFolderName(event.target.value) },
                  }),
                  h('button', {
                    type: 'submit',
                    className: 'nw-mini nw-mini-primary',
                    disabled: newFolderName.trim().length === 0 || pending !== null,
                  }, pending === 'folder-add' ? t('新建中…', 'Creating…') : t('新建', 'Create')),
                ),
                folders.length === 0
                  ? h('div', { className: 'nw-folder-empty' }, t('还没有文件夹。', 'No folders yet.'))
                  : null,
                folders.map(function (folder) {
                  if (renamingFolderId === folder.id) {
                    return h('form', { key: folder.id, className: 'nw-folder-row', onSubmit: renameFolder },
                      h('input', {
                        className: 'nw-folder-input',
                        type: 'text',
                        value: renameFolderValue,
                        maxLength: limits.maxFolderNameChars,
                        disabled: pending !== null,
                        'aria-label': t('文件夹名称', 'Folder name'),
                        onChange: function (event) { setRenameFolderValue(event.target.value) },
                      }),
                      h('button', { type: 'submit', className: 'nw-mini nw-mini-primary', disabled: pending !== null },
                        t('保存', 'Save')),
                      h('button', {
                        type: 'button',
                        className: 'nw-mini',
                        disabled: pending !== null,
                        onClick: function () { setRenamingFolderId(''); setRenameFolderValue('') },
                      }, t('取消', 'Cancel')),
                    )
                  }
                  if (deletingFolderId === folder.id) {
                    return h('div', { key: folder.id, className: 'nw-folder-row' },
                      h('span', { className: 'nw-folder-name' }, folder.name),
                      h('span', { className: 'nw-folder-empty' }, t('删除后便签回到未分类', 'Notes move to Uncategorized')),
                      h('button', {
                        type: 'button',
                        className: 'nw-mini',
                        disabled: pending !== null,
                        onClick: function () { setDeletingFolderId('') },
                      }, t('取消', 'Cancel')),
                      h('button', {
                        type: 'button',
                        className: 'nw-mini nw-mini-danger',
                        disabled: pending !== null,
                        onClick: function () { void removeFolder(folder) },
                      }, pending === 'folder-remove' ? t('删除中…', 'Deleting…') : t('确认删除', 'Confirm delete')),
                    )
                  }
                  return h('div', { key: folder.id, className: 'nw-folder-row' },
                    h('span', { className: 'nw-folder-name', title: folder.name }, folder.name),
                    h('button', {
                      type: 'button',
                      className: 'nw-mini',
                      disabled: pending !== null,
                      onClick: function () { beginRenameFolder(folder) },
                    }, t('重命名', 'Rename')),
                    h('button', {
                      type: 'button',
                      className: 'nw-mini nw-mini-danger',
                      disabled: pending !== null,
                      onClick: function () {
                        setRenamingFolderId('')
                        setDeletingFolderId(folder.id)
                      },
                    }, t('删除', 'Delete')),
                  )
                }),
              )
            : null,
          foldersEnabled && selectionMode
            ? h('div', {
                className: 'nw-select-bar',
                role: 'region',
                'aria-label': t('批量移动到文件夹', 'Move notes to a folder'),
                key: 'selection',
              },
                h('span', null, t('已选 ' + selectedCount + ' 条', selectedCount + ' selected')),
                h('select', {
                  value: selectionFolderId,
                  disabled: pending !== null,
                  'aria-label': t('目标文件夹', 'Target folder'),
                  onChange: function (event) { setSelectionFolderId(event.target.value) },
                },
                  h('option', { value: '' }, t('未分类', 'Uncategorized')),
                  folders.map(function (folder) {
                    return h('option', { key: folder.id, value: folder.id }, folder.name)
                  }),
                ),
                h('button', {
                  type: 'button',
                  className: 'nw-mini nw-mini-primary',
                  disabled: selectedCount === 0 || pending !== null,
                  onClick: moveSelected,
                }, pending === 'move' ? t('移入中…', 'Moving…') : t('移入', 'Move')),
              )
            : null,
          settingsLoadError
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert', key: 'settings-load-error' },
                h('span', { className: 'nw-banner-text' },
                  t('设置读取失败，已使用默认设置（新功能全部关闭）：', 'Could not read settings; using defaults (new features off): ')
                    + settingsLoadError,
                ),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setReloadKey(function (value) { return value + 1 }) },
                }, t('重试', 'Retry')),
              )
            : null,
          actionError
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert', key: 'action-error' },
                h('span', { className: 'nw-banner-text' }, actionError),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setActionError('') },
                }, t('关闭', 'Dismiss')),
              )
            : null,
          notice
            ? h('div', { className: 'nw-banner nw-banner-success', role: 'status', key: 'notice' },
                h('span', { className: 'nw-banner-text' }, notice),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setNotice('') },
                }, t('关闭', 'Dismiss')),
              )
            : null,
          status === 'loading'
            ? h('div', { className: 'nw-loading', key: 'loading' },
                h('span', { className: 'nw-spinner', 'aria-hidden': 'true' }),
                h('span', null, t('正在读取便签…', 'Loading notes…')),
              )
            : null,
          status === 'error'
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert', key: 'load-error' },
                h('span', { className: 'nw-banner-text' }, loadError),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setReloadKey(function (value) { return value + 1 }) },
                }, t('重试', 'Retry')),
              )
            : null,
          status === 'ready' && notes.length === 0 ? h(EmptyWall, { key: 'empty', t: t }) : null,
          status === 'ready' && notes.length > 0 && visibleNotes.length === 0
            ? h('div', { className: 'nw-empty', key: 'no-match' },
                h('div', { className: 'nw-empty-title' }, t('没有匹配的便签', 'No matching notes')),
                h('div', { className: 'nw-empty-hint' }, t('换个关键词，或清除筛选。', 'Try another search or clear the filters.')),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: clearFilters,
                }, t('清除筛选', 'Clear filters')),
              )
            : null,
          status === 'ready' && visibleNotes.length > 0
            ? h('div', { className: 'nw-grid', key: 'grid' },
                visibleNotes.map(function (note) {
                  return h(NoteCard, {
                    key: note.id,
                    note: note,
                    now: now,
                    t: t,
                    locale: activeLocale,
                    limits: limits,
                    pending: pending,
                    editing: editing !== null && editing.id === note.id ? editing : null,
                    confirming: confirming === note.id,
                    imageDisplay: settings.imageDisplay,
                    remindersEnabled: remindersEnabled,
                    folderName: foldersEnabled && note.folderId ? (folderNames[note.folderId] || '') : '',
                    selectable: foldersEnabled && selectionMode,
                    selected: selected[note.id] === true,
                    onToggleSelect: toggleSelected,
                    onChangeEdit: setEditing,
                    onBeginEdit: beginEdit,
                    onCancelEdit: cancelEdit,
                    onSaveEdit: saveEdit,
                    onCancelDelete: function () { setConfirming(null) },
                    onDelete: removeNote,
                    onAskDelete: function () { setConfirming(note.id) },
                    onEditImageFile: attachEditImage,
                    onClearEditImage: clearEditImage,
                  })
                }),
              )
            : null,
          h('footer', { className: 'nw-page-foot', key: 'signature' },
            h('div', { className: 'nw-signature-wrap' },
              h('button', {
                type: 'button',
                className: 'nw-signature',
                'aria-label': t('关于作者', 'About the author'),
                'aria-haspopup': 'dialog',
                'aria-expanded': signatureOpen,
                'aria-controls': SIGNATURE_PANEL_ID,
                title: t('关于作者', 'About the author'),
                ref: signatureButtonRef,
                onClick: onSignatureClick,
              },
                h('span', { className: 'nw-signature-mark', 'aria-hidden': 'true' }),
                h('span', null, 'dream-office'),
              ),
              signatureOpen
                ? h('div', {
                    id: SIGNATURE_PANEL_ID,
                    role: 'dialog',
                    className: 'nw-signature-pop',
                    'aria-label': t('关于作者', 'About the author'),
                  },
                    h('p', { className: 'nw-signature-quote' }, t(SIGNATURE_QUOTE_ZH, SIGNATURE_QUOTE_EN)),
                    h('button', {
                      type: 'button',
                      className: 'nw-iconbtn nw-signature-close',
                      'aria-label': t('关闭', 'Close'),
                      title: t('关闭', 'Close'),
                      ref: signatureCloseRef,
                      onClick: closeSignature,
                    }, h(CloseGlyph, { size: 14 })),
                  )
                : null,
            ),
          ),
          settingsOpen
            ? h(SettingsPanel, {
                key: 'settings',
                settings: settings,
                t: t,
                busy: settingsBusy !== null,
                error: settingsError,
                notice: settingsNotice,
                closeButtonRef: settingsCloseRef,
                onSave: saveSettings,
                onReset: resetSettings,
                onClose: function () { setSettingsOpen(false) },
              })
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h(NoteGlyph, { size: size })
    }

    function apply(ctx) {
      printSignatureConsole()
      function label() {
        return isZhLocale(ctx) ? '便签墙' : 'Note wall'
      }

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'note-wall',
          order: 30,
          label: label,
        }, PanelIcon)
      })

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'note-wall',
        }, function NoteWallMain(props) {
          return h(NoteWallPage, Object.assign({}, props, { ctx: ctx }))
        })
      })

      // v1.2.0 reminder surface: the host's `shell.overlay` slot, never
      // document.body/head. The component itself returns null unless the user
      // enabled reminders AND the global alarm, so a disabled install renders
      // no content and runs no timer.
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: REMINDER_OVERLAY_ID,
          order: 500,
        }, function NoteWallReminderOverlay() {
          return h(ReminderOverlay, { ctx: ctx })
        })
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
