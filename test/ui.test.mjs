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
    // Kept minimal: the focus-trap branch reads document.activeElement and the
    // page-level Escape/outside-click effects only attach listeners in effects,
    // which the test renderer skips.
    document: {
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    },
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
  return { module: module, hook: sandbox.window.__DSH_NOTE_WALL_TEST__, document: sandbox.document }
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
    nodes.filter(function (node) { return node.type === hook.FolderChips }).length,
    0,
    'no folder chips row while folders are off',
  )
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

test('enabling folders adds the chips row and keeps selection, not the old panel', () => {
  const nodes = collect(hook.NoteWallPage({
    ctx: undefined,
    initialSettings: hook.normalizeClientSettings({ folders: { enabled: true } }),
  }))
  assert.equal(
    nodes.filter(function (node) { return node.type === hook.FolderChips }).length,
    1,
    'the top folder chips row should appear when folders are enabled',
  )
  assert.equal(
    nodes.filter(function (node) { return node.props && node.props['aria-label'] === '按文件夹筛选' }).length,
    0,
    'the old folder <select> must be gone',
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-folder-panel') >= 0
    }).length,
    0,
    'the old folder management panel must be gone',
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).indexOf('nw-folder-toggle') >= 0
    }).length,
    0,
    'the old folder manager button must be gone',
  )
  assert.equal(
    nodes.filter(function (node) { return textContent(node).indexOf('管理文件夹') >= 0 }).length,
    0,
  )
  assert.equal(
    nodes.filter(function (node) {
      return node.type === 'button' && textContent(node) === '选择'
    }).length,
    1,
    'selection mode stays available alongside the chips',
  )
  const chips = nodes.find(function (node) { return node.type === hook.FolderChips })
  assert.deepEqual(Array.from(chips.props.folders), [])
  assert.equal(chips.props.filterFolder, 'all')
  assert.equal(chips.props.creating, false)
  assert.equal(typeof chips.props.onFilter, 'function')
  assert.equal(typeof chips.props.onOpenMenu, 'function')
  assert.equal(typeof chips.props.onCreate, 'function')
})

test('cards use one uniform height, clamped text and a bottom action baseline', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.nw-grid\{[^}]*grid-auto-rows:1fr[^}]*align-items:stretch\}/)
  assert.match(source, /\.nw-note\{[^}]*height:100%;min-height:240px;overflow:hidden/)
  assert.match(source, /\.nw-note-body\{[^}]*overflow:hidden/)
  assert.match(source, /\.nw-note-text\{[^}]*-webkit-line-clamp:4[^}]*max-height:calc\(1\.72em \* 4\)/)
  assert.match(source, /\.nw-note-foot\{[^}]*margin-top:auto/)
})

