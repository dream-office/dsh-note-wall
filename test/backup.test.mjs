// dsh-note-wall — Host ZIP backup/restore tests.
//
// Covers the hand-written ZIP codec, the export layout, replace/merge restore
// semantics, image handling, validation limits, settings import, safety
// backups and real Windows extraction (Expand-Archive / tar) when available.
//
// Explicit file list: node --test test/backup.test.mjs
// (under this deployment's sandbox, run the file directly instead: node test/backup.test.mjs)

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import {
  BACKUP_LIMITS,
  buildZip,
  crc32,
  parseArchive,
  readZip,
} from '../lib/backup.js'
import { NoteStore } from '../lib/store.js'

const quietLogger = { warn() {}, error() {}, info() {} }
const BACKUP_PATH = '/plugins/dsh-note-wall/backup'
const NOTE_PATH = '/plugins/dsh-note-wall/api'
const UPLOAD_PATH = '/plugins/dsh-note-wall/image'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// Still a PNG by its magic bytes, but different content from PNG_BYTES.
const PNG_BYTES_ALT = Buffer.concat([PNG_BYTES, Buffer.from([1, 2, 3, 4, 5])])
const ISO = '2026-01-02T03:04:05.000Z'

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-note-wall-backup-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = []
  const effects = []
  const ctx = {
    logger: quietLogger,
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { routes.length = 0 }
      },
    },
    tools: {
      register() {
        return () => {}
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
  assert.equal(routes.length, 4, 'expected the note, upload, backup and image routes')
  const backupRoute = routes.find(entry => entry.kind === 'exact' && entry.path === BACKUP_PATH)
  const noteRoute = routes.find(entry => entry.kind === 'exact' && entry.path === NOTE_PATH)
  const uploadRoute = routes.find(entry => entry.kind === 'exact' && entry.path === UPLOAD_PATH)
  assert.ok(backupRoute, 'backup route missing')
  assert.ok(noteRoute, 'note route missing')
  assert.ok(uploadRoute, 'upload route missing')
  return {
    home,
    backupRoute,
    noteRoute,
    uploadRoute,
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

const HOST = '127.0.0.1:58893'

function baseHeaders(overrides = {}) {
  return {
    host: HOST,
    origin: `http://${HOST}`,
    'x-dsh-note-wall': '1',
    ...overrides,
  }
}

function jsonHeaders(overrides = {}) {
  return baseHeaders({ 'content-type': 'application/json', ...overrides })
}

function imageHeaders(type = 'image/png', overrides = {}) {
  return baseHeaders({ 'content-type': type, ...overrides })
}

function zipHeaders(overrides = {}) {
  return baseHeaders({ 'content-type': 'application/zip', ...overrides })
}

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

async function noteState(noteRoute) {
  const result = await call(noteRoute, { payload: { action: 'state' } })
  assert.equal(result.status, 200)
  return result.json.value
}

async function addFolder(noteRoute, name) {
  const result = await call(noteRoute, { payload: { action: 'folderAdd', name } })
  assert.equal(result.status, 200)
  return result.json.value.folder
}

async function addNote(noteRoute, payload) {
  const result = await call(noteRoute, { payload: { action: 'add', ...payload } })
  assert.equal(result.status, 200, result.body)
  return result.json.value.note
}

async function uploadImage(uploadRoute, bytes = PNG_BYTES) {
  const result = await call(uploadRoute, { body: bytes, headers: imageHeaders() })
  assert.equal(result.status, 200, result.body)
  return result.json.value.id
}

async function exportBackup(backupRoute, query = '') {
  return call(backupRoute, {
    method: 'GET',
    headers: baseHeaders(),
    body: '',
    url: BACKUP_PATH + query,
  })
}

async function importBackup(backupRoute, buffer, query = '?mode=replace') {
  return call(backupRoute, {
    method: 'POST',
    headers: zipHeaders(),
    body: buffer,
    url: BACKUP_PATH + query,
  })
}

function entriesOf(buffer) {
  return readZip(buffer)
}

function entryMap(buffer) {
  return new Map(readZip(buffer).map(entry => [entry.name, entry.data]))
}

function jsonEntry(buffer, name) {
  const data = entryMap(buffer).get(name)
  assert.ok(data, `${name} missing from archive`)
  return JSON.parse(data.toString('utf8'))
}

function findSignature(buffer, signature) {
  const needle = Buffer.alloc(4)
  needle.writeUInt32LE(signature, 0)
  return buffer.indexOf(needle)
}

function noteRecord(overrides = {}) {
  return {
    id: randomUUID(),
    text: '备份便签',
    tag: '',
    tone: 'amber',
    link: '',
    image: '',
    folderId: '',
    remindAt: '',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  }
}

function folderRecord(id = randomUUID(), name = '工作') {
  return { id, name, createdAt: ISO }
}

function makeDocument(notes = [], folders = []) {
  return { format: 'dsh-note-wall-backup', version: 2, exportedAt: ISO, notes, folders }
}

function makeManifest(document, images, settings) {
  return {
    formatVersion: 2,
    createdAt: ISO,
    noteCount: document.notes.length,
    folderCount: document.folders.length,
    imageCount: images.length,
    settingsIncluded: settings !== undefined,
    totalBytes: 0,
    files: [],
    missingImages: [],
  }
}

/** Build a small hand-made archive with exactly the entries a test needs. */
function archiveBuffer({
  document = makeDocument(),
  images = [],
  settings,
  extraEntries = [],
  includeNotes = true,
  includeManifest = true,
  notesData,
} = {}) {
  const entries = []
  if (includeNotes) {
    entries.push({
      name: 'notes.json',
      data: notesData ?? Buffer.from(JSON.stringify(document), 'utf8'),
    })
  }
  for (const [id, data] of images) entries.push({ name: `images/${id}`, data })
  if (settings !== undefined) entries.push({ name: 'settings.json', data: Buffer.from(JSON.stringify(settings), 'utf8') })
  if (includeManifest) {
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(makeManifest(document, images, settings)), 'utf8') })
  }
  entries.push(...extraEntries)
  return buildZip(entries)
}

