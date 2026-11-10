// dsh-note-wall — Host route tests.
//
// Exercises the real apply(ctx) with a fake Cordis context, so the HTTP
// contract (admission, parsing, error mapping, persistence) is verified without
// a browser or a live Harness process.
//
// Explicit file list: node --test test/route.test.mjs
// (under this deployment's sandbox, run the file directly instead: node test/route.test.mjs)

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

const quietLogger = { warn() {}, error() {}, info() {} }

async function setup(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-note-wall-home-'))
  if (typeof options.prepare === 'function') await options.prepare(home)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = []
  const effects = []
  const ctx = {
    logger: quietLogger,
    get(name) {
      return options.connection !== undefined && name === 'connection' ? options.connection : undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { routes.length = 0 }
      },
    },
    effect(effect) {
      const dispose = effect()
      effects.push(dispose)
      return dispose
    },
  }
  try {
    apply(ctx)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  assert.equal(routes.length, 3, 'expected the note, upload and image routes')
  const route = routes.find(entry => entry.kind === 'exact' && entry.path === '/plugins/dsh-note-wall/api')
  const uploadRoute = routes.find(entry => entry.kind === 'exact' && entry.path === '/plugins/dsh-note-wall/image')
  const imageRoute = routes.find(entry => entry.kind === 'prefix' && entry.path === '/plugins/dsh-note-wall/image')
  assert.ok(route, 'note API route missing')
  assert.ok(uploadRoute, 'image upload route missing')
  assert.ok(imageRoute, 'image read route missing')
  assert.equal(imageRoute.kind, 'prefix')
  assert.equal(imageRoute.path, '/plugins/dsh-note-wall/image')
  assert.equal(imageRoute.path.endsWith('/'), false, 'prefix route must not end with a slash')
  return {
    home,
    route,
    uploadRoute,
    imageRoute,
    routes,
    async cleanup() {
      for (const dispose of effects) {
        if (typeof dispose === 'function') dispose()
      }
      await rm(home, { recursive: true, force: true })
    },
  }
}

function makeRequest({ method = 'POST', headers = {}, body = '', url = '/' } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const stream = payload.length > 0 ? Readable.from([payload]) : Readable.from([])
  stream.method = method
  stream.headers = headers
  stream.url = url
  return stream
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    raw: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(text) {
      if (text === undefined) {
        this.body = ''
        return
      }
      if (Buffer.isBuffer(text)) {
        this.raw = text
        this.body = text.toString('utf8')
        return
      }
      this.body = String(text)
    },
  }
}

function jsonHeaders(overrides = {}) {
  return {
    host: '127.0.0.1:58893',
    origin: 'http://127.0.0.1:58893',
    'content-type': 'application/json',
    'x-dsh-note-wall': '1',
    ...overrides,
  }
}

function imageHeaders(type = 'image/png', overrides = {}) {
  return {
    host: '127.0.0.1:58893',
    origin: 'http://127.0.0.1:58893',
    'content-type': type,
    'x-dsh-note-wall': '1',
    ...overrides,
  }
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function call(route, { payload, method, headers, body, url } = {}) {
  const text = body !== undefined ? body : JSON.stringify(payload ?? {})
  const res = makeResponse()
  await route.handler(makeRequest({ method, headers: headers ?? jsonHeaders(), body: text, url }), res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: res.headers, body: res.body, raw: res.raw, json }
}

// Mirrors @deepseek-ai/dsh-host-webserver's HTTP match: the exact table first,
// then the longest prefix where `pathname === prefix || pathname.startsWith(
// prefix + '/')`. The trailing-slash rule is exactly what the v1.1.0 image
// route got wrong.
function matchRegisteredRoute(routes, pathname) {
  const exact = routes.find(entry => entry.kind === 'exact' && entry.path === pathname)
  if (exact !== undefined) return exact
  let best
  for (const entry of routes) {
    if (entry.kind !== 'prefix') continue
    if (entry.path !== pathname && !pathname.startsWith(`${entry.path}/`)) continue
    if (best === undefined || entry.path.length > best.path.length) best = entry
  }
  return best
}

test('rejects requests without the plugin header, wrong origin, wrong method and wrong type', async () => {
  const { route, cleanup } = await setup()
  try {
    const noHeader = await call(route, { payload: { action: 'state' }, headers: jsonHeaders({ 'x-dsh-note-wall': '' }) })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.json.error.code, 'forbidden')

    const wrongOrigin = await call(route, {
      payload: { action: 'state' },
      headers: jsonHeaders({ origin: 'http://evil.example' }),
    })
    assert.equal(wrongOrigin.status, 403)

    const get = await call(route, { method: 'GET', body: '' })
    assert.equal(get.status, 405)
    assert.equal(get.json.error.code, 'method-not-allowed')

    const form = await call(route, {
      payload: { action: 'state' },
      headers: jsonHeaders({ 'content-type': 'text/plain' }),
    })
    assert.equal(form.status, 415)
    assert.equal(form.json.error.code, 'unsupported-media-type')
  } finally {
    await cleanup()
  }
})

