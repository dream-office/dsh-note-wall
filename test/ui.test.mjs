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
    createdAt: '2026-11-10T12:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
  }, overrides || {})
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
