import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

const quietLogger = { warn() {}, error() {}, info() {} }
const ROUTE_PATH = '/plugins/dsh-note-wall/api'

function makeRequest(body) {
  const stream = Readable.from([Buffer.from(body, 'utf8')])
  stream.method = 'POST'
  stream.headers = {
    host: '127.0.0.1:58893',
    origin: 'http://127.0.0.1:58893',
    'content-type': 'application/json',
    'x-dsh-note-wall': '1',
  }
  stream.url = '/'
  return stream
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(text) {
      this.body = text === undefined ? '' : String(text)
    },
  }
}

async function call(route, payload) {
  const res = makeResponse()
  await route.handler(makeRequest(JSON.stringify(payload)), res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-note-wall-tool-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = []
  const routes = []
  const disposers = []
  const ctx = {
    logger: quietLogger,
    get() { return undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  try {
    apply(ctx)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  assert.equal(tools.length, 1, 'expected exactly one tool registration')
  const route = routes.find(entry => entry.kind === 'exact' && entry.path === ROUTE_PATH)
  assert.ok(route, 'note API route missing')
  return {
    home,
    tool: tools[0],
    route,
    async cleanup() {
      for (const dispose of disposers) dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

async function enableAgentWrite(route) {
  const result = await call(route, { action: 'settingsUpdate', agentWrite: { enabled: true } })
  assert.equal(result.status, 200)
  assert.equal(result.json.value.settings.agentWrite.enabled, true)
}

test('registers note_wall_add with the v1.2.0 parameter surface', async () => {
  const { tool, cleanup } = await setup()
  try {
    assert.equal(tool.name, 'note_wall_add')
    assert.deepEqual(Array.from(tool.parameters.required), ['text'])
    for (const key of ['text', 'category', 'color', 'link', 'remindAt', 'folderId', 'folderName']) {
      assert.equal(tool.parameters.properties[key].type, 'string')
    }
    assert.equal(tool.parameters.properties.image, undefined, 'v1.2.0 tool must not accept images')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.match(tool.description, /remindAt/)
    assert.match(tool.description, /folderName/)
    assert.equal(tool.output.render(undefined, { note: { text: '一条便签' } })[0].type, 'text')
  } finally {
    await cleanup()
  }
})

test('adds a note through the agent tool and persists it', async () => {
  const { home, tool, route, cleanup } = await setup()
  try {
    await enableAgentWrite(route)
    const value = await tool.execute({
      text: '  工具写一条  ',
      category: ' 代理 ',
      color: 'mint',
      link: 'https://example.com/x',
      remindAt: '2026-02-03T04:05:06.000Z',
      folderName: ' 代理任务 ',
    })
    assert.equal(value.note.text, '工具写一条')
    assert.equal(value.note.tag, '代理')
    assert.equal(value.note.tone, 'mint')
    assert.equal(value.note.link, 'https://example.com/x')
    assert.equal(value.note.image, '')
    assert.equal(value.note.remindAt, '2026-02-03T04:05:06.000Z')

    const stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.notes.length, 1)
    assert.equal(stored.notes[0].text, '工具写一条')
    assert.equal(stored.notes[0].image, '')
    assert.equal(stored.folders.length, 1)
    assert.equal(stored.folders[0].name, '代理任务')
    assert.equal(value.note.folderId, stored.folders[0].id)

    const settings = JSON.parse(await readFile(join(home, 'note-wall', 'settings.json'), 'utf8'))
    assert.equal(settings.agentWrite.enabled, true)
  } finally {
    await cleanup()
  }
})

test('defaults color to amber and rejects invalid arguments', async () => {
  const { tool, route, cleanup } = await setup()
  try {
    await enableAgentWrite(route)
    const value = await tool.execute({ text: '默认色' })
    assert.equal(value.note.tone, 'amber')
    assert.equal(value.note.folderId, '')
    assert.equal(value.note.remindAt, '')

    await assert.rejects(tool.execute({ text: '   ' }), error => error.code === 'note-text-required')
    await assert.rejects(tool.execute({ text: 'x', color: 'magenta' }), error => error.code === 'note-tone-invalid')
    await assert.rejects(tool.execute({ text: 'x', link: 'javascript:alert(1)' }), error => error.code === 'note-link-invalid')
    await assert.rejects(tool.execute({ text: 'x', category: 'x'.repeat(25) }), error => error.code === 'note-tag-too-long')
    await assert.rejects(tool.execute({ text: 'x', remindAt: 'never' }), error => error.code === 'note-remind-invalid')
    await assert.rejects(tool.execute({ text: 'x', folderId: 'missing' }), error => error.code === 'note-folder-invalid')
    await assert.rejects(
      tool.execute({ text: 'x', folderName: 'x'.repeat(41) }),
      error => error.code === 'folder-name-too-long',
    )
  } finally {
    await cleanup()
  }
})

test('the agent tool is gated by the agentWrite setting', async () => {
  const { tool, route, cleanup } = await setup()
  try {
    await assert.rejects(tool.execute({ text: '被拦截' }), error => error.code === 'tool-disabled')

    await enableAgentWrite(route)
    const value = await tool.execute({ text: '放行' })
    assert.equal(value.note.text, '放行')

    const disabled = await call(route, { action: 'settingsUpdate', agentWrite: { enabled: false } })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.json.value.settings.agentWrite.enabled, false)
    await assert.rejects(tool.execute({ text: '又被拦截' }), error => error.code === 'tool-disabled')
  } finally {
    await cleanup()
  }
})

test('folderName reuses an exact name and folderId wins over folderName', async () => {
  const { home, tool, route, cleanup } = await setup()
  try {
    await enableAgentWrite(route)
    const first = await tool.execute({ text: '一', folderName: '工作' })
    const second = await tool.execute({ text: '二', folderName: ' 工作 ' })
    assert.equal(second.note.folderId, first.note.folderId)
    let stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.folders.length, 1)

    const other = await tool.execute({ text: '三', folderName: '生活' })
    assert.notEqual(other.note.folderId, first.note.folderId)

    const explicit = await tool.execute({ text: '四', folderId: first.note.folderId, folderName: '生活' })
    assert.equal(explicit.note.folderId, first.note.folderId)
    stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.folders.length, 2)
  } finally {
    await cleanup()
  }
})