test('state, add, update and remove round-trip and persist under DSH_HOME', async () => {
  const { home, route, cleanup } = await setup()
  try {
    const empty = await call(route, { payload: { action: 'state' } })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.value.notes, [])
    assert.deepEqual(empty.json.value.limits, {
      maxNotes: 500,
      maxNoteChars: 500,
      maxTagChars: 24,
      maxLinkChars: 2048,
      maxImageBytes: 3 * 1024 * 1024,
    })

    const added = await call(route, {
      payload: { action: 'add', text: '给每个想法，一个落脚的地方。', tag: '产品灵感', tone: 'amber' },
    })
    assert.equal(added.status, 200)
    assert.equal(added.json.value.notes.length, 1)
    const note = added.json.value.note
    assert.equal(note.text, '给每个想法，一个落脚的地方。')
    assert.equal(note.tag, '产品灵感')
    assert.equal(note.tone, 'amber')
    assert.match(note.id, /^[0-9a-f-]{36}$/)

    const stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.version, 1)
    assert.deepEqual(stored.notes, [note])

    const updated = await call(route, {
      payload: { action: 'update', id: note.id, text: '改了主意也没关系。', tone: 'mint' },
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.json.value.note.text, '改了主意也没关系。')
    assert.equal(updated.json.value.note.tone, 'mint')
    assert.equal(updated.json.value.notes.length, 1)

    const removed = await call(route, { payload: { action: 'remove', id: note.id } })
    assert.equal(removed.status, 200)
    assert.equal(removed.json.value.removed, true)
    assert.deepEqual(removed.json.value.notes, [])

    const again = await call(route, { payload: { action: 'remove', id: note.id } })
    assert.equal(again.status, 200)
    assert.equal(again.json.value.removed, false)
  } finally {
    await cleanup()
  }
})

test('maps validation failures to coded 400 responses', async () => {
  const { route, cleanup } = await setup()
  try {
    const cases = [
      [{ action: 'nope' }, 'unknown-action'],
      [{ action: 'add', text: '   ' }, 'note-text-required'],
      [{ action: 'add', text: 'ok', tone: 'magenta' }, 'note-tone-invalid'],
      [{ action: 'update', id: 'missing', text: 'x' }, 'note-not-found'],
      [{ action: 'update', text: 'x' }, 'note-id-required'],
      [{ action: 'remove', id: 'missing' }, 200],
    ]
    for (const [payload, expected] of cases) {
      const result = await call(route, { payload })
      if (expected === 200) {
        assert.equal(result.status, 200)
        assert.equal(result.json.value.removed, false)
      } else {
        assert.equal(result.status, 400, JSON.stringify(payload))
        assert.equal(result.json.error.code, expected, JSON.stringify(payload))
      }
    }
  } finally {
    await cleanup()
  }
})