test('folder chips scroll at 320/360 with a fixed 32px + and no-wrap chips', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // The scroll strip hides its scrollbar and may shrink below its content.
  assert.match(source, /\.nw-chips-scroll\{[^}]*flex:1 1 auto[^}]*min-width:0[^}]*overflow-x:auto[^}]*scrollbar-width:none/)
  assert.match(source, /\.nw-chips-scroll::-webkit-scrollbar\{display:none/)
  // The + lives outside the scroller so it stays visible at 320 and 360.
  assert.match(source, /\.nw-chips-row\{display:flex[^}]*min-width:0\}/)
  assert.match(source, /\.nw-chip\{[^}]*height:32px[^}]*white-space:nowrap/)
  assert.match(source, /\.nw-chip-add\{[^}]*width:32px/)
  assert.match(source, /\.nw-chip-input\{[^}]*height:32px/)
  assert.match(source, /\.nw-menu-item\{[^}]*height:32px/)
  assert.match(source, /\.nw-note\{[^}]*position:relative/)
  assert.match(source, /\.nw-note-menu\{position:absolute[^}]*right:8px;bottom:8px/)
  assert.match(source, /\.nw-dialog-actions \.nw-mini,[^{]*\{height:32px/)
  assert.match(source, /@media \(max-width:420px\)\{[\s\S]*?\.nw-chip-input\{width:132px/)
  // The existing 32px toolbar controls are untouched.
  assert.match(source, /\.nw-toolbar \.nw-mini\{[^}]*height:32px[^}]*white-space:nowrap/)
  assert.match(source, /\.nw-select-toggle\{[^}]*padding:0 12px;gap:8px/)
})

test('folder chips list 全部 / 未分类 / each folder with counts and a + add button', () => {
  const notes = [
    sampleNote({ id: 'a', folderId: 'f1' }),
    sampleNote({ id: 'b', folderId: '' }),
    sampleNote({ id: 'c', folderId: 'f1' }),
    sampleNote({ id: 'd', folderId: 'f2' }),
  ]
  const calls = []
  const tree = hook.FolderChips({
    t: zh,
    folders: [{ id: 'f1', name: '工作' }, { id: 'f2', name: '生活' }],
    notes: notes,
    filterFolder: 'f1',
    creating: false,
    draftName: '',
    onFilter(id) { calls.push(['filter', id]) },
    onStartCreate() { calls.push(['start']) },
    onOpenMenu() {},
    onCancelCreate() {},
    onCreate() {},
    onDraftName() {},
    onRename() {},
    onDelete() {},
    onCloseMenu() {},
  })
  const chips = collect(tree).filter(function (node) { return node.type === hook.FolderChip }).map(function (node) { return node.props })
  assert.deepEqual(chips.map(function (chip) { return chip.label }), ['全部', '未分类', '工作', '生活'])
  assert.deepEqual(chips.map(function (chip) { return chip.count }), [4, 1, 2, 1], 'every chip shows its own count')
  assert.deepEqual(chips.map(function (chip) { return chip.pressed }), [false, false, true, false], 'only the active chip is pressed')
  assert.deepEqual(chips.map(function (chip) { return chip.manage }), [false, false, true, true], 'only real folders can open a menu')

  const nodes = collect(tree)
  const add = nodes.find(function (node) {
    return node.type === 'button' && typeof node.props.className === 'string' && node.props.className.indexOf('nw-chip-add') >= 0
  })
  assert.ok(add, 'the trailing + is missing')
  assert.equal(textContent(add), '+')
  assert.equal(add.props['aria-label'], '新建文件夹')
  // The + is a sibling of the scrolling strip, so it cannot scroll out of view.
  const row = nodes.find(function (node) { return node.props && node.props.className === 'nw-chips-row' })
  assert.ok(row, 'chips row missing')
  assert.equal(row.children.some(function (child) {
    return child.props && child.props.className === 'nw-chips-scroll'
  }), true)
  assert.equal(row.children.indexOf(add) >= 0, true, 'the + must live outside the scroll strip')
  add.props.onClick()
  assert.deepEqual(calls, [['start']], '+ opens the inline creator')

  chips[2].onSelect()
  chips[1].onSelect()
  assert.deepEqual(calls.slice(1), [['filter', 'f1'], ['filter', '']], 'clicking a chip filters by its folder id')
  assert.equal(hook.folderCount(notes, ''), 1)
  assert.equal(hook.folderCount(notes, 'f2'), 1)
  assert.equal(hook.folderCount(notes, 'missing'), 0)
  assert.deepEqual(
    Array.from(hook.folderMoveOptions([{ id: 'f1', name: '工作' }]), function (option) { return option.id }),
    ['', 'f1'],
  )
  assert.equal(hook.folderDisplayName(zh, [{ id: 'f1', name: '工作' }], 'f1'), '工作')
  assert.equal(hook.folderDisplayName(zh, [], ''), '未分类')
  // Deleting the filtered folder must land on 未分类, never 全部.
  assert.equal(hook.folderFilterAfterRemove('f1', 'f1'), '')
  assert.equal(hook.folderFilterAfterRemove('f1', 'f2'), 'f1')
  assert.equal(hook.folderFilterAfterRemove('all', 'f1'), 'all')
  assert.equal(hook.folderFilterAfterRemove('', 'f1'), '')
})

test('the + opens an inline input: Enter creates the folder and Esc cancels', () => {
  const events = []
  const inputRef = { current: null }
  const tree = hook.FolderChips({
    t: zh,
    folders: [],
    notes: [],
    filterFolder: 'all',
    creating: true,
    draftName: '待读',
    maxLength: 40,
    createInputRef: inputRef,
    onFilter() {},
    onStartCreate() {},
    onOpenMenu() {},
    onCancelCreate() { events.push(['cancel']) },
    onCreate() { events.push(['create']) },
    onDraftName(value) { events.push(['name', value]) },
    onRename() {},
    onDelete() {},
    onCloseMenu() {},
  })
  const nodes = collect(tree)
  const form = nodes.find(function (node) { return node.props && node.props.className === 'nw-chip-create' })
  const input = nodes.find(function (node) { return node.type === 'input' })
  assert.ok(form, 'inline create form missing')
  assert.ok(input, 'inline create input missing')
  assert.equal(input.props.value, '待读')
  assert.equal(input.props.ref, inputRef)
  assert.equal(input.props['aria-label'], '新文件夹名称')
  assert.equal(input.props.maxLength, 40)
  const add = nodes.find(function (node) {
    return node.type === 'button' && typeof node.props.className === 'string' && node.props.className.indexOf('nw-chip-add') >= 0
  })
  assert.equal(add, undefined, 'the + is replaced by the input while creating')

  form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(events, [['create']], 'Enter submits the inline form')
  input.props.onChange({ target: { value: '生活' } })
  input.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.deepEqual(events, [['create'], ['name', '生活'], ['cancel']], 'Esc cancels without creating')
})

test('folder chip menus use menu roles for rename, delete and cancel', () => {
  const calls = []
  const firstItemRef = { current: null }
  const tree = hook.FolderChips({
    t: zh,
    folders: [{ id: 'f1', name: '工作' }],
    notes: [],
    filterFolder: 'all',
    creating: false,
    draftName: '',
    menuFor: 'f1',
    firstItemRef: firstItemRef,
    onFilter() {},
    onStartCreate() {},
    onOpenMenu() {},
    onCancelCreate() {},
    onCreate() {},
    onDraftName() {},
    onRename() { calls.push('rename') },
    onDelete() { calls.push('delete') },
    onCloseMenu() { calls.push('close') },
  })
  const nodes = collect(tree)
  const menuElement = nodes.find(function (node) { return node.type === hook.FolderMenu })
  assert.ok(menuElement, 'chip menu element missing')
  const menu = collect(hook.FolderMenu(menuElement.props)).find(function (node) {
    return node.props && node.props.role === 'menu'
  })
  assert.ok(menu, 'chip menu missing')
  assert.equal(menu.props['data-nw-menu'], '1')
  const items = collect(hook.FolderMenu(menuElement.props)).filter(function (node) {
    return node.type === 'button' && node.props.role === 'menuitem'
  })
  assert.deepEqual(items.map(textContent), ['重命名', '删除文件夹', '取消'])
  assert.equal(items[0].props.ref, firstItemRef, 'the first item is the focus target on open')
  items[0].props.onClick()
  items[1].props.onClick()
  items[2].props.onClick()
  assert.deepEqual(calls, ['rename', 'delete', 'close'])
  menu.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.deepEqual(calls, ['rename', 'delete', 'close', 'close'], 'Esc closes the chip menu')
})

test('folder chips are keyboard and touch manageable with a 500ms long press', async () => {
  assert.equal(hook.FOLDER_LONG_PRESS_MS, 500)
  const calls = []
  const button = collect(hook.FolderChip({
    t: zh,
    label: '工作',
    count: 3,
    pressed: true,
    manage: true,
    menuOpen: false,
    onSelect() { calls.push('select') },
    onOpenMenu() { calls.push('menu') },
  }))[0]
  assert.equal(button.props['aria-pressed'], true)
  assert.equal(button.props['aria-haspopup'], 'menu')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['data-nw-menu-toggle'], '1')
  let prevented = 0
  button.props.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() { prevented += 1 } })
  button.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  button.props.onContextMenu({ preventDefault() { prevented += 1 } })
  assert.deepEqual(calls, ['menu', 'menu', 'menu'], 'Shift+F10, Enter and right-click all open the menu')
  assert.equal(prevented, 2)

  const plain = collect(hook.FolderChip({
    t: zh,
    label: '全部',
    count: 4,
    pressed: true,
    manage: false,
    menuOpen: false,
    onSelect() { calls.push('plain-select') },
    onOpenMenu() { calls.push('plain-menu') },
  }))[0]
  assert.equal(plain.props['aria-haspopup'], undefined)
  plain.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.equal(calls.indexOf('plain-menu'), -1, '全部/未分类 never open a menu')
  plain.props.onClick({ preventDefault() {} })
  assert.equal(calls.indexOf('plain-select') >= 0, true)

  const opened = []
  let selected = 0
  const longPressed = collect(hook.FolderChip({
    t: zh,
    label: '工作',
    count: 1,
    pressed: false,
    manage: true,
    menuOpen: false,
    onSelect() { selected += 1 },
    onOpenMenu() { opened.push('menu') },
  }))[0]
  longPressed.props.onTouchStart()
  await new Promise(function (resolve) { setTimeout(resolve, hook.FOLDER_LONG_PRESS_MS + 80) })
  assert.deepEqual(opened, ['menu'], 'a 500ms touch hold opens the menu')
  longPressed.props.onClick({ preventDefault() {} })
  assert.equal(selected, 0, 'the click that follows a long press is swallowed')
  longPressed.props.onClick({ preventDefault() {} })
  assert.equal(selected, 1, 'the next tap filters normally')

  const openedAfterMove = []
  let selectedAfterMove = 0
  const cancelled = collect(hook.FolderChip({
    t: zh,
    label: '工作',
    count: 1,
    pressed: false,
    manage: true,
    menuOpen: false,
    onSelect() { selectedAfterMove += 1 },
    onOpenMenu() { openedAfterMove.push('menu') },
  }))[0]
  cancelled.props.onTouchStart()
  cancelled.props.onTouchMove()
  await new Promise(function (resolve) { setTimeout(resolve, hook.FOLDER_LONG_PRESS_MS + 80) })
  assert.deepEqual(openedAfterMove, [], 'touchmove cancels the long press so scrolling never opens a menu')
  cancelled.props.onClick({ preventDefault() {} })
  assert.equal(selectedAfterMove, 1)
})

