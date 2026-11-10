import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

// Loads the real hand-written client bundle in a sandbox. The test-only hook
// exposes the pure search/filter/import/export helpers and NoteCard so this
// file can verify behavior without a browser or a React dependency.
async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value },
      },
      __DSH_NOTE_WALL_TEST__: {},
    },
    console: { info() {}, warn() {}, error() {} },
    URL,
    Date,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  assert.ok(definition, 'client bundle should register a module')

  function createElement(type, props) {
    const children = []
    for (let index = 2; index < arguments.length; index += 1) {
      const child = arguments[index]
      if (Array.isArray(child)) children.push(...child.flat(Infinity))
      else if (child !== null && child !== undefined && child !== false) children.push(child)
    }
    return { type: type, props: props || {}, children: children }
  }
  const fakeReact = {
    createElement: createElement,
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, function () {}] },
    useEffect() {},
    useSyncExternalStore() { return 'zh' },
  }
  const module = definition.factory(function (id) {
    if (id === 'react') return fakeReact
    throw new Error('unexpected require: ' + id)
  })
  return { module: module, hook: sandbox.window.__DSH_NOTE_WALL_TEST__ }
}

function collect(node, output) {
  const result = output || []
  if (node === null || node === undefined || typeof node !== 'object') return result
  result.push(node)
  for (const child of node.children || []) collect(child, result)
  return result
}

function byClass(nodes, className) {
  return nodes.find(function (node) {
    return node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).indexOf(className) >= 0
  })
}

const client = await loadClient()
const hook = client.hook

function baseProps(note, editing) {
  const noop = function () {}
  return {
    note: note,
    editing: editing || null,
    now: Date.parse(note.createdAt),
    t: function (zh) { return zh },
    locale: 'zh',
    limits: hook.DEFAULT_LIMITS,
    pending: null,
    confirming: false,
    onChangeEdit: noop,
    onBeginEdit: noop,
    onCancelEdit: noop,
    onSaveEdit: noop,
    onCancelDelete: noop,
    onDelete: noop,
    onAskDelete: noop,
    onEditImageFile: noop,
    onClearEditImage: noop,
    onToggleSelect: noop,
  }
}

function sampleNote(overrides) {
  return Object.assign({
    id: 'note-a',
    text: '给项目画头像',
    tag: '示例',
    tone: 'mint',
    link: '',
    image: '',
    folderId: '',
    remindAt: '',
    createdAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
  }, overrides || {})
}

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(hook.DEFAULT_CLIENT_SETTINGS))
}

// Values returned from the vm sandbox carry that realm's prototypes, so copy
// them into this realm before deep comparisons.
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

const IMAGE_ID = '11111111-1111-4111-8111-111111111111.png'

test('search matches text, tag and link; filters stack', () => {
  const notes = [
    sampleNote({ id: 'a', text: '给项目画头像', tag: '示例', tone: 'mint', link: 'https://github.com/' }),
    sampleNote({ id: 'b', text: '买牛奶', tag: '生活', tone: 'amber', link: '' }),
    sampleNote({ id: 'c', text: '设计稿', tag: '示例', tone: '#123456', link: 'https://example.com/x' }),
  ]
  const ids = function (filters) { return hook.filterNotes(notes, filters).map(function (note) { return note.id }) }

  assert.deepEqual(ids({ query: '项目' }), ['a'])
  assert.deepEqual(ids({ query: 'github' }), ['a'])
  assert.deepEqual(ids({ query: '生活' }), ['b'])
  assert.deepEqual(ids({ tone: 'mint' }), ['a'])
  assert.deepEqual(ids({ tone: 'custom' }), ['c'])
  assert.deepEqual(ids({ tag: '示例' }), ['a', 'c'])
  assert.deepEqual(ids({ query: '设计', tag: '示例' }), ['c'])
  assert.deepEqual(ids({ query: 'x', tone: 'amber' }), [])
})

test('export/import JSON round-trips notes and skips invalid records', () => {
  const notes = [
    sampleNote({ id: 'a', text: '第一条', tag: '示例', tone: 'mint', link: 'https://example.com/x' }),
    sampleNote({ id: 'b', text: '第二条', tag: '', tone: '#123456', link: '' }),
  ]
  const raw = hook.serializeNotes(notes)
  const parsed = JSON.parse(raw)
  assert.equal(parsed.app, 'dsh-note-wall')
  assert.equal(parsed.version, 1)
  assert.equal(parsed.notes.length, 2)
  assert.equal(parsed.notes[0].image, undefined, 'JSON export intentionally omits image ids')

  const imported = hook.parseImportPayload(raw, hook.DEFAULT_LIMITS)
  assert.equal(imported.skipped, 0)
  assert.deepEqual(
    Array.from(imported.notes, function (note) { return { text: note.text, tag: note.tag, tone: note.tone, link: note.link } }),
    [
      { text: '第一条', tag: '示例', tone: 'mint', link: 'https://example.com/x' },
      { text: '第二条', tag: '', tone: '#123456', link: '' },
    ],
  )

  const mixed = JSON.stringify({
    notes: [
      { text: '' },
      { text: '保留' },
      { text: '坏色', tone: 'magenta' },
      { text: '坏链接', link: 'javascript:alert(1)' },
    ],
  })
  const filtered = hook.parseImportPayload(mixed, hook.DEFAULT_LIMITS)
  assert.deepEqual(
    Array.from(filtered.notes, function (note) { return { text: note.text, tag: note.tag, tone: note.tone, link: note.link } }),
    [{ text: '保留', tag: '', tone: 'amber', link: '' }],
  )
  assert.equal(filtered.skipped, 3)

  assert.throws(function () { hook.parseImportPayload('{', hook.DEFAULT_LIMITS) }, function (error) { return error.code === 'import-json' })
  assert.throws(function () { hook.parseImportPayload('{}', hook.DEFAULT_LIMITS) }, function (error) { return error.code === 'import-shape' })
})