test('rejects malformed, non-object and oversized JSON bodies', async () => {
  const { route, cleanup } = await setup()
  try {
    const malformed = await call(route, { body: '{ not json' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.json.error.code, 'invalid-json')

    const arrayBody = await call(route, { body: '[]' })
    assert.equal(arrayBody.status, 400)
    assert.equal(arrayBody.json.error.code, 'invalid-body')

    const oversized = await call(route, {
      body: JSON.stringify({ action: 'state', pad: 'x'.repeat(300 * 1024) }),
    })
    assert.equal(oversized.status, 413)
    assert.equal(oversized.json.error.code, 'body-too-large')
  } finally {
    await cleanup()
  }
})

test('reports 503 when a corrupt store cannot be preserved', async () => {
  const originalNow = Date.now
  const fixedNow = Date.parse('2026-01-02T03:04:05.000Z')
  Date.now = () => fixedNow
  let handle
  try {
    const target = 'store.corrupt-' + new Date(fixedNow).toISOString().replace(/[:.]/g, '-') + '.json'
    handle = await setup({
      async prepare(home) {
        const storeDir = join(home, 'note-wall')
        await mkdir(join(storeDir, target), { recursive: true })
        await writeFile(join(storeDir, 'store.json'), 'not json at all', 'utf8')
      },
    })
    const result = await call(handle.route, { payload: { action: 'state' } })
    assert.equal(result.status, 503)
    assert.equal(result.json.error.code, 'store-corrupt-unreadable')
  } finally {
    if (handle !== undefined) await handle.cleanup()
    Date.now = originalNow
  }
})

test('honours a connection admission service when present', async () => {
  const rejectAll = { requestRejection: () => ({ status: 403 }) }
  const { route, cleanup } = await setup({ connection: rejectAll })
  try {
    const rejected = await call(route, { payload: { action: 'state' } })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.json.error.code, 'forbidden')
  } finally {
    await cleanup()
  }

  const admitAll = { requestRejection: () => undefined }
  const second = await setup({ connection: admitAll })
  try {
    const allowed = await call(second.route, { payload: { action: 'state' } })
    assert.equal(allowed.status, 200)
    assert.deepEqual(allowed.json.value.notes, [])
  } finally {
    await second.cleanup()
  }
})

test('image prefix route matches the real request path and serves the bytes', async () => {
  const { uploadRoute, imageRoute, routes, cleanup } = await setup()
  try {
    const uploaded = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders() })
    assert.equal(uploaded.status, 200)
    const id = uploaded.json.value.id
    assert.match(id, /^[0-9a-f-]{36}\.png$/)

    const requestPath = '/plugins/dsh-note-wall/image/' + id
    const matched = matchRegisteredRoute(routes, requestPath)
    assert.equal(matched, imageRoute, 'the registered prefix must match /image/<id>')

    const served = await call(matched, {
      method: 'GET',
      headers: {},
      body: '',
      url: requestPath,
    })
    assert.equal(served.status, 200)
    assert.equal(served.headers['content-type'], 'image/png')
    assert.deepEqual(served.raw, PNG_BYTES)
  } finally {
    await cleanup()
  }
})

test('uploads, serves and deletes a note image', async () => {
  const { home, route, uploadRoute, imageRoute, cleanup } = await setup()
  try {
    const uploaded = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders() })
    assert.equal(uploaded.status, 200)
    const id = uploaded.json.value.id
    assert.match(id, /^[0-9a-f-]{36}\.png$/)

    const file = join(home, 'note-wall', 'images', id)
    assert.deepEqual(await readFile(file), PNG_BYTES)

    const served = await call(imageRoute, {
      method: 'GET',
      headers: {},
      body: '',
      url: '/plugins/dsh-note-wall/image/' + id,
    })
    assert.equal(served.status, 200)
    assert.equal(served.headers['content-type'], 'image/png')
    assert.match(served.headers['cache-control'], /immutable/)
    assert.deepEqual(served.raw, PNG_BYTES)

    const added = await call(route, {
      payload: { action: 'add', text: '看图', link: 'https://example.com/x', image: id },
    })
    assert.equal(added.status, 200)
    assert.equal(added.json.value.note.image, id)
    assert.equal(added.json.value.note.link, 'https://example.com/x')

    const removed = await call(route, { payload: { action: 'remove', id: added.json.value.note.id } })
    assert.equal(removed.status, 200)
    await assert.rejects(access(file), 'note image should be deleted with its note')
  } finally {
    await cleanup()
  }
})