test('cards with folders enabled show a ⋯ menu instead of the icon pair', () => {
  const note = sampleNote()
  const calls = []
  const props = Object.assign(baseProps(note), {
    foldersEnabled: true,
    menuOpen: false,
    onToggleMenu(value) { calls.push(['toggle', value.id]) },
    onMoveNote(value) { calls.push(['move', value.id]) },
    onBeginEdit(value) { calls.push(['edit', value.id]) },
    onAskDelete() { calls.push(['delete']) },
    onCloseMenu() { calls.push(['close']) },
  })
  const nodes = collect(hook.NoteCard(props))
  const more = nodes.find(function (node) {
    return node.type === 'button' && typeof node.props.className === 'string' && node.props.className.indexOf('nw-note-more') >= 0
  })
  assert.ok(more, 'the card ⋯ is missing')
  assert.equal(textContent(more), '⋯')
  assert.equal(more.props['aria-haspopup'], 'menu')
  assert.equal(more.props['aria-expanded'], false)
  more.props.onClick()
  assert.deepEqual(calls, [['toggle', 'note-a']])
  assert.equal(nodes.filter(function (node) { return node.type === 'button' && node.props['aria-label'] === '编辑便签' }).length, 0)
  assert.equal(nodes.filter(function (node) { return node.type === 'button' && node.props['aria-label'] === '删除便签' }).length, 0)

  const openNodes = collect(hook.NoteCard(Object.assign({}, props, { menuOpen: true })))
  const menu = openNodes.find(function (node) { return node.props && node.props.role === 'menu' })
  assert.ok(menu, 'card menu missing')
  assert.equal(menu.props['data-nw-menu'], '1')
  const items = openNodes.filter(function (node) { return node.type === 'button' && node.props.role === 'menuitem' })
  assert.deepEqual(items.map(textContent), ['移动到文件夹…', '编辑', '删除便签'])
  items[0].props.onClick()
  items[1].props.onClick()
  items[2].props.onClick()
  assert.deepEqual(calls.slice(1), [['move', 'note-a'], ['edit', 'note-a'], ['delete']])

  const offNodes = collect(hook.NoteCard(baseProps(sampleNote())))
  assert.equal(offNodes.some(function (node) {
    return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-note-more') >= 0
  }), false, 'without folders the card keeps the icon pair')
  assert.equal(offNodes.filter(function (node) { return node.type === 'button' && node.props['aria-label'] === '编辑便签' }).length, 1)
  assert.equal(offNodes.filter(function (node) { return node.type === 'button' && node.props['aria-label'] === '删除便签' }).length, 1)
})