test('cards render a fixed 96x96 thumbnail that links to the full image', () => {
  const note = sampleNote({ image: IMAGE_ID })
  const tree = hook.NoteCard(baseProps(note))
  const nodes = collect(tree)
  const thumb = byClass(nodes, 'nw-note-thumb')
  assert.ok(thumb, 'thumbnail link missing')
  assert.equal(thumb.props.style.width, 96)
  assert.equal(thumb.props.style.height, 96)
  assert.equal(thumb.props.href, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
  const image = collect(thumb).find(function (node) { return node.type === 'img' })
  assert.equal(image.props.src, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
  assert.equal(byClass(nodes, 'nw-note-image'), undefined, 'full-width image is not used')
  assert.equal(tree.props.tabIndex, 0)
  assert.match(tree.props['aria-label'], /给项目画头像/)
})

test('a note without an image has no thumbnail', () => {
  const nodes = collect(hook.NoteCard(baseProps(sampleNote())))
  assert.equal(byClass(nodes, 'nw-note-thumb'), undefined)
  assert.equal(byClass(nodes, 'nw-edit-image'), undefined)
})

test('edit mode keeps the full image preview instead of the thumbnail', () => {
  const note = sampleNote({ image: IMAGE_ID })
  const editing = {
    id: note.id,
    text: note.text,
    tag: note.tag,
    tone: note.tone,
    link: note.link,
    image: note.image,
    imageFile: null,
    imagePreview: '',
    imageTouched: false,
    baseUpdatedAt: note.updatedAt,
  }
  const nodes = collect(hook.NoteCard(baseProps(note, editing)))
  assert.equal(byClass(nodes, 'nw-note-thumb'), undefined)
  const preview = byClass(nodes, 'nw-edit-image')
  assert.ok(preview, 'edit preview missing')
  const image = collect(preview).find(function (node) { return node.type === 'img' })
  assert.equal(image.props.src, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
})

test('card actions remain usable by keyboard', () => {
  const tree = hook.NoteCard(baseProps(sampleNote()))
  const nodes = collect(tree)
  assert.equal(tree.props.tabIndex, 0)
  const controls = nodes.filter(function (node) {
    return node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).indexOf('nw-iconbtn') >= 0
  })
  assert.ok(controls.length >= 2, 'expected focusable edit/delete controls')
  for (const control of controls) {
    assert.equal(control.type, 'button')
    assert.equal(typeof control.props.onClick, 'function')
  }
})

test('image display modes: thumbnail default, compact icon, full-width large', () => {
  const note = sampleNote({ image: IMAGE_ID })

  const defaultTree = hook.NoteCard(baseProps(note))
  const thumbnail = byClass(collect(defaultTree), 'nw-note-thumb')
  assert.ok(thumbnail, 'default mode renders the thumbnail')
  assert.equal(thumbnail.props.style.width, 96)
  assert.equal(thumbnail.props.style.height, 96)

  const iconNodes = collect(hook.NoteCard(Object.assign(baseProps(note), { imageDisplay: 'icon' })))
  const icon = byClass(iconNodes, 'nw-note-thumb')
  assert.ok(icon, 'icon mode renders a compact thumbnail link')
  assert.equal(icon.props.style.width, 32)
  assert.equal(icon.props.style.height, 32)
  assert.equal(icon.props.href, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
  assert.match(icon.props.className, /nw-note-thumb-icon/)

  const largeNodes = collect(hook.NoteCard(Object.assign(baseProps(note), { imageDisplay: 'large' })))
  const large = byClass(largeNodes, 'nw-note-image')
  assert.ok(large, 'large mode renders the full-width preview')
  assert.equal(large.props.href, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
  const largeImage = collect(large).find(function (node) { return node.type === 'img' })
  assert.equal(largeImage.props.src, '/plugins/dsh-note-wall/image/' + IMAGE_ID)
  assert.equal(byClass(largeNodes, 'nw-note-thumb'), undefined, 'large mode does not also render a thumbnail')

  assert.equal(hook.resolveImageDisplay(undefined), 'thumbnail', 'missing setting falls back to thumbnail')
  assert.equal(hook.resolveImageDisplay({ imageDisplay: 'huge' }), 'thumbnail', 'invalid mode falls back to thumbnail')
  assert.equal(hook.resolveImageDisplay({ imageDisplay: 'large' }), 'large')
  assert.equal(hook.resolveImageDisplay('icon'), 'icon')
})

test('edit mode always shows the full preview regardless of the image display mode', () => {
  const note = sampleNote({ image: IMAGE_ID })
  const editing = {
    id: note.id,
    text: note.text,
    tag: note.tag,
    tone: note.tone,
    link: note.link,
    image: note.image,
    imageFile: null,
    imagePreview: '',
    imageTouched: false,
    remindAt: '',
    remindInput: '',
    remindTouched: false,
    baseUpdatedAt: note.updatedAt,
  }
  for (const imageDisplay of ['thumbnail', 'icon', 'large']) {
    const nodes = collect(hook.NoteCard(Object.assign(baseProps(note, editing), { imageDisplay: imageDisplay })))
    assert.equal(byClass(nodes, 'nw-note-thumb'), undefined, imageDisplay)
    assert.equal(byClass(nodes, 'nw-note-image'), undefined, imageDisplay)
    assert.ok(byClass(nodes, 'nw-edit-image'), 'edit preview missing for ' + imageDisplay)
  }
})

test('settings defaults keep every optional feature off except thumbnail images', () => {
  const defaults = hook.DEFAULT_CLIENT_SETTINGS
  assert.equal(defaults.imageDisplay, 'thumbnail')
  assert.equal(hook.featureEnabled(defaults, 'agentWrite'), false)
  assert.equal(hook.featureEnabled(defaults, 'categoryHistory'), false)
  assert.equal(hook.featureEnabled(defaults, 'folders'), false)
  assert.equal(hook.featureEnabled(defaults, 'reminders'), false)
  assert.equal(hook.featureEnabled(defaults, 'globalAlarm'), false)
  assert.equal(hook.globalAlarmActive(defaults), false)

  const enabled = hook.normalizeClientSettings({
    folders: { enabled: true },
    categoryHistory: { enabled: true, limit: 12 },
    reminders: { enabled: true, notifications: true },
    globalAlarm: { enabled: true, mode: 'banner' },
    imageDisplay: 'huge',
  })
  assert.equal(hook.featureEnabled(enabled, 'folders'), true)
  assert.equal(hook.featureEnabled(enabled, 'categoryHistory'), true)
  assert.equal(enabled.categoryHistory.limit, 12)
  assert.equal(hook.globalAlarmActive(enabled), true)
  assert.equal(enabled.imageDisplay, 'thumbnail', 'invalid stored image mode falls back')
})

test('settings patches only include changed fields accepted by the Host', () => {
  const current = cloneDefaultSettings()
  const draft = cloneDefaultSettings()
  draft.folders.enabled = true
  draft.reminders.volume = 0.3
  draft.imageDisplay = 'large'
  draft.agentWrite.enabled = true
  draft.futureField = 'ignored'

  assert.deepEqual(plain(hook.settingsPatch(current, draft)), {
    agentWrite: { enabled: true },
    folders: { enabled: true },
    reminders: { volume: 0.3 },
    imageDisplay: 'large',
  })
  assert.deepEqual(plain(hook.settingsPatch(current, cloneDefaultSettings())), {})
})

test('folder filter matches uncategorized and assigned notes and combines with search', () => {
  const notes = [
    sampleNote({ id: 'a', text: '甲', folderId: 'f1' }),
    sampleNote({ id: 'b', text: '乙', folderId: '' }),
    sampleNote({ id: 'c', text: '甲丙', folderId: 'f2' }),
  ]
  const ids = function (filters) {
    return hook.filterNotes(notes, filters).map(function (note) { return note.id })
  }
  assert.deepEqual(ids({ folderId: '' }), ['b'], 'uncategorized uses the empty folder id')
  assert.deepEqual(ids({ folderId: 'f1' }), ['a'])
  assert.deepEqual(ids({ folderId: 'all' }), ['a', 'b', 'c'])
  assert.deepEqual(ids({ query: '甲', folderId: 'f2' }), ['c'])
  assert.deepEqual(ids({ folderId: 'missing' }), [])

  const options = hook.folderFilterOptions([
    { id: 'f2', name: '生活' },
    { id: 'f1', name: '工作' },
    { id: '', name: 'bad' },
  ])
  assert.deepEqual(Array.from(options.map(function (option) { return option.id })), ['all', '', 'f2', 'f1'])
})

test('reminder datetime helpers round-trip local input values', () => {
  assert.equal(hook.toLocalDateTimeInput(''), '')
  assert.equal(hook.toLocalDateTimeInput('not a date'), '')
  assert.equal(hook.fromLocalDateTimeInput(''), '')
  assert.equal(hook.fromLocalDateTimeInput('nope'), '')
  assert.equal(hook.fromLocalDateTimeInput('2026-02-30T10:00'), '', 'rolled-over dates are rejected')

  const iso = '2026-11-10T04:30:00.000Z'
  const local = hook.toLocalDateTimeInput(iso)
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  assert.equal(hook.fromLocalDateTimeInput(local), iso)
  assert.equal(hook.toLocalDateTimeInput(hook.fromLocalDateTimeInput(local)), local)
})

test('reminder due and alert helpers respect every settings gate', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z')
  assert.equal(hook.isReminderDue(sampleNote({ remindAt: '2026-11-10T11:59:00.000Z' }), now), true)
  assert.equal(hook.isReminderDue(sampleNote({ remindAt: '2026-11-10T12:01:00.000Z' }), now), false)
  assert.equal(hook.isReminderDue(sampleNote({ remindAt: '' }), now), false)
  assert.equal(hook.isReminderDue(null, now), false)

  const off = cloneDefaultSettings()
  assert.equal(hook.globalAlarmActive(off), false)
  assert.equal(hook.shouldNotifyReminder(off), false)
  assert.equal(hook.shouldPlayReminderSound(off), false)

  const on = hook.normalizeClientSettings({
    reminders: { enabled: true, sound: true, notifications: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  assert.equal(hook.globalAlarmActive(on), true)
  assert.equal(hook.shouldNotifyReminder(on), true)
  assert.equal(hook.shouldPlayReminderSound(on), true)

  const silent = hook.normalizeClientSettings({
    reminders: { enabled: true, sound: true, notifications: true },
    globalAlarm: { enabled: true, mode: 'silent' },
  })
  assert.equal(hook.globalAlarmActive(silent), false)
  assert.equal(hook.shouldNotifyReminder(silent), false)
  assert.equal(hook.shouldPlayReminderSound(silent), false)

  const noGlobal = hook.normalizeClientSettings({
    reminders: { enabled: true, sound: true, notifications: true },
    globalAlarm: { enabled: false, mode: 'overlay' },
  })
  assert.equal(hook.shouldNotifyReminder(noGlobal), false)

  const notificationsOff = hook.normalizeClientSettings({
    reminders: { enabled: true, sound: false, notifications: false },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  assert.equal(hook.shouldNotifyReminder(notificationsOff), false)
  assert.equal(hook.shouldPlayReminderSound(notificationsOff), false)
})

test('category history dedupes, trims and keeps the configured limit', () => {
  assert.deepEqual(plain(hook.nextCategoryHistory([], '甲', 4)), ['甲'])
  assert.deepEqual(plain(hook.nextCategoryHistory(['乙', '甲'], '甲', 4)), ['甲', '乙'])
  assert.deepEqual(plain(hook.nextCategoryHistory(['丙', '乙', '甲'], '丁', 3)), ['丁', '丙', '乙'])
  assert.deepEqual(plain(hook.nextCategoryHistory(['甲', '乙'], '', 4)), ['甲', '乙'])
  assert.deepEqual(plain(hook.nextCategoryHistory([' 甲 ', '甲'], '乙', 4)), ['乙', '甲'])
  assert.deepEqual(plain(hook.nextCategoryHistory(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'z', 2)), ['z', 'a'])
  assert.equal(hook.nextCategoryHistory(['a', 'b', 'c'], 'd', 0).length, 4, 'invalid limit falls back to the default 8 and keeps the short list')
})

test('cards show selection, folder and reminder UI only when enabled', () => {
  const note = sampleNote({
    folderId: 'f1',
    remindAt: '2026-11-10T11:00:00.000Z',
  })
  const props = Object.assign(baseProps(note), { now: Date.parse('2026-11-10T12:00:00Z') })

  const offNodes = collect(hook.NoteCard(props))
  assert.equal(offNodes.filter(function (node) {
    return node.type === 'input' && node.props.type === 'checkbox'
  }).length, 0, 'no selection checkbox while selection mode is off')
  assert.equal(byClass(offNodes, 'nw-note-folder'), undefined)
  assert.equal(byClass(offNodes, 'nw-note-remind'), undefined, 'reminder chips are hidden when reminders are off')

  const onTree = hook.NoteCard(Object.assign({}, props, {
    selectable: true,
    selected: true,
    folderName: '工作',
    remindersEnabled: true,
  }))
  const onNodes = collect(onTree)
  const checkbox = onNodes.find(function (node) {
    return node.type === 'input' && node.props.type === 'checkbox'
  })
  assert.ok(checkbox, 'selection checkbox missing')
  assert.equal(checkbox.props.checked, true)
  assert.equal(typeof checkbox.props.onChange, 'function')

  const folder = byClass(onNodes, 'nw-note-folder')
  assert.ok(folder, 'folder label missing')
  assert.match(JSON.stringify(folder.children), /工作/)

  const chip = byClass(onNodes, 'nw-note-remind')
  assert.ok(chip, 'reminder chip missing')
  assert.match(chip.props.className, /nw-note-remind-due/)

  const future = Object.assign({}, props, {
    note: sampleNote({ remindAt: '2026-11-10T13:00:00.000Z' }),
    remindersEnabled: true,
  })
  const futureChip = byClass(collect(hook.NoteCard(future)), 'nw-note-remind')
  assert.ok(futureChip)
  assert.doesNotMatch(futureChip.props.className, /nw-note-remind-due/)
})

test('the edit card only offers the reminder input when reminders are enabled', () => {
  const note = sampleNote()
  const editing = {
    id: note.id,
    text: note.text,
    tag: note.tag,
    tone: note.tone,
    link: note.link,
    image: note.image,
    imageFile: null,
    imagePreview: '',
    imageTouched: false,
    remindAt: '2026-11-10T12:00:00.000Z',
    remindInput: '2026-11-10T20:00',
    remindTouched: false,
    baseUpdatedAt: note.updatedAt,
  }
  const without = collect(hook.NoteCard(baseProps(note, editing)))
  assert.equal(without.filter(function (node) { return node.props && node.props.type === 'datetime-local' }).length, 0)

  const withReminders = collect(hook.NoteCard(Object.assign(baseProps(note, editing), { remindersEnabled: true })))
  const input = withReminders.find(function (node) { return node.props && node.props.type === 'datetime-local' })
  assert.ok(input, 'datetime-local reminder input missing')
  assert.equal(input.props.value, '2026-11-10T20:00')
})

function textContent(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return (node.children || []).map(textContent).join('')
}

test('with default settings the page hides folder UI and still exposes the settings entry', () => {
  const nodes = collect(hook.NoteWallPage({ ctx: undefined }))
  assert.equal(
    nodes.filter(function (node) { return node.props && node.props['aria-label'] === '按文件夹筛选' }).length,
    0,
    'folder filter must be hidden while folders are off',
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-select-bar') >= 0
    }).length,
    0,
    'selection bar must be hidden while folders are off',
  )
  assert.equal(
    nodes.filter(function (node) { return textContent(node).indexOf('文件夹') >= 0 }).length,
    0,
    'no folder management or selection affordance is rendered by default',
  )
  const settingsButton = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '设置'
  })
  assert.ok(settingsButton, 'the top-right settings entry should always be available')
  assert.equal(settingsButton.props['aria-haspopup'], 'dialog')
  assert.equal(settingsButton.props['aria-expanded'], false)

  // Reminders and category history are off too: no compose controls for them.
  assert.equal(
    nodes.filter(function (node) { return node.props && node.props.type === 'datetime-local' }).length,
    0,
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-cat-history') >= 0
    }).length,
    0,
  )
})

test('enabling folders adds the folder filter, manager and selection controls', () => {
  const nodes = collect(hook.NoteWallPage({
    ctx: undefined,
    initialSettings: hook.normalizeClientSettings({ folders: { enabled: true } }),
  }))
  assert.equal(
    nodes.filter(function (node) { return node.props && node.props['aria-label'] === '按文件夹筛选' }).length,
    1,
    'folder filter should appear when folders are enabled',
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.type === 'button' && textContent(node).indexOf('文件夹') >= 0
    }).length >= 1,
    true,
    'folder manager entry should appear',
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.type === 'button' && textContent(node) === '选择'
    }).length,
    1,
    'selection mode toggle should appear',
  )
})