// ---------------------------------------------------------------------------
// ZIP codec
// ---------------------------------------------------------------------------

test('ZIP writer emits standard headers and the reader round-trips contents', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC32 must match the IEEE reference value')
  const archive = buildZip([
    { name: '中文.txt', data: '你好' },
    { name: 'notes.json', data: '{"ok":true}' },
  ], { now: new Date('2026-01-02T03:04:05.000Z') })

  assert.equal(archive.readUInt32LE(0), 0x04034b50, 'first local file header signature')
  assert.equal(archive.readUInt16LE(6) & 0x0800, 0x0800, 'non-ASCII name needs the UTF-8 flag')
  assert.equal(archive.readUInt16LE(6) & 0x0008, 0, 'no data descriptor')
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50, 'EOCD at the end with no comment')

  const entries = readZip(archive)
  assert.deepEqual(entries.map(entry => entry.name), ['中文.txt', 'notes.json'])
  assert.equal(entries[0].data.toString('utf8'), '你好')
  assert.equal(entries[1].data.toString('utf8'), '{"ok":true}')
})

test('ZIP reader rejects corrupt, encrypted, descriptor, unsupported and unsafe archives', () => {
  const base = buildZip([{ name: 'a.txt', data: 'hello world' }])
  const centralAt = findSignature(base, 0x02014b50)
  assert.ok(centralAt > 0)

  const dataAt = base.indexOf(Buffer.from('hello world'))
  assert.ok(dataAt > 0)
  const badCrc = Buffer.from(base)
  badCrc[dataAt] ^= 0xff
  assert.throws(() => readZip(badCrc), error => error.code === 'backup-invalid-zip')

  const encrypted = Buffer.from(base)
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 0x0001, 6)
  encrypted.writeUInt16LE(encrypted.readUInt16LE(centralAt + 8) | 0x0001, centralAt + 8)
  assert.throws(() => readZip(encrypted), error => /加密/.test(error.message))

  const descriptor = Buffer.from(base)
  descriptor.writeUInt16LE(descriptor.readUInt16LE(6) | 0x0008, 6)
  descriptor.writeUInt16LE(descriptor.readUInt16LE(centralAt + 8) | 0x0008, centralAt + 8)
  assert.throws(() => readZip(descriptor), error => /数据描述符/.test(error.message))

  const unsupportedMethod = Buffer.from(base)
  unsupportedMethod.writeUInt16LE(12, 8)
  unsupportedMethod.writeUInt16LE(12, centralAt + 10)
  assert.throws(() => readZip(unsupportedMethod), error => /压缩方式/.test(error.message))

  assert.throws(() => readZip(Buffer.from('not a zip archive at all')), error => error.code === 'backup-invalid-zip')
  assert.throws(() => readZip(base.subarray(0, base.length - 10)), error => error.code === 'backup-invalid-zip')

  const zip64 = Buffer.from(base)
  const eocd = zip64.length - 22
  zip64.writeUInt16LE(0xffff, eocd + 8)
  zip64.writeUInt16LE(0xffff, eocd + 10)
  assert.throws(() => readZip(zip64), error => /ZIP64/.test(error.message))

  const duplicate = buildZip([{ name: 'same.txt', data: 'a' }, { name: 'same.txt', data: 'b' }])
  assert.throws(() => readZip(duplicate), error => /重复/.test(error.message))

  for (const name of ['../evil', '/absolute', 'images/../../evil', '..\\evil', 'a//b', 'a/./b', 'C:evil']) {
    const unsafe = buildZip([{ name, data: 'x' }])
    assert.throws(() => readZip(unsafe), error => /不安全/.test(error.message), name)
  }
})