test('the move dialog lists uncategorized and folders with counts and marks the current one', () => {
  const notes = [
    sampleNote({ id: 'a', folderId: 'f1' }),
    sampleNote({ id: 'b', folderId: '' }),
    sampleNote({ id: 'c', folderId: 'f1' }),
  ]
  const calls = []
  const tree = hook.MoveDialog({
    t: zh,
    titleId: 'move-title',
    folders: [{ id: 'f1', name: '工作' }, { id: 'f2', name: '生活' }],
    notes: notes,
    currentFolderId: 'f1',
    busy: false,
    creating: false,
    draftName: '',
    error: '已经有同名文件夹了。',
    onMove(id) { calls.push(['move', id]) },
    onStartCreate() { calls.push(['start']) },
    onCancelCreate() { calls.push(['cancel-create']) },
    onCreate() { calls.push(['create']) },
    onDraftName() {},
    onClose() { calls.push(['close']) },
  })
  const nodes = collect(tree)
  const group = nodes.find(function (node) { return node.props && node.props.role === 'radiogroup' })
  assert.ok(group, 'move options need a radiogroup')
  const options = nodes.filter(function (node) { return node.type === 'button' && node.props.role === 'radio' })
  assert.equal(options.length, 3)
  assert.deepEqual(options.map(function (node) { return node.props['aria-checked'] }), [false, true, false])
  assert.match(textContent(options[0]), /未分类/)
  assert.match(textContent(options[0]), /1 条/)
  assert.match(textContent(options[1]), /工作/)
  assert.match(textContent(options[1]), /2 条/)
  assert.match(textContent(options[2]), /生活/)
  assert.match(textContent(options[2]), /0 条/)
  assert.equal(nodes.some(function (node) {
    return node.props && node.props.role === 'alert' && textContent(node) === '已经有同名文件夹了。'
  }), true, 'a create/move failure is shown inside the move dialog')
  options[2].props.onClick()
  assert.deepEqual(calls, [['move', 'f2']])

  const modal = nodes.find(function (node) { return node.type === hook.Modal })
  assert.ok(modal, 'move dialog is not built on the shared modal')
  assert.equal(modal.props.title, '移动到文件夹')
  const modalNodes = collect(hook.Modal(Object.assign({}, modal.props, { children: modal.children })))
  const dialog = modalNodes.find(function (node) { return node.props && node.props.role === 'dialog' })
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(dialog.props['aria-labelledby'], 'move-title')
  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, currentTarget: dialog })
  assert.ok(calls.some(function (call) { return call[0] === 'close' }), 'Esc closes the move dialog')

  const newFolder = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '+ 新建文件夹'
  })
  assert.ok(newFolder, 'the move dialog must offer + 新建文件夹')
  newFolder.props.onClick()
  assert.ok(calls.some(function (call) { return call[0] === 'start' }))
})

test('the move dialog creates a new folder and moves the note in one flow', () => {
  const calls = []
  const tree = hook.MoveDialog({
    t: zh,
    titleId: 'move-title',
    folders: [],
    notes: [sampleNote({ folderId: '' })],
    currentFolderId: '',
    busy: false,
    creating: true,
    draftName: '待读',
    maxLength: 40,
    onMove() {},
    onStartCreate() {},
    onCancelCreate() { calls.push('cancel-create') },
    onCreate() { calls.push('create') },
    onDraftName(value) { calls.push(['name', value]) },
    onClose() {},
  })
  const nodes = collect(tree)
  const form = nodes.find(function (node) {
    return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-move-create') >= 0
  })
  const input = nodes.find(function (node) { return node.type === 'input' })
  assert.ok(form, 'inline create form missing from the move dialog')
  assert.ok(input, 'new folder name input missing')
  assert.equal(input.props.value, '待读')
  assert.equal(input.props.maxLength, 40)
  const submit = nodes.find(function (node) { return node.type === 'button' && node.props.type === 'submit' })
  assert.ok(submit, '「新建并移入」submit missing')
  assert.equal(textContent(submit), '新建并移入')
  form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(calls, ['create'])
  input.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.deepEqual(calls, ['create', 'cancel-create'])

  const blank = collect(hook.MoveDialog({
    t: zh,
    folders: [],
    notes: [],
    currentFolderId: '',
    busy: false,
    creating: true,
    draftName: '   ',
    onMove() {},
    onStartCreate() {},
    onCancelCreate() {},
    onCreate() {},
    onDraftName() {},
    onClose() {},
  })).find(function (node) { return node.type === 'button' && node.props.type === 'submit' })
  assert.equal(blank.props.disabled, true, 'an empty name cannot be submitted')
})

test('folder empty states explain how to fill the filter', () => {
  const calls = []
  const uncategorized = collect(hook.FolderEmptyState({
    t: zh,
    kind: 'uncategorized',
    folderName: '',
    onShowAll() { calls.push('all') },
    onCompose() { calls.push('compose') },
  }))
  const uncategorizedText = uncategorized.map(textContent).join('')
  assert.match(uncategorizedText, /没有未分类的便签/)
  assert.match(uncategorizedText, /去全部看看/)
  const showAll = uncategorized.find(function (node) { return node.type === 'button' && textContent(node) === '去全部看看' })
  showAll.props.onClick()
  assert.deepEqual(calls, ['all'])

  const folder = collect(hook.FolderEmptyState({
    t: zh,
    kind: 'folder',
    folderName: '工作',
    onShowAll() { calls.push('all') },
    onCompose() { calls.push('compose') },
  }))
  const folderText = folder.map(textContent).join('')
  assert.match(folderText, /「工作」还是空的/)
  assert.match(folderText, /把便签移到这里，或在这里新建/)
  assert.match(folderText, /记一条/)
  const compose = folder.find(function (node) { return node.type === 'button' && textContent(node) === '记一条' })
  compose.props.onClick()
  assert.deepEqual(calls, ['all', 'compose'], '记一条 focuses the composer')

  // Only a folder-only filter picks the folder copy; text filters keep no-match.
  assert.equal(hook.folderEmptyKind({ foldersEnabled: true, textFiltersActive: false, filterFolder: '', folderName: '' }), 'uncategorized')
  assert.equal(hook.folderEmptyKind({ foldersEnabled: true, textFiltersActive: false, filterFolder: 'f1', folderName: '工作' }), 'folder')
  assert.equal(hook.folderEmptyKind({ foldersEnabled: true, textFiltersActive: true, filterFolder: 'f1', folderName: '工作' }), '', 'search/color/tag misses keep the generic no-match state')
  assert.equal(hook.folderEmptyKind({ foldersEnabled: false, textFiltersActive: false, filterFolder: '', folderName: '' }), '')
  assert.equal(hook.folderEmptyKind({ foldersEnabled: true, textFiltersActive: false, filterFolder: 'all', folderName: '' }), '')
})