// --- v1.2.0-C: complete backup ZIP, settings.section, first-use guide,
// --- and interval-level reminder gating -------------------------------------

function zh(text) {
  return text
}

function memoryStorage() {
  const memory = new Map()
  return {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }
}

function byId(nodes, id) {
  return nodes.find(function (node) { return node.props && node.props.id === id })
}

test('the client registers the settings.section page plus the existing surfaces', () => {
  const registrations = []
  const ctx = {
    locale: {
      getSnapshot() { return { active: 'zh' } },
      subscribe() { return function () {} },
    },
    slots: {
      inject(name, register) {
        register()
      },
      register(options, component) {
        registrations.push({ options, component })
        return function () {}
      },
    },
  }
  client.module.apply(ctx)

  function named(name) {
    return registrations.filter(function (entry) { return entry.options.name === name })
  }
  assert.equal(named('sidebar.panellist').length, 1)
  assert.equal(named('main').length, 1)
  assert.equal(named('shell.overlay').length, 1)

  const section = named('settings.section')
  assert.equal(section.length, 1, 'the note wall must register a settings page')
  assert.equal(section[0].options.id, 'note-wall')
  assert.equal(typeof section[0].options.label, 'function')
  assert.equal(section[0].options.label(), '便签墙', 'the label follows the active locale')
  assert.equal(typeof section[0].component, 'function')

  const rendered = section[0].component({ close: function () {} })
  assert.equal(rendered.type, hook.SettingsSection, 'the section renders the shared settings page')

  const icon = named('settings.section.icon')
  assert.equal(icon.length, 1)
  assert.equal(icon[0].options.id, 'note-wall', 'the icon id matches the section id')
  const iconElement = icon[0].component({ size: 16, active: false })
  assert.equal(typeof iconElement.type, 'function', 'the icon returns a glyph component element')
  const iconTree = iconElement.type(iconElement.props)
  assert.equal(iconTree.type, 'svg')
  assert.equal(iconTree.props.width, 16, 'the navigation row size is honoured')
})