test('archive parser rejects unknown entries and malformed documents', () => {
  const unknown = archiveBuffer({ extraEntries: [{ name: 'evil.txt', data: 'x' }] })
  assert.throws(() => parseArchive(unknown), error => error.code === 'backup-invalid-archive')

  const missingManifest = archiveBuffer({ includeManifest: false })
  assert.throws(() => parseArchive(missingManifest), error => /manifest\.json/.test(error.message))

  const missingNotes = buildZip([{ name: 'manifest.json', data: JSON.stringify(makeManifest(makeDocument(), [], undefined)) }])
  assert.throws(() => parseArchive(missingNotes), error => /notes\.json/.test(error.message))

  const badDocument = archiveBuffer({ notesData: Buffer.from('{ not json') })
  assert.throws(() => parseArchive(badDocument), error => error.code === 'backup-invalid-archive')

  const wrongFormat = archiveBuffer({ document: { ...makeDocument(), format: 'other' } })
  assert.throws(() => parseArchive(wrongFormat), error => error.code === 'backup-invalid-archive')

  const badMagic = archiveBuffer({
    images: [[`${randomUUID()}.png`, Buffer.from('this is not a png at all')]],
  })
  assert.throws(() => parseArchive(badMagic), error => error.code === 'backup-invalid-archive')
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('GET backup exports notes, folders, image, settings and manifest headers', async () => {
  const { home, backupRoute, noteRoute, uploadRoute, cleanup } = await setup()
  try {
    const work = await addFolder(noteRoute, '工作')
    const life = await addFolder(noteRoute, '生活')
    const imageId = await uploadImage(uploadRoute)
    await addNote(noteRoute, {
      text: '带图片的便签',
      tag: '灵感',
      image: imageId,
      folderId: work.id,
      remindAt: '2026-02-03T04:05:06.000Z',
    })
    await addNote(noteRoute, { text: '第二条', folderId: life.id })
    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: false, imageDisplay: 'large' } })

    const exported = await exportBackup(backupRoute)
    assert.equal(exported.status, 200)
    assert.equal(exported.headers['content-type'], 'application/zip')
    assert.match(
      exported.headers['content-disposition'],
      /^attachment; filename="note-wall-backup-\d{8}-\d{6}\.zip"$/,
    )
    assert.equal(exported.raw.readUInt32LE(0), 0x04034b50)
    assert.ok(exported.raw.length > 0)

    const entries = entriesOf(exported.raw)
    const names = entries.map(entry => entry.name)
    assert.ok(names.includes('notes.json'))
    assert.ok(names.includes('manifest.json'))
    assert.ok(names.includes('settings.json'))
    assert.ok(names.includes(`images/${imageId}`))

    const document = jsonEntry(exported.raw, 'notes.json')
    assert.equal(document.format, 'dsh-note-wall-backup')
    assert.equal(document.version, 2)
    assert.equal(document.notes.length, 2)
    assert.equal(document.folders.length, 2)
    assert.equal(document.notes.find(note => note.image === imageId).folderId, work.id)

    const manifest = jsonEntry(exported.raw, 'manifest.json')
    assert.equal(manifest.formatVersion, 2)
    assert.equal(manifest.noteCount, 2)
    assert.equal(manifest.folderCount, 2)
    assert.equal(manifest.imageCount, 1)
    assert.equal(manifest.settingsIncluded, true)
    assert.ok(manifest.totalBytes > 0)
    assert.deepEqual(manifest.missingImages, [])
    assert.ok(manifest.files.some(file => file.path === `images/${imageId}`))
    assert.equal(entryMap(exported.raw).get(`images/${imageId}`).equals(PNG_BYTES), true)

    const settings = jsonEntry(exported.raw, 'settings.json')
    assert.equal(settings.version, 1)
    assert.equal(settings.motion, false)
    assert.equal(settings.imageDisplay, 'large')

    // ?settings=0 omits settings.json from both the archive and the manifest.
    const withoutSettings = await exportBackup(backupRoute, '?settings=0')
    assert.equal(withoutSettings.status, 200)
    assert.equal(entriesOf(withoutSettings.raw).some(entry => entry.name === 'settings.json'), false)
    const manifestWithout = jsonEntry(withoutSettings.raw, 'manifest.json')
    assert.equal(manifestWithout.settingsIncluded, false)

    const invalidQuery = await exportBackup(backupRoute, '?settings=2')
    assert.equal(invalidQuery.status, 400)
    assert.equal(invalidQuery.json.error.code, 'backup-query-invalid')

    // The exported archive is a real file a user can keep.
    const file = join(home, 'downloaded.zip')
    await writeFile(file, exported.raw)
    assert.equal((await readFile(file)).equals(exported.raw), true)
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Replace import
// ---------------------------------------------------------------------------

test('replace import restores the wall, applies settings and writes a safety backup first', async () => {
  const { home, backupRoute, noteRoute, uploadRoute, cleanup } = await setup()
  try {
    const work = await addFolder(noteRoute, '工作')
    const life = await addFolder(noteRoute, '生活')
    const imageId = await uploadImage(uploadRoute)
    await addNote(noteRoute, { text: '源便签一', image: imageId, folderId: work.id, remindAt: '2026-02-03T04:05:06.000Z' })
    await addNote(noteRoute, { text: '源便签二', folderId: life.id })
    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: false } })

    const exported = await exportBackup(backupRoute)
    assert.equal(exported.status, 200)
    const sourceDocument = jsonEntry(exported.raw, 'notes.json')

    // Change the wall after the export: extra note, extra image, other settings.
    const extraImageId = await uploadImage(uploadRoute)
    await addNote(noteRoute, { text: '导出之后加的' })
    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: true } })
    await access(join(home, 'note-wall', 'images', extraImageId))

    const imported = await importBackup(backupRoute, exported.raw, '?mode=replace')
    assert.equal(imported.status, 200, imported.body)
    const value = imported.json.value
    assert.equal(value.mode, 'replace')
    assert.equal(value.importedNotes, 2)
    assert.equal(value.skippedNotes, 0)
    assert.equal(value.importedFolders, 2)
    assert.equal(value.imageCount, 1)
    assert.equal(value.settingsIncluded, true)
    assert.equal(value.settingsApplied, true)
    assert.match(value.safetyBackup, /^note-wall-auto-\d{8}-\d{6}\.zip$/)
    assert.equal(value.notes.length, 2)
    assert.equal(value.folders.length, 2)
    assert.equal(value.limits.maxNotes, 500)

    const state = await noteState(noteRoute)
    assert.equal(state.notes.length, 2)
    assert.deepEqual(state.notes.map(note => note.text).sort(), ['源便签一', '源便签二'])
    assert.deepEqual(state.notes.map(note => note.id).sort(), sourceDocument.notes.map(note => note.id).sort())
    assert.ok(state.folders.some(folder => folder.name === '工作'))
    assert.equal(state.notes.find(note => note.image).image, imageId)
    await access(join(home, 'note-wall', 'images', imageId))
    await assert.rejects(access(join(home, 'note-wall', 'images', extraImageId)), 'unreferenced old image should be removed')

    const stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.notes.length, 2)
    assert.equal(stored.folders.length, 2)

    const settings = JSON.parse(await readFile(join(home, 'note-wall', 'settings.json'), 'utf8'))
    assert.equal(settings.motion, false)

    const backupFiles = await readdir(join(home, 'note-wall', 'backups'))
    assert.ok(backupFiles.includes(value.safetyBackup))
    const safety = entryMap(await readFile(join(home, 'note-wall', 'backups', value.safetyBackup)))
    const safetyDocument = JSON.parse(safety.get('notes.json').toString('utf8'))
    assert.equal(safetyDocument.notes.length, 3, 'safety backup must hold the pre-import wall')
    assert.ok(safetyDocument.notes.some(note => note.text === '导出之后加的'))
    assert.equal(safety.has(`images/${imageId}`), true)
    assert.equal(JSON.parse(safety.get('settings.json').toString('utf8')).motion, true, 'safety settings are pre-import')
  } finally {
    await cleanup()
  }
})