test('the rename dialog is a modal form with Enter submit and Esc close', () => {
  const calls = []
  const inputRef = { current: null }
  const tree = hook.RenameFolderDialog({
    t: zh,
    titleId: 'rename-title',
    inputRef: inputRef,
    value: '工作',
    maxLength: 40,
    busy: false,
    error: '已经有同名文件夹了。',
    onChange(value) { calls.push(['change', value]) },
    onSubmit() { calls.push('submit') },
    onClose() { calls.push('close') },
  })
  const nodes = collect(tree)
  const modal = nodes.find(function (node) { return node.type === hook.Modal })
  assert.ok(modal, 'rename dialog is not built on the shared modal')
  assert.equal(modal.props.initialFocusRef, inputRef)
  assert.equal(modal.props.title, '重命名文件夹')
  const form = nodes.find(function (node) { return node.props && node.props.className === 'nw-dialog-form' })
  const input = nodes.find(function (node) { return node.type === 'input' })
  assert.equal(input.props.value, '工作')
  assert.equal(input.props.maxLength, 40)
  assert.equal(input.props['aria-label'], '文件夹名称')
  assert.equal(nodes.some(function (node) {
    return node.props && node.props.role === 'alert' && textContent(node) === '已经有同名文件夹了。'
  }), true, 'a duplicate-name error is shown inside the dialog')
  form.props.onSubmit({ preventDefault() {} })
  input.props.onChange({ target: { value: '生活' } })
  assert.deepEqual(calls, ['submit', ['change', '生活']])

  const modalNodes = collect(hook.Modal(Object.assign({}, modal.props, { children: modal.children })))
  const dialog = modalNodes.find(function (node) { return node.props && node.props.role === 'dialog' })
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(dialog.props['aria-labelledby'], 'rename-title')
  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, currentTarget: dialog })
  assert.ok(calls.indexOf('close') >= 0, 'Esc closes the rename dialog')

  // Clicking the backdrop closes; clicking inside the dialog does not.
  const backdrop = modalNodes.find(function (node) {
    return node.props && node.props.className === 'nw-dialog-backdrop'
  })
  const closesBefore = calls.filter(function (call) { return call === 'close' }).length
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
  assert.equal(calls.filter(function (call) { return call === 'close' }).length, closesBefore + 1)
  backdrop.props.onClick({ target: dialog, currentTarget: backdrop })
  assert.equal(calls.filter(function (call) { return call === 'close' }).length, closesBefore + 1, 'inside clicks never close the dialog')

  const first = { focus() { calls.push('focus-first') } }
  const last = { focus() { calls.push('focus-last') } }
  client.document.activeElement = last
  dialog.props.onKeyDown({
    key: 'Tab',
    shiftKey: false,
    preventDefault() {},
    currentTarget: { querySelectorAll() { return [first, last] } },
  })
  assert.ok(calls.indexOf('focus-first') >= 0, 'Tab wraps from the last control to the first')
  client.document.activeElement = first
  dialog.props.onKeyDown({
    key: 'Tab',
    shiftKey: true,
    preventDefault() {},
    currentTarget: { querySelectorAll() { return [first, last] } },
  })
  assert.ok(calls.indexOf('focus-last') >= 0, 'Shift+Tab wraps from the first control to the last')
})

test('the delete folder dialog says the notes move to 未分类 and are not deleted', () => {
  const calls = []
  const tree = hook.DeleteFolderDialog({
    t: zh,
    titleId: 'delete-title',
    folderName: '工作',
    count: 3,
    busy: false,
    onConfirm() { calls.push('confirm') },
    onClose() { calls.push('close') },
  })
  const nodes = collect(tree)
  const text = nodes.map(textContent).join('')
  assert.match(text, /「工作」里有 3 条便签/)
  assert.match(text, /移到「未分类」/)
  assert.match(text, /不会被删掉/)
  const confirm = nodes.find(function (node) { return node.type === 'button' && textContent(node) === '删除文件夹' })
  assert.ok(confirm, 'delete confirmation button missing')
  assert.match(confirm.props.className, /nw-mini-danger/)
  confirm.props.onClick()
  assert.deepEqual(calls, ['confirm'])
  const modalNodes = collect(hook.Modal(Object.assign({}, nodes.find(function (node) { return node.type === hook.Modal }).props, {
    children: nodes.find(function (node) { return node.type === hook.Modal }).children,
  })))
  const dialog = modalNodes.find(function (node) { return node.props && node.props.role === 'dialog' })
  assert.equal(dialog.props['aria-labelledby'], 'delete-title')
})

test('missing images render a text placeholder in every display mode', () => {
  for (const mode of ['thumbnail', 'icon', 'large']) {
    const node = hook.missingImageNode(zh, mode, false)
    const nodes = collect(node)
    const placeholder = nodes[0]
    assert.match(placeholder.props.className, /nw-note-image-missing/)
    assert.equal(placeholder.props.role, 'img')
    assert.equal(placeholder.props['aria-label'], '图片缺失')
    assert.ok(textContent(node).indexOf('图片缺失') >= 0)
  }
  const editPlaceholder = hook.missingImageNode(zh, 'thumbnail', true)
  assert.match(editPlaceholder.props.className, /nw-edit-image-missing/)
})

test('card images expose onError and a changed image id resets the failure key', () => {
  const note = sampleNote({ image: IMAGE_ID })
  const card = hook.NoteCard(baseProps(note))
  const image = collect(card).find(function (node) { return node.type === 'img' && node.props && node.props.src })
  assert.ok(image, 'note image missing from the card')
  assert.equal(typeof image.props.onError, 'function')
  assert.equal(hook.imageFailureIsFor(image.props.src, image.props.src), true)
  assert.equal(hook.imageFailureIsFor(image.props.src, '/plugins/dsh-note-wall/image/22222222-2222-4222-8222-222222222222.png'), false)
  assert.equal(hook.imageFailureIsFor('', image.props.src), false)
})