test('the shared settings form edits the same controls as the settings panel', () => {
  const settings = cloneDefaultSettings()
  const draft = cloneDefaultSettings()
  draft.folders.enabled = true
  draft.reminders.notifications = true
  const saves = []
  const tree = hook.SettingsForm({
    settings: settings,
    draft: draft,
    t: zh,
    busy: false,
    onSave(patch) { saves.push(plain(patch)) },
    onReset() {},
  })
  const nodes = collect(tree)
  const text = nodes.map(textContent).join('\n')
  for (const label of ['分类历史', '文件夹', '提醒', '主界面 / 全局提醒', 'AI 写入', '动效']) {
    assert.ok(text.indexOf(label) >= 0, 'missing settings section: ' + label)
  }
  const rows = nodes.filter(function (node) {
    return node.type === 'label' && node.props.className === 'nw-set-row'
  })
  assert.ok(rows.length >= 6, 'every opt-in feature exposes a checkbox row')
  const save = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '保存设置'
  })
  assert.ok(save, 'save button missing')
  save.props.onClick({ preventDefault() {} })
  assert.deepEqual(saves, [{ folders: { enabled: true }, reminders: { notifications: true } }])
})

test('the settings page renders the shared form without the dialog chrome', () => {
  const sectionNode = hook.SettingsSection({
    initialSettings: hook.normalizeClientSettings({ folders: { enabled: true } }),
  })
  const nodes = collect(sectionNode)
  const page = nodes.find(function (node) {
    return node.props && node.props.className === 'nw-settings-page'
  })
  assert.ok(page, 'settings page root missing')
  assert.ok(nodes.some(function (node) { return node.type === hook.Styles }), 'the page carries its scoped stylesheet')
  assert.equal(nodes.filter(function (node) { return node.props && node.props.role === 'dialog' }).length, 0)
  const form = nodes.find(function (node) { return node.type === hook.SettingsForm })
  assert.ok(form, 'the settings page must render the shared SettingsForm')
  assert.equal(typeof form.props.onSave, 'function')
  assert.equal(typeof form.props.onReset, 'function')
  assert.equal(form.props.settings.folders.enabled, true, 'the page starts from the Host settings it was given')
  // The same component renders the dialog body, so the controls cannot drift.
  const dialogNodes = collect(hook.SettingsPanel({
    settings: cloneDefaultSettings(),
    t: zh,
    onSave() {},
    onReset() {},
    onClose() {},
  }))
  assert.ok(dialogNodes.some(function (node) { return node.type === hook.SettingsForm }))
})