test('replace import honours applySettings=0 and rejects a bad applySettings value', async () => {
  const { backupRoute, noteRoute, cleanup } = await setup()
  try {
    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: false } })
    await addNote(noteRoute, { text: '来自备份' })
    const exported = await exportBackup(backupRoute)

    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: true } })
    await addNote(noteRoute, { text: '导入前已有' })

    const kept = await importBackup(backupRoute, exported.raw, '?mode=replace&applySettings=0')
    assert.equal(kept.status, 200, kept.body)
    assert.equal(kept.json.value.settingsIncluded, true)
    assert.equal(kept.json.value.settingsApplied, false)
    const current = await call(noteRoute, { payload: { action: 'settings' } })
    assert.equal(current.json.value.settings.motion, true)
    assert.equal(kept.json.value.notes.length, 1)

    const badValue = await importBackup(backupRoute, exported.raw, '?mode=replace&applySettings=2')
    assert.equal(badValue.status, 400)
    assert.equal(badValue.json.error.code, 'backup-query-invalid')
  } finally {
    await cleanup()
  }
})

test('a failed replace leaves the wall untouched and keeps old images', async () => {
  const { home, backupRoute, noteRoute, uploadRoute, cleanup } = await setup()
  try {
    const imageId = await uploadImage(uploadRoute)
    const existing = await addNote(noteRoute, { text: '必须保留', image: imageId })

    const truncated = (await exportBackup(backupRoute)).raw.subarray(0, 40)
    const failed = await importBackup(backupRoute, truncated, '?mode=replace')
    assert.equal(failed.status, 400)
    assert.equal(failed.json.error.code, 'backup-invalid-zip')

    const state = await noteState(noteRoute)
    assert.equal(state.notes.length, 1)
    assert.equal(state.notes[0].id, existing.id)
    await access(join(home, 'note-wall', 'images', imageId))
    await assert.rejects(access(join(home, 'note-wall', 'backups')), 'no safety backup on a rejected archive')
  } finally {
    await cleanup()
  }
})