test('discardImage removes an unreferenced upload and keeps a referenced one', async () => {
  const { home, route, uploadRoute, cleanup } = await setup()
  try {
    const first = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders() })
    const firstId = first.json.value.id
    const firstFile = join(home, 'note-wall', 'images', firstId)
    await access(firstFile)

    const added = await call(route, { payload: { action: 'add', text: '引用中', image: firstId } })
    assert.equal(added.status, 200)
    const referenced = await call(route, { payload: { action: 'discardImage', id: firstId } })
    assert.equal(referenced.json.value.discarded, false, 'referenced image must be kept')
    await access(firstFile)

    const second = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders() })
    const secondId = second.json.value.id
    const secondFile = join(home, 'note-wall', 'images', secondId)
    const discarded = await call(route, { payload: { action: 'discardImage', id: secondId } })
    assert.equal(discarded.json.value.discarded, true)
    await assert.rejects(access(secondFile))
  } finally {
    await cleanup()
  }
})

test('rejects bad image uploads and malformed image reads', async () => {
  const { uploadRoute, imageRoute, cleanup } = await setup()
  try {
    const noHeader = await call(uploadRoute, {
      body: PNG_BYTES,
      headers: imageHeaders('image/png', { 'x-dsh-note-wall': '' }),
    })
    assert.equal(noHeader.status, 403)

    const wrongType = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders('text/plain') })
    assert.equal(wrongType.status, 415)
    assert.equal(wrongType.json.error.code, 'image-type-invalid')

    const mismatch = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders('image/gif') })
    assert.equal(mismatch.status, 415)

    const junk = await call(uploadRoute, { body: Buffer.from('not an image at all'), headers: imageHeaders() })
    assert.equal(junk.status, 415)

    const oversized = await call(uploadRoute, {
      body: Buffer.alloc(3 * 1024 * 1024 + 1, 1),
      headers: imageHeaders(),
    })
    assert.equal(oversized.status, 413)
    assert.equal(oversized.json.error.code, 'image-too-large')

    for (const suffix of ['missing.png', '..%2F..%2Fstore.json', 'not-a-uuid.png', '']) {
      const read = await call(imageRoute, {
        method: 'GET',
        headers: {},
        body: '',
        url: '/plugins/dsh-note-wall/image/' + suffix,
      })
      assert.equal(read.status, 404, suffix)
    }

    const wrongMethod = await call(imageRoute, {
      method: 'POST',
      headers: {},
      body: '',
      url: '/plugins/dsh-note-wall/image/x.png',
    })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await cleanup()
  }
})

test('refuses uploads while the note store is unavailable', async () => {
  const { home, uploadRoute, cleanup } = await setup({
    async prepare(home) {
      // A directory where store.json belongs makes the store unreadable.
      await mkdir(join(home, 'note-wall', 'store.json'), { recursive: true })
    },
  })
  try {
    const result = await call(uploadRoute, { body: PNG_BYTES, headers: imageHeaders() })
    assert.equal(result.status, 503)
    assert.equal(result.json.error.code, 'store-unavailable')
    await assert.rejects(access(join(home, 'note-wall', 'images')), 'no image may be written')
  } finally {
    await cleanup()
  }
})

test('rejects a missing image reference and a stale edit through the API', async () => {
  const { route, cleanup } = await setup()
  try {
    const MISSING = '33333333-3333-4333-8333-333333333333.png'
    const missing = await call(route, { payload: { action: 'add', text: 'x', image: MISSING } })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'note-image-missing')

    const added = await call(route, { payload: { action: 'add', text: 'fresh' } })
    assert.equal(added.status, 200)
    const note = added.json.value.note

    const stale = await call(route, {
      payload: { action: 'update', id: note.id, text: 'stale', baseUpdatedAt: '2020-01-01T00:00:00.000Z' },
    })
    assert.equal(stale.status, 400)
    assert.equal(stale.json.error.code, 'note-conflict')

    const updated = await call(route, {
      payload: { action: 'update', id: note.id, text: 'newer', baseUpdatedAt: note.updatedAt },
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.json.value.note.text, 'newer')
  } finally {
    await cleanup()
  }
})