test('the first-use guide explains the opt-in defaults and is remembered once dismissed', () => {
  const storage = memoryStorage()
  assert.equal(hook.ONBOARDING_KEY, 'dsh-note-wall:onboarding-v1')
  assert.equal(hook.onboardingSeen(storage), false, 'a fresh browser has not seen the guide')
  assert.equal(hook.onboardingSeen(null), true, 'a shell that cannot remember never nags')
  assert.equal(hook.markOnboardingSeen(storage), true)
  assert.equal(hook.onboardingSeen(storage), true, 'the guide never shows again once seen')

  const calls = []
  const nodes = collect(hook.OnboardingGuide({
    t: zh,
    onKeepOff() { calls.push('keep-off') },
    onOpenSettings() { calls.push('open-settings') },
  }))
  const dialog = byId(nodes, 'nw-onboarding-dialog')
  assert.ok(dialog, 'guide dialog missing')
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(typeof dialog.props['aria-labelledby'], 'string')
  const text = nodes.map(textContent).join('')
  assert.match(text, /默认关闭/)
  assert.match(text, /提醒/)
  assert.match(text, /全局提醒/)
  const keepOff = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '保持关闭'
  })
  const openSettings = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '去设置'
  })
  assert.ok(keepOff, '「保持关闭」button missing')
  assert.ok(openSettings, '「去设置」button missing')
  keepOff.props.onClick()
  openSettings.props.onClick()
  assert.deepEqual(calls, ['keep-off', 'open-settings'])
})