test('the replace safety backup failure aborts the import before any write', async () => {
  const { home, backupRoute, noteRoute, cleanup } = await setup()
  try {
    await addNote(noteRoute, { text: '原来的便签' })
    const exported = await exportBackup(backupRoute)
    // A file where the backups directory belongs makes mkdir fail.
    await writeFile(join(home, 'note-wall', 'backups'), 'not a directory', 'utf8')

    const failed = await importBackup(backupRoute, exported.raw, '?mode=replace')
    assert.equal(failed.status, 500)
    assert.equal(failed.json.error.code, 'backup-safety-failed')
    const state = await noteState(noteRoute)
    assert.equal(state.notes.length, 1)
    assert.equal(state.notes[0].text, '原来的便签')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Merge import
// ---------------------------------------------------------------------------

test('merge import appends notes, maps folders by name and never deletes existing data', async () => {
  const source = await setup()
  const target = await setup()
  try {
    const sourceWork = await addFolder(source.noteRoute, '工作')
    const sourceProject = await addFolder(source.noteRoute, '项目')
    const imageId = await uploadImage(source.uploadRoute)
    await addNote(source.noteRoute, {
      text: '导入的带图便签',
      image: imageId,
      folderId: sourceWork.id,
      remindAt: '2026-04-05T06:07:08.000Z',
    })
    await addNote(source.noteRoute, { text: '导入的项目便签', folderId: sourceProject.id })
    await call(source.noteRoute, { payload: { action: 'settingsUpdate', motion: false } })
    const archive = (await exportBackup(source.backupRoute)).raw
    const sourceDocument = jsonEntry(archive, 'notes.json')

    const targetWork = await addFolder(target.noteRoute, '工作')
    const existing = await addNote(target.noteRoute, { text: '已有便签', folderId: targetWork.id })
    await call(target.noteRoute, { payload: { action: 'settingsUpdate', motion: true } })

    const merged = await importBackup(target.backupRoute, archive, '?mode=merge')
    assert.equal(merged.status, 200, merged.body)
    const value = merged.json.value
    assert.equal(value.mode, 'merge')
    assert.equal(value.importedNotes, 2)
    assert.equal(value.skippedNotes, 0)
    assert.equal(value.importedFolders, 1, '工作 is reused, 项目 is created')
    assert.equal(value.imageCount, 1)
    assert.equal(value.settingsIncluded, true)
    assert.equal(value.settingsApplied, false, 'merge must not touch settings by default')
    assert.equal(value.safetyBackup, null)

    const state = await noteState(target.noteRoute)
    assert.equal(state.notes.length, 3)
    assert.ok(state.notes.some(note => note.id === existing.id), 'existing note must survive')
    assert.ok(state.notes.some(note => note.text === '已有便签'))
    const importedWithImage = state.notes.find(note => note.text === '导入的带图便签')
    assert.equal(importedWithImage.remindAt, '2026-04-05T06:07:08.000Z')
    assert.notEqual(importedWithImage.id, sourceDocument.notes.find(note => note.text === '导入的带图便签').id)
    assert.equal(importedWithImage.folderId, targetWork.id)
    const targetProject = state.folders.find(folder => folder.name === '项目')
    assert.ok(targetProject)
    assert.notEqual(targetProject.id, sourceProject.id)
    assert.equal(state.notes.find(note => note.text === '导入的项目便签').folderId, targetProject.id)
    assert.deepEqual(state.folders.map(folder => folder.name).sort(), ['工作', '项目'])

    const currentSettings = await call(target.noteRoute, { payload: { action: 'settings' } })
    assert.equal(currentSettings.json.value.settings.motion, true, 'merge keeps the target settings')

    // Importing the same archive again appends again; identical images are reused.
    const again = await importBackup(target.backupRoute, archive, '?mode=merge')
    assert.equal(again.status, 200, again.body)
    assert.equal(again.json.value.importedNotes, 2)
    assert.equal(again.json.value.importedFolders, 0)
    assert.equal(again.json.value.imageCount, 1, 'the archived image is still counted when reused')
    const after = await noteState(target.noteRoute)
    assert.equal(after.notes.length, 5)
    assert.equal(after.folders.length, 2)
  } finally {
    await source.cleanup()
    await target.cleanup()
  }
})

test('merge gives colliding images new ids and keeps one id per archived image', async () => {
  const { home, backupRoute, noteRoute, cleanup } = await setup()
  try {
    const sharedImageId = `${randomUUID()}.png`
    const identicalImageId = `${randomUUID()}.png`
    const imagesDir = join(home, 'note-wall', 'images')
    await mkdir(imagesDir, { recursive: true })
    await writeFile(join(imagesDir, sharedImageId), PNG_BYTES)
    await writeFile(join(imagesDir, identicalImageId), PNG_BYTES)

    const document = makeDocument([
      noteRecord({ text: '碰撞一', image: sharedImageId }),
      noteRecord({ text: '碰撞二', image: sharedImageId }),
      noteRecord({ text: '相同图', image: identicalImageId }),
    ])
    const archive = archiveBuffer({
      document,
      images: [[sharedImageId, PNG_BYTES_ALT], [identicalImageId, PNG_BYTES]],
    })

    const merged = await importBackup(backupRoute, archive, '?mode=merge')
    assert.equal(merged.status, 200, merged.body)
    assert.equal(merged.json.value.importedNotes, 3)
    assert.equal(merged.json.value.imageCount, 2, 'two distinct archived images are referenced')

    const state = await noteState(noteRoute)
    const first = state.notes.find(note => note.text === '碰撞一')
    const second = state.notes.find(note => note.text === '碰撞二')
    const same = state.notes.find(note => note.text === '相同图')
    assert.notEqual(first.image, sharedImageId)
    assert.equal(first.image, second.image, 'two notes sharing an image keep sharing one new id')
    assert.equal(same.image, identicalImageId, 'identical bytes reuse the existing file')
    assert.equal((await readFile(join(imagesDir, first.image))).equals(PNG_BYTES_ALT), true)
    assert.equal((await readFile(join(imagesDir, sharedImageId))).equals(PNG_BYTES), true, 'old image is untouched')
  } finally {
    await cleanup()
  }
})

test('missing images are skipped and counted, and exports record them in manifest.missingImages', async () => {
  const source = await setup()
  const target = await setup()
  try {
    await addNote(source.noteRoute, { text: '没有图也能导出' })
    const imageId = await uploadImage(source.uploadRoute)
    await addNote(source.noteRoute, { text: '图片已经丢了', image: imageId })
    await rm(join(source.home, 'note-wall', 'images', imageId), { force: true })

    const exported = await exportBackup(source.backupRoute)
    assert.equal(exported.status, 200)
    const manifest = jsonEntry(exported.raw, 'manifest.json')
    assert.deepEqual(manifest.missingImages, [imageId])
    assert.equal(manifest.imageCount, 0)
    const document = jsonEntry(exported.raw, 'notes.json')
    assert.equal(document.notes.length, 2)
    assert.equal(entryMap(exported.raw).has(`images/${imageId}`), false)

    const imported = await importBackup(target.backupRoute, exported.raw, '?mode=replace')
    assert.equal(imported.status, 200, imported.body)
    assert.equal(imported.json.value.importedNotes, 1)
    assert.equal(imported.json.value.skippedNotes, 1)
    assert.equal(imported.json.value.imageCount, 0)
    const state = await noteState(target.noteRoute)
    assert.deepEqual(state.notes.map(note => note.text), ['没有图也能导出'])
  } finally {
    await source.cleanup()
    await target.cleanup()
  }
})

test('invalid notes are skipped and counted; unknown folder references are cleared', async () => {
  const { backupRoute, noteRoute, cleanup } = await setup()
  try {
    const folder = folderRecord()
    const sharedId = randomUUID()
    const document = makeDocument([
      noteRecord({ id: sharedId, text: '有效便签', folderId: folder.id }),
      noteRecord({ text: '   ' }),
      noteRecord({ text: 'x'.repeat(501) }),
      noteRecord({ text: '时间坏了', createdAt: 'not-a-date' }),
      noteRecord({ id: sharedId, text: '重复 id' }),
      noteRecord({ text: '未知分组', folderId: 'missing-folder' }),
    ], [folder])

    const result = await importBackup(backupRoute, archiveBuffer({ document }), '?mode=merge')
    assert.equal(result.status, 200, result.body)
    assert.equal(result.json.value.importedNotes, 2)
    assert.equal(result.json.value.skippedNotes, 4)
    assert.equal(result.json.value.importedFolders, 1)

    const state = await noteState(noteRoute)
    assert.equal(state.notes.length, 2)
    const targetFolder = state.folders.find(folder => folder.name === '工作')
    assert.ok(targetFolder)
    const valid = state.notes.find(note => note.text === '有效便签')
    assert.equal(valid.folderId, targetFolder.id)
    assert.equal(state.notes.find(note => note.text === '未知分组').folderId, '')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Validation, limits and settings
// ---------------------------------------------------------------------------

test('route rejects unsafe archives with coded 400 responses and changes nothing', async () => {
  const { backupRoute, noteRoute, cleanup } = await setup()
  try {
    await addNote(noteRoute, { text: '导入前' })
    const emptyDocument = makeDocument()

    const cases = []
    cases.push(['unknown-file', archiveBuffer({ extraEntries: [{ name: 'evil.txt', data: 'x' }] }), 'backup-invalid-archive'])
    cases.push(['traversal', archiveBuffer({ extraEntries: [{ name: '../evil.txt', data: 'x' }] }), 'backup-unsafe-archive'])
    cases.push(['duplicate-entry', archiveBuffer({ extraEntries: [{ name: 'notes.json', data: '{}' }] }), 'backup-invalid-zip'])
    cases.push(['bad-json', archiveBuffer({ notesData: Buffer.from('{ nope') }), 'backup-invalid-archive'])
    cases.push(['missing-manifest', archiveBuffer({ includeManifest: false }), 'backup-invalid-archive'])
    cases.push([
      'bad-image',
      archiveBuffer({ document: emptyDocument, images: [[`${randomUUID()}.png`, Buffer.from('not an image, really')]] }),
      'backup-invalid-archive',
    ])

    for (const [label, archive, code] of cases) {
      const result = await importBackup(backupRoute, archive, '?mode=replace')
      assert.equal(result.status, 400, label)
      assert.equal(result.json.error.code, code, label)
    }

    const state = await noteState(noteRoute)
    assert.equal(state.notes.length, 1)
    assert.equal(state.notes[0].text, '导入前')
  } finally {
    await cleanup()
  }
})

test('import enforces the archive, image and entry limits', async () => {
  const { backupRoute, cleanup } = await setup()
  try {
    const oversizedImage = Buffer.concat([PNG_BYTES, Buffer.alloc(BACKUP_LIMITS.maxImageBytes, 0)])
    const oversized = archiveBuffer({
      images: [[`${randomUUID()}.png`, oversizedImage]],
    })
    const tooLargeImage = await importBackup(backupRoute, oversized, '?mode=replace')
    assert.equal(tooLargeImage.status, 413)
    assert.equal(tooLargeImage.json.error.code, 'backup-too-large')

    const manyImages = []
    for (let index = 0; index < BACKUP_LIMITS.maxImageCount + 1; index += 1) {
      manyImages.push([`${randomUUID()}.png`, PNG_BYTES])
    }
    const tooMany = await importBackup(
      backupRoute,
      archiveBuffer({ images: manyImages }),
      '?mode=replace',
    )
    assert.equal(tooMany.status, 413)
    assert.equal(tooMany.json.error.code, 'backup-too-large')

    const bodyTooLarge = await importBackup(backupRoute, Buffer.alloc(BACKUP_LIMITS.maxArchiveBytes + 1), '?mode=replace')
    assert.equal(bodyTooLarge.status, 413)
    assert.equal(bodyTooLarge.json.error.code, 'backup-too-large')

    // Declared uncompressed totals are bounded before any entry is inflated.
    const bomb = buildZip([{ name: 'notes.json', data: Buffer.alloc(BACKUP_LIMITS.maxTotalUncompressedBytes + 1, 0x20) }])
    assert.throws(
      () => readZip(bomb),
      error => error.code === 'backup-too-large',
    )
  } finally {
    await cleanup()
  }
})

test('settings import validates the schema and follows applySettings semantics', async () => {
  const { home, backupRoute, noteRoute, cleanup } = await setup()
  try {
    await addNote(noteRoute, { text: '目标便签' })
    const document = makeDocument()
    const invalidSettingsArchive = archiveBuffer({ document, settings: { version: 1, motion: 'yes' } })

    const rejected = await importBackup(backupRoute, invalidSettingsArchive, '?mode=replace')
    assert.equal(rejected.status, 400)
    assert.equal(rejected.json.error.code, 'backup-settings-invalid')
    await assert.rejects(access(join(home, 'note-wall', 'backups')), 'invalid settings must abort before the safety backup')

    const unsupportedVersion = archiveBuffer({ document, settings: { version: 99, motion: false } })
    const versionRejected = await importBackup(backupRoute, unsupportedVersion, '?mode=replace')
    assert.equal(versionRejected.status, 400)
    assert.equal(versionRejected.json.error.code, 'backup-settings-invalid')

    // applySettings=0 ignores even an invalid settings.json.
    const ignored = await importBackup(backupRoute, invalidSettingsArchive, '?mode=replace&applySettings=0')
    assert.equal(ignored.status, 200, ignored.body)
    assert.equal(ignored.json.value.settingsIncluded, true)
    assert.equal(ignored.json.value.settingsApplied, false)
    const defaults = await call(noteRoute, { payload: { action: 'settings' } })
    assert.equal(defaults.json.value.settings.motion, true)

    // Merge applies settings only when explicitly asked to.
    await call(noteRoute, { payload: { action: 'settingsUpdate', motion: true } })
    const mergeArchive = archiveBuffer({ document, settings: { version: 1, motion: false, imageDisplay: 'icon' } })
    const merged = await importBackup(backupRoute, mergeArchive, '?mode=merge&applySettings=1')
    assert.equal(merged.status, 200, merged.body)
    assert.equal(merged.json.value.settingsApplied, true)
    const updated = await call(noteRoute, { payload: { action: 'settings' } })
    assert.equal(updated.json.value.settings.motion, false)
    assert.equal(updated.json.value.settings.imageDisplay, 'icon')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// HTTP admission
// ---------------------------------------------------------------------------

test('backup routes apply admission, method, media type and mode rules', async () => {
  const { backupRoute, noteRoute, cleanup } = await setup()
  try {
    await addNote(noteRoute, { text: '存在的便签' })
    const exported = await exportBackup(backupRoute)

    const noHeader = await call(backupRoute, {
      method: 'GET',
      headers: baseHeaders({ 'x-dsh-note-wall': '' }),
      body: '',
      url: BACKUP_PATH,
    })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.json.error.code, 'forbidden')

    const wrongOrigin = await call(backupRoute, {
      method: 'GET',
      headers: baseHeaders({ origin: 'http://evil.example' }),
      body: '',
      url: BACKUP_PATH,
    })
    assert.equal(wrongOrigin.status, 403)

    const postNoHeader = await call(backupRoute, {
      method: 'POST',
      headers: baseHeaders({ 'x-dsh-note-wall': '', 'content-type': 'application/zip' }),
      body: exported.raw,
      url: `${BACKUP_PATH}?mode=replace`,
    })
    assert.equal(postNoHeader.status, 403)
    assert.equal(postNoHeader.json.error.code, 'forbidden')

    const wrongMethod = await call(backupRoute, {
      method: 'PUT',
      headers: baseHeaders(),
      body: '',
      url: BACKUP_PATH,
    })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'GET, POST')

    const wrongType = await call(backupRoute, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: exported.raw,
      url: `${BACKUP_PATH}?mode=replace`,
    })
    assert.equal(wrongType.status, 415)
    assert.equal(wrongType.json.error.code, 'unsupported-media-type')

    for (const query of ['', '?mode=nope']) {
      const result = await importBackup(backupRoute, exported.raw, query)
      assert.equal(result.status, 400, query)
      assert.equal(result.json.error.code, 'backup-mode-invalid', query)
    }
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// Store rollback and real extraction
// ---------------------------------------------------------------------------

test('replaceAll and mergeSnapshot roll back in memory when the atomic write fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-note-wall-backup-store-'))
  try {
    const store = new NoteStore({ dir, imagesDir: join(dir, 'images'), logger: quietLogger, now: () => Date.parse(ISO) })
    await store.load()
    const original = await store.add({ text: '保留我' })
    const beforeNotes = store.list()
    const beforeFolders = store.listFolders()

    store.writeSnapshot = async () => {
      throw new Error('disk full')
    }
    await assert.rejects(store.replaceAll({ notes: [], folders: [] }), /disk full/)
    assert.deepEqual(store.list(), beforeNotes)
    assert.deepEqual(store.listFolders(), beforeFolders)

    await assert.rejects(
      store.mergeSnapshot({ notes: [{ ...original, id: randomUUID(), text: '新便签' }], folders: [] }),
      /disk full/,
    )
    assert.deepEqual(store.list(), beforeNotes)
    assert.deepEqual(store.listFolders(), beforeFolders)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Windows Expand-Archive and tar can extract an exported archive', async (t) => {
  const { home, backupRoute, noteRoute, uploadRoute, cleanup } = await setup()
  try {
    const imageId = await uploadImage(uploadRoute)
    await addNote(noteRoute, { text: '给资源管理器解压用', image: imageId })
    const exported = await exportBackup(backupRoute)
    assert.equal(exported.status, 200)

    const zipPath = join(home, 'export.zip')
    await writeFile(zipPath, exported.raw)
    const notesBytes = entryMap(exported.raw).get('notes.json')

    let extracted = false
    if (process.platform === 'win32') {
      const expandDir = join(home, 'expanded')
      await mkdir(expandDir, { recursive: true })
      let ran = false
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${expandDir}' -Force`,
          ],
          { stdio: 'ignore', timeout: 60_000 },
        )
        ran = true
      } catch {
        ran = false
      }
      if (ran) {
        assert.equal((await readFile(join(expandDir, 'notes.json'))).equals(notesBytes), true)
        assert.equal((await readFile(join(expandDir, 'images', imageId))).equals(PNG_BYTES), true)
        extracted = true
      }
    }

    if (!extracted) {
      const tarDir = join(home, 'tarred')
      await mkdir(tarDir, { recursive: true })
      let ran = false
      try {
        execFileSync('tar', ['-xf', zipPath, '-C', tarDir], { stdio: 'ignore', timeout: 60_000 })
        ran = true
      } catch {
        ran = false
      }
      if (ran) {
        assert.equal((await readFile(join(tarDir, 'notes.json'))).equals(notesBytes), true)
        assert.equal((await readFile(join(tarDir, 'images', imageId))).equals(PNG_BYTES), true)
        extracted = true
      }
    }

    if (!extracted) {
      t.skip('neither powershell.exe Expand-Archive nor tar could extract the archive here')
    }
  } finally {
    await cleanup()
  }
})