test('editing a note with a missing image still offers remove and replace', () => {
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
  let cleared = 0
  const props = baseProps(note, editing)
  props.onClearEditImage = function () { cleared += 1 }
  const nodes = collect(hook.NoteCard(props))
  const remove = nodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '移除图片'
  })
  assert.ok(remove, 'remove-image control missing from the edit preview')
  remove.props.onClick()
  assert.equal(cleared, 1)
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

// --- v1.4.0 UI unification (Lumen + warm apricot) ---------------------------

function cssValueList(css, property) {
  const values = []
  const pattern = new RegExp('(?:[;{])' + property + ':([^;}]+)', 'g')
  let match = pattern.exec(css)
  while (match) {
    values.push(match[1].trim())
    match = pattern.exec(css)
  }
  return values
}

function spacingTokens(value) {
  return value.split(/\s+/)
    .filter(function (part) { return part.length > 0 && part !== 'auto' })
    .map(function (part) { return Number(part.replace('px', '')) })
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map(function (start) {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(left, right) {
  const a = relativeLuminance(left)
  const b = relativeLuminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('the light theme keeps host surfaces and adds only the apricot accent', () => {
  assert.deepEqual(plain(hook.NW_PALETTE), {
    paper: '#FDF5EE',
    ink: '#2D2A26',
    accent: '#E8A87C',
    accentInk: '#7A4418',
    muted: '#6B5F52',
  })
  const css = hook.getCss()
  for (const line of [
    '--nw-ink:var(--dsw-alias-label-primary)',
    '--nw-muted:var(--dsw-alias-label-secondary)',
    '--nw-surface:var(--dsw-alias-bg-layer-1)',
    '--nw-surface-2:var(--dsw-alias-bg-layer-2)',
    '--nw-line:var(--dsw-alias-border-l2)',
    '--nw-line-soft:var(--dsw-alias-border-l1)',
    '--nw-accent-ink:#7A4418',
    '--nw-project-accent:#E8A87C',
    '--nw-on-accent:#2D2A26',
  ]) {
    assert.ok(css.indexOf(line) >= 0, 'missing token ' + line)
  }
  assert.doesNotMatch(css, /background:var\(--nw-paper\)/, 'paper must not replace a host surface')
  assert.match(css, /\.nw-root\{[^}]*background:var\(--dsw-alias-bg-base\)[^}]*color:var\(--dsw-alias-label-primary\)/)
  const darkStart = css.indexOf('.nw-dark{')
  const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart) + 1)
  assert.match(darkBlock, /--nw-ink:var\(--dsw-alias-label-primary\)/)
  assert.match(darkBlock, /--nw-paper:var\(--dsw-alias-bg-base\)/)
  assert.match(darkBlock, /--nw-surface:var\(--dsw-alias-bg-layer-1\)/)
  assert.match(darkBlock, /--nw-focus:var\(--dsw-alias-brand-primary\)/)
  assert.doesNotMatch(darkBlock, /#[0-9A-Fa-f]{6}/, 'no dark color may be hardcoded')
  assert.doesNotMatch(css, /backdrop-filter/, 'no glass in the host panel')
  assert.doesNotMatch(css, /#5B57F0|#8B87FF/, 'the old signature colors are gone')

  // Note content tones are the plugin's own artwork and must stay untouched.
  for (const tone of ['#F0C24B', '#F2A6BC', '#8FC4F0', '#7FD3C0', '#B79CF0', '#E4D3AE']) {
    assert.ok(css.indexOf(tone) >= 0, 'pastel tone changed: ' + tone)
  }

  // Settings dialog: solid host surface + shadow, never glass.
  assert.match(css, /\.nw-settings\{[^}]*background:var\(--nw-surface\)[^}]*box-shadow:/)

  // Accent is recognition only; selected chips use deep ink on apricot.
  assert.match(css, /\.nw-chip\[aria-pressed="true"\]\{[^}]*background:var\(--nw-project-accent\)[^}]*color:var\(--nw-on-accent\)/)
  assert.match(css, /\.nw-mini-primary\{[^}]*background:var\(--nw-project-accent\)[^}]*color:var\(--nw-on-accent\)/)
  assert.match(css, /\.nw-add\{[^}]*background:var\(--nw-project-accent\)[^}]*color:var\(--nw-on-accent\)/)

  // Signature: same 10px square, project color, host brand in dark.
  assert.match(css, /\.nw-signature\{[^}]*color:var\(--nw-accent-ink\)/)
  assert.match(css, /\.nw-signature-mark\{width:10px;height:10px;border-radius:3px;background:var\(--nw-project-accent\)/)
  assert.doesNotMatch(css, /\.nw-dark \.nw-signature-mark/)
  assert.match(css, /\.nw-dark\{[^}]*--nw-project-accent:var\(--dsw-alias-brand-primary\)/)
})

test('light palette text roles meet WCAG contrast on paper', () => {
  const palette = hook.NW_PALETTE
  assert.ok(contrastRatio(palette.ink, palette.paper) >= 7, 'ink on paper')
  assert.ok(contrastRatio(palette.muted, palette.paper) >= 4.5, 'muted on paper')
  assert.ok(contrastRatio(palette.accentInk, palette.paper) >= 4.5, 'accent ink on paper')
})