test('the note wall shows the first-use guide only on a first visit', () => {
  const firstVisit = collect(hook.NoteWallPage({ ctx: undefined, initialOnboardingSeen: false }))
  const guide = firstVisit.find(function (node) { return node.type === hook.OnboardingGuide })
  assert.ok(guide, 'a first visit must show the guide')
  assert.equal(typeof guide.props.onKeepOff, 'function')
  assert.equal(typeof guide.props.onOpenSettings, 'function')
  assert.ok(guide.props.primaryRef, 'the guide exposes a focus target for its primary action')

  const returned = collect(hook.NoteWallPage({ ctx: undefined, initialOnboardingSeen: true }))
  assert.equal(returned.some(function (node) { return node.type === hook.OnboardingGuide }), false, 'the guide is not shown again')
})

test('the toolbar offers the complete ZIP backup instead of the JSON export', () => {
  const nodes = collect(hook.NoteWallPage({ ctx: undefined }))
  const exportButton = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '完整备份 ZIP'
  })
  assert.ok(exportButton, 'complete backup ZIP export missing')
  assert.match(exportButton.props.title, /图片/)
  assert.match(exportButton.props.title, /设置/)
  const importButton = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '导入完整备份'
  })
  assert.ok(importButton, 'complete backup ZIP import missing')
  assert.equal(nodes.some(function (node) {
    return node.type === 'a' && node.props.download === 'dsh-note-wall-notes.json'
  }), false, 'the JSON-only export must be gone')
  const picker = nodes.find(function (node) {
    return node.props && node.props.type === 'file' && typeof node.props.accept === 'string' && node.props.accept.indexOf('.zip') >= 0
  })
  assert.ok(picker, 'the import picker must accept .zip files')
  assert.equal(hook.isZipFile({ name: 'note-wall-backup-20261110-220000.zip', type: '' }), true)
  assert.equal(hook.isZipFile({ name: 'notes.json', type: 'application/json' }), false)
})

test('backup helpers parse the archive name and build the import report', () => {
  assert.equal(
    hook.backupFilenameFromDisposition('attachment; filename="note-wall-backup-20260101-010101.zip"'),
    'note-wall-backup-20260101-010101.zip',
  )
  assert.equal(
    hook.backupFilenameFromDisposition("attachment; filename*=UTF-8''note-wall-backup-20260101-010101.zip"),
    'note-wall-backup-20260101-010101.zip',
  )
  assert.equal(hook.backupFilenameFromDisposition('inline'), '')
  assert.equal(hook.backupFilenameFromDisposition('attachment; filename="../../evil.zip"'), '', 'paths are never accepted')

  assert.equal(hook.backupRequestUrl(), '/plugins/dsh-note-wall/backup?settings=1')
  assert.equal(hook.backupRequestUrl({ includeSettings: false }), '/plugins/dsh-note-wall/backup?settings=0')
  assert.equal(hook.backupImportUrl('replace', true), '/plugins/dsh-note-wall/backup?mode=replace&applySettings=1')
  assert.equal(hook.backupImportUrl('weird', false), '/plugins/dsh-note-wall/backup?mode=merge&applySettings=0')

  const report = hook.backupReportText(zh, {
    mode: 'merge',
    importedNotes: 3,
    skippedNotes: 1,
    importedFolders: 2,
    imageCount: 4,
    settingsIncluded: true,
    settingsApplied: false,
    safetyBackup: 'note-wall-backup-20260101-010101.zip',
  })
  assert.match(report, /合并导入完成/)
  assert.match(report, /便签 3 条/)
  assert.match(report, /跳过 1 条/)
  assert.match(report, /文件夹 2 个/)
  assert.match(report, /图片 4 张/)
  assert.match(report, /设置保留当前值/)
  assert.match(report, /安全备份/)
})

