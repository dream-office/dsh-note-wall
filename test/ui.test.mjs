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