test('sizes and radii are normalized to the Lumen token set', () => {
  const css = hook.getCss() + hook.getOverlayCss()

  const fontSizes = cssValueList(css, 'font-size').map(function (value) {
    return Number(value.replace('px', ''))
  })
  assert.ok(fontSizes.length > 0)
  for (const size of fontSizes) {
    assert.ok([11, 12, 13, 15, 20].indexOf(size) >= 0, 'unexpected font size: ' + size)
  }
  // 13px body density is preserved, not collapsed to a 12px UI.
  assert.match(css, /\.nw-root\{[^}]*font-size:13px/)

  // Only the four control heights survive; image/art sizes are not controls.
  assert.match(css, /\.nw-search\{[^}]*height:32px[^}]*border-radius:10px/)
  assert.match(css, /\.nw-filter\{height:32px[^}]*border-radius:10px/)
  assert.match(css, /\.nw-mini\{height:28px/)
  assert.match(css, /\.nw-iconbtn\{[^}]*width:28px;height:28px/)
  assert.match(css, /\.nw-motion-toggle\{[^}]*height:28px/)
  assert.match(css, /\.nw-tag-input\{[^}]*height:32px/)
  assert.match(css, /\.nw-link-field\{[^}]*height:32px/)
  assert.match(css, /\.nw-attach-btn\{[^}]*height:32px/)
  assert.match(css, /\.nw-add\{[^}]*height:36px/)
  assert.match(css, /\.nw-move-option\{[^}]*min-height:44px/)
  assert.match(css, /\.nw-dialog-input\{height:32px/)
  assert.match(css, /\.nw-chip\{[^}]*height:32px/)
  assert.match(css, /\.nw-cat-chip\{height:28px/)
  assert.match(css, /\.nw-signature\{[^}]*height:28px/)
  assert.match(css, /\.nw-ov-btn\{[^}]*height:28px/)

  // Card / dialog / overlay cards normalize to radius 20 and min-height 240.
  assert.match(css, /\.nw-note\{[^}]*min-height:240px[^}]*border-radius:20px/)
  assert.match(css, /\.nw-settings\{[^}]*border-radius:20px/)
  assert.match(css, /\.nw-dialog\{[^}]*border-radius:20px/)
  assert.match(css, /\.nw-empty\{[^}]*border-radius:20px/)
  assert.match(css, /\.nw-ov-card\{[^}]*border-radius:20px/)

  // No legacy radii (8/9/16/18/22) or percent circles remain.
  assert.doesNotMatch(css, /border-radius:(?:4|6|8|9|16|18|22)px/)
  assert.doesNotMatch(css, /border-radius:50%/)

  // Spacing only uses the 4/8/12/16/24 rhythm (0 means "none").
  const allowedSpacing = [0, 4, 8, 12, 16, 24]
  for (const gap of cssValueList(css, 'gap')) {
    for (const token of spacingTokens(gap)) {
      assert.ok(allowedSpacing.indexOf(token) >= 0, 'unexpected gap: ' + gap)
    }
  }
  for (const padding of cssValueList(css, 'padding')) {
    for (const token of spacingTokens(padding)) {
      assert.ok(allowedSpacing.indexOf(token) >= 0, 'unexpected padding: ' + padding)
    }
  }
})

test('every focusable control family has a visible focus treatment', () => {
  const css = hook.getCss() + hook.getOverlayCss()
  const selectors = [
    'nw-search',
    'nw-filter',
    'nw-mini',
    'nw-iconbtn',
    'nw-add',
    'nw-tag-input',
    'nw-link-field',
    'nw-attach-btn',
    'nw-swatch',
    'nw-chip',
    'nw-chip-input',
    'nw-menu-item',
    'nw-cat-chip',
    'nw-dialog-input',
    'nw-move-option',
    'nw-signature',
    'nw-ov-btn',
    'nw-set-range',
    'nw-select-check',
    'nw-note',
    'nw-note-thumb',
    'nw-note-link',
    'nw-note-image',
  ]
  for (const selector of selectors) {
    assert.ok(
      css.indexOf('.' + selector + ':focus-visible') >= 0
        || css.indexOf('.' + selector + ':focus-within') >= 0,
      'missing focus treatment for ' + selector,
    )
  }
  for (const selector of ['nw-set-row input', 'nw-radio-row input', 'nw-set-inline select', 'nw-select-bar select', 'nw-edit-remind input']) {
    assert.ok(css.indexOf('.' + selector + ':focus-visible') >= 0, 'missing focus treatment for ' + selector)
  }
  assert.match(css, /\.nw-root :focus-visible,[^{]*:focus-visible[^{]*\{outline:2px solid var\(--nw-focus\)/)
})

test('the error banner is a banner variant with icon, text and one action', () => {
  const retryCalls = []
  const bannerNodes = collect(hook.ErrorBanner({
    t: zh,
    text: '读取失败，请重试。',
    onRetry() { retryCalls.push('retry') },
  }))
  const banner = bannerNodes[0]
  assert.equal(banner.props.role, 'alert')
  assert.equal(banner.props.className, 'nw-banner nw-banner-error')
  assert.ok(byClass(bannerNodes, 'nw-banner-icon'), 'error icon missing')
  assert.equal(textContent(byClass(bannerNodes, 'nw-banner-text')), '读取失败，请重试。')
  const retry = bannerNodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '重试'
  })
  assert.ok(retry, 'retry action missing')
  retry.props.onClick()
  assert.deepEqual(retryCalls, ['retry'])
  assert.equal(bannerNodes.some(function (node) {
    return node.props && typeof node.props.className === 'string' && node.props.className.indexOf('nw-note') >= 0
  }), false, 'the error variant must not open a new card')

  const dismissCalls = []
  const dismissNodes = collect(hook.ErrorBanner({
    t: zh,
    text: '保存失败。',
    onDismiss() { dismissCalls.push('dismiss') },
  }))
  const dismiss = dismissNodes.find(function (node) {
    return node.type === 'button' && textContent(node) === '关闭'
  })
  assert.ok(dismiss, 'dismiss action missing')
  dismiss.props.onClick()
  assert.deepEqual(dismissCalls, ['dismiss'])

  const css = hook.getCss()
  assert.match(css, /\.nw-banner-error\{[^}]*state-error-secondary[^}]*state-error-primary/)
  assert.match(css, /\.nw-banner-icon\{/)
  assert.match(css, /\.nw-dialog-error\{[^}]*display:flex/)
})

test('disabled controls dim predictably and never invite interaction', () => {
  const css = hook.getCss()
  assert.match(css, /\.nw-root button:disabled,[\s\S]*?opacity:\.5;cursor:not-allowed/)
  assert.match(css, /\.nw-mini:disabled\{opacity:\.5;cursor:not-allowed\}/)
  assert.match(css, /\.nw-add:hover:not\(:disabled\)/)
  assert.match(css, /\.nw-move-option:focus-visible/)
})

test('the loading row waits 300ms and the gate is wired into the page', async () => {
  assert.equal(hook.LOADING_DELAY_MS, 300)
  assert.equal(hook.loadingIndicatorVisible('loading', false), false, 'a fast read shows nothing')
  assert.equal(hook.loadingIndicatorVisible('loading', true), true)
  assert.equal(hook.loadingIndicatorVisible('ready', true), false)
  assert.equal(hook.loadingIndicatorVisible('error', true), false)

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /loadingIndicatorVisible\(status, loadingVisible\)/)
  assert.match(source, /setTimeout\(function \(\) \{[\s\S]{0,160}\}, LOADING_DELAY_MS\)/)
  assert.match(hook.getCss(), /\.nw-loading\{[^}]*padding:24px 0/)
})

test('Escape resolves exactly the topmost surface by z-order', () => {
  assert.equal(hook.topMostLayer([]), '')
  assert.equal(hook.topMostLayer(['settings']), 'settings')
  assert.equal(hook.topMostLayer(['signature', 'settings']), 'settings', 'the modal is above the popover')
  assert.equal(hook.topMostLayer(['settings', 'reminder-overlay']), 'reminder-overlay', 'the host overlay layer is above in-page dialogs')
  assert.equal(hook.topMostLayer(['signature', 'import', 'reminder-overlay']), 'reminder-overlay')
  assert.ok(hook.DIALOG_LAYER_PRIORITY.settings < hook.DIALOG_LAYER_PRIORITY['reminder-overlay'])
  assert.equal(hook.topMostLayer(['mystery', 'settings']), 'settings', 'unknown layers never win')
})

test('the settings dialog traps focus, closes on Escape/backdrop and wires focus return', async () => {
  const calls = []
  const tree = hook.SettingsPanel({
    settings: cloneDefaultSettings(),
    t: zh,
    busy: false,
    error: '',
    notice: '',
    onSave() {},
    onReset() {},
    onClose() { calls.push('close') },
  })
  const nodes = collect(tree)
  const dialog = byId(nodes, 'nw-settings-panel')
  assert.ok(dialog, 'settings dialog missing')
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(typeof dialog.props.onKeyDown, 'function')

  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, currentTarget: dialog })
  assert.deepEqual(calls, ['close'], 'Escape closes the topmost settings dialog')

  const first = { focus() { calls.push('focus-first') } }
  const last = { focus() { calls.push('focus-last') } }
  client.document.activeElement = last
  dialog.props.onKeyDown({
    key: 'Tab',
    shiftKey: false,
    preventDefault() {},
    currentTarget: { querySelectorAll() { return [first, last] } },
  })
  assert.ok(calls.indexOf('focus-first') >= 0, 'Tab wraps from the last control to the first')
  client.document.activeElement = first
  dialog.props.onKeyDown({
    key: 'Tab',
    shiftKey: true,
    preventDefault() {},
    currentTarget: { querySelectorAll() { return [first, last] } },
  })
  assert.ok(calls.indexOf('focus-last') >= 0, 'Shift+Tab wraps from the first control to the last')

  const backdrop = nodes.find(function (node) {
    return node.props && node.props.className === 'nw-settings-backdrop'
  })
  assert.ok(backdrop, 'settings backdrop missing')
  backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
  assert.ok(calls.filter(function (call) { return call === 'close' }).length >= 2, 'backdrop click closes')
  backdrop.props.onMouseDown({ target: dialog, currentTarget: backdrop })
  assert.equal(calls.filter(function (call) { return call === 'close' }).length, 2, 'inside clicks never close')

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /settingsOpen[\s\S]{0,500}settingsCloseRef\.current[\s\S]{0,120}\.focus\(\)/, 'focus enters the dialog')
  assert.match(source, /settingsWasOpenRef\.current[\s\S]{0,260}settingsButtonRef\.current[\s\S]{0,120}\.focus\(\)/, 'focus returns to the trigger')
  assert.match(source, /SETTINGS_PANEL_ID,[\s\S]{0,240}onKeyDown: onKeyDown/, 'the dialog carries the keyboard contract')
})