test('the complete backup export requests the ZIP, names it and revokes the blob URL', async () => {
  const requests = []
  const created = []
  const revoked = []
  const timers = []
  const blob = { size: 12, type: 'application/zip' }
  const document = {
    createElement(tag) {
      const element = { tag: tag, clicked: false, click() { this.clicked = true } }
      created.push(element)
      return element
    },
  }
  const urlApi = {
    createObjectURL(value) {
      assert.equal(value, blob)
      return 'blob:note-wall-backup'
    },
    revokeObjectURL(value) { revoked.push(value) },
  }
  const fetch = async function (target, init) {
    requests.push({ target: target, init: init })
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-disposition'
            ? 'attachment; filename="note-wall-backup-20261110-220000.zip"'
            : null
        },
      },
      async blob() { return blob },
    }
  }

  const filename = await hook.downloadBackup({
    fetch: fetch,
    document: document,
    url: urlApi,
    setTimeout(fn) { timers.push(fn) },
  })
  assert.equal(filename, 'note-wall-backup-20261110-220000.zip')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].target, '/plugins/dsh-note-wall/backup?settings=1')
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[0].init.headers['x-dsh-note-wall'], '1')
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.equal(created.length, 1, 'only a temporary anchor is created')
  assert.equal(created[0].tag, 'a')
  assert.equal(created[0].href, 'blob:note-wall-backup')
  assert.equal(created[0].download, filename)
  assert.equal(created[0].clicked, true)
  assert.equal(revoked.length, 0, 'the object URL stays alive until the click settles')
  timers.forEach(function (fn) { fn() })
  assert.deepEqual(revoked, ['blob:note-wall-backup'])

  await hook.downloadBackup({
    fetch: fetch,
    document: document,
    url: urlApi,
    setTimeout(fn) { timers.push(fn) },
    includeSettings: false,
  })
  assert.match(requests[1].target, /settings=0$/)
})

test('the complete backup import posts the raw ZIP with the chosen mode', async () => {
  const requests = []
  const file = { name: 'note-wall-backup-20261110-220000.zip', type: 'application/zip' }
  const report = {
    mode: 'replace',
    importedNotes: 2,
    skippedNotes: 0,
    importedFolders: 1,
    imageCount: 2,
    settingsIncluded: true,
    settingsApplied: true,
    safetyBackup: 'note-wall-backup-20261110-215900.zip',
  }
  const value = await hook.importBackup(file, 'replace', true, {
    fetch: async function (target, init) {
      requests.push({ target: target, init: init })
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, value: report } },
      }
    },
  })
  assert.deepEqual(plain(value), report)
  assert.equal(requests[0].target, '/plugins/dsh-note-wall/backup?mode=replace&applySettings=1')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.body, file, 'the ZIP is sent as the raw body')
  assert.equal(requests[0].init.headers['content-type'], 'application/zip')
  assert.equal(requests[0].init.headers['x-dsh-note-wall'], '1')

  let failure
  try {
    await hook.importBackup(file, 'merge', false, {
      fetch: async function () {
        return {
          ok: false,
          status: 413,
          async json() {
            return { ok: false, error: { code: 'backup-too-large', message: '请求体过大。' } }
          },
        }
      },
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure, 'a 413 must reject')
  assert.equal(failure.code, 'backup-too-large')
  assert.equal(failure.status, 413)
  assert.match(hook.errorText(zh, failure), /太大/)
})

function trackedController(settings, extra) {
  const seen = {
    intervals: 0,
    cleared: 0,
    callbacks: [],
    due: [],
    notify: [],
    sound: [],
    notifications: 0,
    audio: 0,
    loads: 0,
  }
  const now = Date.parse('2026-11-10T12:00:00.000Z')
  const controller = hook.createReminderController(Object.assign({
    settings: settings,
    now: function () { return now },
    setInterval(fn) {
      seen.intervals += 1
      seen.callbacks.push(fn)
      return seen.intervals
    },
    clearInterval() { seen.cleared += 1 },
    loadSnapshot: async function () {
      seen.loads += 1
      return { notes: [], settings: settings }
    },
    permission: function () { return 'granted' },
    notification: function () { seen.notifications += 1 },
    audio: function () { seen.audio += 1 },
    notify: function (note) { seen.notify.push(note.id) },
    playSound: function (volume) { seen.sound.push(volume) },
    onDueChange: function (notes) { seen.due = notes.map(function (note) { return note.id }) },
  }, extra || {}))
  return { controller: controller, seen: seen }
}

test('disabled reminders create no interval, notification, audio or overlay update', async () => {
  const cases = [
    cloneDefaultSettings(),
    hook.normalizeClientSettings({
      reminders: { enabled: true, sound: true, notifications: true },
      globalAlarm: { enabled: true, mode: 'silent' },
    }),
    hook.normalizeClientSettings({
      reminders: { enabled: true, sound: true, notifications: true },
      globalAlarm: { enabled: false, mode: 'overlay' },
    }),
    hook.normalizeClientSettings({
      reminders: { enabled: false, sound: true, notifications: true },
      globalAlarm: { enabled: true, mode: 'overlay' },
    }),
  ]
  for (const settings of cases) {
    const tracked = trackedController(settings)
    assert.equal(tracked.controller.getPlan().active, false)
    assert.equal(tracked.controller.start(), false, 'an inactive plan must not start')
    await tracked.controller.tickOnce(true)
    tracked.controller.stop()
    tracked.controller.dispose()
    assert.equal(tracked.seen.intervals, 0, 'no interval may be created')
    assert.equal(tracked.seen.cleared, 0)
    assert.equal(tracked.seen.loads, 0, 'no polling may happen')
    assert.equal(tracked.seen.notify.length, 0, 'no notification may be shown')
    assert.equal(tracked.seen.sound.length, 0, 'no audio may be played')
    assert.equal(tracked.seen.notifications, 0, 'no Notification may be constructed')
    assert.equal(tracked.seen.audio, 0, 'no AudioContext may be constructed')
    assert.equal(tracked.seen.due.length, 0, 'the overlay flag may never be set')
  }
})