test('focus trap helpers and edit-cancel focus are testable units', () => {
  const first = { name: 'first' }
  const middle = { name: 'middle' }
  const last = { name: 'last' }
  const items = [first, middle, last]
  assert.equal(hook.focusTrapTarget(items, last, false), first, 'Tab wraps forward')
  assert.equal(hook.focusTrapTarget(items, first, true), last, 'Shift+Tab wraps backward')
  assert.equal(hook.focusTrapTarget(items, middle, false), null, 'no wrap in the middle')
  assert.equal(hook.focusTrapTarget([], first, false), null)

  let focused = 0
  const card = { focus() { focused += 1 } }
  assert.equal(hook.editFocusTarget(false, null, card), null, 'a fresh card never steals focus')
  assert.equal(hook.editFocusTarget(true, { id: 'editing' }, card), null, 'still editing keeps the editor focus')
  assert.equal(hook.editFocusTarget(true, null, card), card, 'closing the editor targets the card')
  card.focus()
  assert.equal(focused, 1)

  const tree = hook.NoteCard(baseProps(sampleNote()))
  assert.ok(tree.props.ref, 'the card exposes a ref for focus return')
})

test('the reminder overlay registers as the top layer and closes on Esc/outside', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /pushDialogLayer\(DIALOG_LAYER_OVERLAY\)/)
  assert.match(source, /isTopDialogLayer\(DIALOG_LAYER_OVERLAY\)/)
  assert.match(source, /document\.addEventListener\('mousedown', onPointerDown\)/)
  assert.match(source, /data-nw-overlay-card/)
  assert.match(source, /returnFocusRef/)
  assert.match(hook.getOverlayCss(), /\.nw-ov-layer\{[^}]*z-index:950/)
  assert.match(source, /nw-settings-page' \+ \(colorScheme === 'dark' \? ' nw-dark' : ''\)/, 'the settings page follows the host scheme')
})