test('enabled reminders start exactly one interval and stop on disable and dispose', async () => {
  const enabled = hook.normalizeClientSettings({
    reminders: { enabled: true, sound: true, notifications: true, overdue: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  const tracked = trackedController(enabled)
  assert.equal(tracked.controller.start(), true)
  await tracked.controller.tickOnce(true)
  assert.equal(tracked.seen.intervals, 1, 'exactly one interval')
  assert.equal(tracked.controller.isRunning(), true)
  assert.equal(tracked.controller.start(), true, 'starting again is a no-op')
  assert.equal(tracked.seen.intervals, 1, 'never a second interval')

  tracked.controller.setSettings(cloneDefaultSettings())
  assert.equal(tracked.controller.isRunning(), false, 'disabling reminders stops the timer')
  assert.equal(tracked.seen.cleared, 1)
  assert.equal(tracked.controller.start(), false, 'a disabled plan does not start')
  assert.equal(tracked.seen.intervals, 1)

  tracked.controller.setSettings(enabled)
  assert.equal(tracked.controller.start(), true)
  assert.equal(tracked.seen.intervals, 2)
  tracked.controller.dispose()
  assert.equal(tracked.controller.isRunning(), false, 'unmount/dispose stops the timer')
  assert.equal(tracked.seen.cleared, 2)
  tracked.controller.dispose()
  assert.equal(tracked.seen.cleared, 2, 'dispose is idempotent')
})

test('reminders honour catch-up, permission and sound gates', async () => {
  const note = {
    id: 'n1',
    text: '旧提醒',
    remindAt: '2026-11-10T11:00:00.000Z',
    folderId: '',
    image: '',
  }
  function run(settings, extra) {
    const seen = { due: [], notify: [], sound: [], notifications: 0, audio: 0 }
    const now = Date.parse('2026-11-10T12:00:00.000Z')
    const controller = hook.createReminderController(Object.assign({
      settings: settings,
      now: function () { return now },
      setInterval: function () { return 1 },
      clearInterval: function () {},
      loadSnapshot: async function () { return { notes: [note], settings: settings } },
      permission: function () { return 'granted' },
      notification: function () { seen.notifications += 1 },
      audio: function () { seen.audio += 1 },
      notify: function (dueNote) { seen.notify.push(dueNote.id) },
      playSound: function (volume) { seen.sound.push(volume) },
      onDueChange: function (notes) {
        seen.due = notes.map(function (item) { return item.id })
      },
    }, extra || {}))
    return { controller: controller, seen: seen }
  }
  const catchUpOff = hook.normalizeClientSettings({
    reminders: { enabled: true, notifications: true, sound: true, volume: 0.35, overdue: false },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  const catchUpOn = hook.normalizeClientSettings({
    reminders: { enabled: true, notifications: true, sound: true, volume: 0.35, overdue: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })

  const noCatchUp = run(catchUpOff)
  await noCatchUp.controller.tickOnce(true)
  assert.deepEqual(noCatchUp.seen.due, [], 'an already-overdue reminder is not shown on the first tick')
  assert.deepEqual(noCatchUp.seen.notify, [])
  assert.deepEqual(noCatchUp.seen.sound, [])

  const catchUp = run(catchUpOn)
  await catchUp.controller.tickOnce(true)
  assert.deepEqual(catchUp.seen.due, ['n1'])
  assert.deepEqual(catchUp.seen.notify, ['n1'])
  assert.deepEqual(catchUp.seen.sound, [0.35], 'the configured volume reaches the audio gate')
  await catchUp.controller.tickOnce(false)
  assert.deepEqual(catchUp.seen.notify, ['n1'], 'the same reminder is never notified twice')

  const muted = hook.normalizeClientSettings({
    reminders: { enabled: true, notifications: true, sound: false, volume: 0.9, overdue: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  const quiet = run(muted, { notify: undefined, playSound: undefined })
  await quiet.controller.tickOnce(true)
  assert.equal(quiet.seen.notifications, 1, 'notifications still work with sound off')
  assert.equal(quiet.seen.audio, 0, 'no AudioContext when the sound is off')

  const deniedSettings = hook.normalizeClientSettings({
    reminders: { enabled: true, notifications: true, sound: false, overdue: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  const denied = run(deniedSettings, { permission: function () { return 'denied' }, notify: undefined, playSound: undefined })
  await denied.controller.tickOnce(true)
  assert.deepEqual(denied.seen.due, ['n1'], 'the card still appears without permission')
  assert.equal(denied.seen.notifications, 0, 'no Notification without permission')
  assert.equal(denied.seen.audio, 0)
})

test('the shell overlay renders nothing while the alarm is disabled or nothing is due', () => {
  const enabled = hook.normalizeClientSettings({
    reminders: { enabled: true },
    globalAlarm: { enabled: true, mode: 'overlay' },
  })
  assert.equal(hook.reminderPlan(cloneDefaultSettings()).active, false)
  assert.equal(hook.reminderPlan(enabled).active, true)

  hook.publishSettings(cloneDefaultSettings())
  assert.equal(hook.ReminderOverlay({ ctx: undefined }), null, 'disabled: no overlay node at all')

  hook.publishSettings(enabled)
  assert.equal(hook.ReminderOverlay({ ctx: undefined }), null, 'active but nothing due: no overlay node')

  hook.publishSettings(cloneDefaultSettings())
  assert.equal(hook.ReminderOverlay({ ctx: undefined }), null)
})
