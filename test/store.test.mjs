// dsh-note-wall — store unit tests.
//
// Explicit file list: node --test test/store.test.mjs

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { LIMITS, NoteError, NoteStore, TONES } from '../lib/store.js'

const quietLogger = { warn() {}, error() {} }
const BASE_MS = Date.parse('2026-01-02T03:04:05.000Z')
const tempDirs = []

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function freshDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-note-wall-'))
  tempDirs.push(dir)
  return dir
}

async function openStore(options = {}) {
  const dir = options.dir ?? await freshDir()
  const store = new NoteStore({
    dir,
    logger: quietLogger,
    now: options.now ?? (() => BASE_MS),
  })
  await store.load()
  return { dir, store }
}

function assertNoteError(code) {
  return (error) => {
    assert.ok(error instanceof NoteError, `expected NoteError for ${code}`)
    assert.equal(error.code, code)
    return true
  }
}

function seedNote(index, overrides = {}) {
  const stamp = new Date(BASE_MS - index * 1000).toISOString()
  return {
    id: `seed-${String(index).padStart(4, '0')}`,
    text: `seed note ${index}`,
    tag: '',
    tone: 'amber',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

test('a missing store file loads as an empty wall', async () => {
  const { dir, store } = await openStore()
  assert.deepEqual(store.list(), [])
  assert.deepEqual(await readdir(dir), [])
})

test('add trims text and tag, defaults to amber and persists', async () => {
  const { dir, store } = await openStore()
  const note = await store.add({ text: '  给每个想法，一个落脚的地方。  ', tag: ' 产品灵感 ' })
  assert.equal(note.text, '给每个想法，一个落脚的地方。')
  assert.equal(note.tag, '产品灵感')
  assert.equal(note.tone, 'amber')
  assert.equal(note.createdAt, note.updatedAt)
  assert.match(note.id, /^[0-9a-f-]{36}$/)

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list(), [note])

  const stored = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.notes.length, 1)
  assert.equal(stored.notes[0].id, note.id)
})

test('newest notes come first and ordering survives reload', async () => {
  let clock = BASE_MS
  const { dir, store } = await openStore({ now: () => clock })
  const first = await store.add({ text: 'first' })
  clock += 60_000
  const second = await store.add({ text: 'second' })
  assert.deepEqual(store.list().map(note => note.id), [second.id, first.id])

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list().map(note => note.id), [second.id, first.id])
})

test('add rejects empty, over-long and invalid input with coded errors', async () => {
  const { store } = await openStore()
  await assert.rejects(store.add({ text: '   ' }), assertNoteError('note-text-required'))
  await assert.rejects(store.add({ text: 'x'.repeat(LIMITS.maxNoteChars + 1) }), assertNoteError('note-text-too-long'))
  await assert.rejects(store.add({ text: 'ok', tag: 'x'.repeat(LIMITS.maxTagChars + 1) }), assertNoteError('note-tag-too-long'))
  await assert.rejects(store.add({ text: 'ok', tone: 'magenta' }), assertNoteError('note-tone-invalid'))
  await assert.rejects(store.add({}), assertNoteError('note-text-required'))
})

test('add accepts every offered tone and a custom hex color', async () => {
  const { store } = await openStore()
  for (const tone of TONES) {
    const note = await store.add({ text: `tone ${tone}`, tone })
    assert.equal(note.tone, tone)
  }
  const custom = await store.add({ text: 'custom', tone: '#F2C94C' })
  assert.equal(custom.tone, '#f2c94c')
  assert.equal(store.list().length, TONES.length + 1)
  await assert.rejects(store.add({ text: 'bad', tone: '#fff' }), assertNoteError('note-tone-invalid'))
  await assert.rejects(store.add({ text: 'bad', tone: '#12345g' }), assertNoteError('note-tone-invalid'))
})

test('update changes fields, stamps updatedAt and rejects unknown notes', async () => {
  let clock = BASE_MS
  const { dir, store } = await openStore({ now: () => clock })
  const note = await store.add({ text: 'old', tag: 'a' })
  clock += 90_000
  const updated = await store.update({ id: note.id, text: '  new  ', tag: '', tone: 'mint' })
  assert.equal(updated.text, 'new')
  assert.equal(updated.tag, '')
  assert.equal(updated.tone, 'mint')
  assert.equal(updated.createdAt, note.createdAt)
  assert.notEqual(updated.updatedAt, note.updatedAt)

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list(), [updated])

  await assert.rejects(store.update({ id: 'missing', text: 'x' }), assertNoteError('note-not-found'))
  await assert.rejects(store.update({ id: note.id }), assertNoteError('note-nothing-to-update'))
  await assert.rejects(store.update({ id: note.id, text: '   ' }), assertNoteError('note-text-required'))
  await assert.rejects(store.update({ id: note.id, tone: 'nope' }), assertNoteError('note-tone-invalid'))
})

test('remove deletes once and is idempotent afterwards', async () => {
  const { dir, store } = await openStore()
  const note = await store.add({ text: 'removeme' })
  assert.equal(await store.remove({ id: note.id }), true)
  assert.equal(await store.remove({ id: note.id }), false)
  assert.deepEqual(store.list(), [])

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list(), [])
  await assert.rejects(store.remove({}), assertNoteError('note-id-required'))
})

test('the wall refuses notes beyond maxNotes', async () => {
  const dir = await freshDir()
  const seeded = Array.from({ length: LIMITS.maxNotes }, (_, index) => seedNote(index))
  await writeFile(join(dir, 'store.json'), JSON.stringify({ version: 1, notes: seeded }), 'utf8')
  const { store } = await openStore({ dir })
  assert.equal(store.list().length, LIMITS.maxNotes)
  await assert.rejects(store.add({ text: 'one too many' }), assertNoteError('note-limit-reached'))
})

test('loading ignores duplicate ids and malformed records', async () => {
  const dir = await freshDir()
  const valid = seedNote(0, { id: 'keep-a', text: 'keep a' })
  const duplicate = seedNote(1, { id: 'keep-a', text: 'duplicate id' })
  const emptyText = seedNote(2, { id: 'bad-empty', text: '   ' })
  const badDate = seedNote(3, { id: 'bad-date', createdAt: 'not-a-date' })
  const badTone = seedNote(4, { id: 'tone-fallback', tone: 'magenta' })
  const overLong = seedNote(5, { id: 'bad-long', text: 'x'.repeat(LIMITS.maxNoteChars + 1) })
  await writeFile(
    join(dir, 'store.json'),
    JSON.stringify({ version: 1, notes: [valid, duplicate, emptyText, badDate, badTone, overLong] }),
    'utf8',
  )
  const { store } = await openStore({ dir })
  const notes = store.list()
  assert.deepEqual(notes.map(note => note.id), ['keep-a', 'tone-fallback'])
  assert.equal(notes.find(note => note.id === 'tone-fallback').tone, 'amber')
  assert.equal(notes.find(note => note.id === 'keep-a').text, 'keep a')
})

test('a corrupt store file is quarantined with its bytes intact', async () => {
  const dir = await freshDir()
  const original = '{ this is not json'
  await writeFile(join(dir, 'store.json'), original, 'utf8')
  const { store } = await openStore({ dir })
  assert.deepEqual(store.list(), [])
  const names = await readdir(dir)
  const quarantined = names.find(name => name.startsWith('store.corrupt-'))
  assert.ok(quarantined, names.join(','))
  assert.ok(!names.includes('store.json'), 'corrupt file should have been moved away, not rewritten')
  assert.equal(await readFile(join(dir, quarantined), 'utf8'), original)
})

test('a parseable but unrecognized document is quarantined, not treated as empty', async () => {
  const dir = await freshDir()
  const original = JSON.stringify({ version: 1, notes: { bad: true } })
  await writeFile(join(dir, 'store.json'), original, 'utf8')
  const { store } = await openStore({ dir })
  assert.deepEqual(store.list(), [])
  const quarantined = (await readdir(dir)).find(name => name.startsWith('store.corrupt-'))
  assert.ok(quarantined)
  assert.equal(await readFile(join(dir, quarantined), 'utf8'), original)
})

test('refuses to load when an unrecognized file cannot be preserved', async () => {
  const dir = await freshDir()
  // A directory in the quarantine target's place makes the rename fail.
  const target = 'store.corrupt-' + new Date(BASE_MS).toISOString().replace(/[:.]/g, '-') + '.json'
  await mkdir(join(dir, target))
  const original = 'not json at all'
  await writeFile(join(dir, 'store.json'), original, 'utf8')
  const store = new NoteStore({ dir, logger: quietLogger, now: () => BASE_MS })
  await assert.rejects(store.load(), assertNoteError('store-corrupt-unreadable'))
  assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), original)
})

test('a failed write rolls the in-memory wall back', async () => {
  const { store } = await openStore()
  const note = await store.add({ text: 'keep me', tag: 'a' })
  const baseline = store.list()

  store.writeSnapshot = async () => {
    throw new Error('disk full')
  }

  await assert.rejects(store.add({ text: 'never saved' }), /disk full/)
  assert.deepEqual(store.list(), baseline)

  await assert.rejects(store.update({ id: note.id, text: 'changed' }), /disk full/)
  assert.deepEqual(store.list(), baseline)

  await assert.rejects(store.remove({ id: note.id }), /disk full/)
  assert.deepEqual(store.list(), baseline)
})

test('persisted file stays valid JSON after several mutations', async () => {
  const { dir, store } = await openStore()
  const a = await store.add({ text: 'a', tag: 'one' })
  await store.add({ text: 'b', tone: 'sky' })
  await store.update({ id: a.id, text: 'a2' })
  const stored = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'))
  assert.equal(stored.notes.length, 2)
  assert.ok(stored.notes.every(note => typeof note.id === 'string' && note.text.length > 0))

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list(), store.list())
})

// ---------------------------------------------------------------------------
// Links and images
// ---------------------------------------------------------------------------

const IMAGE_A = '11111111-1111-4111-8111-111111111111.png'
const IMAGE_B = '22222222-2222-4222-8222-222222222222.jpg'

test('add stores a normalized link and an image id', async () => {
  const { dir, store } = await openStore()
  const imagesDir = join(dir, 'images')
  await mkdir(imagesDir, { recursive: true })
  await writeFile(join(imagesDir, IMAGE_A), Buffer.from([1]))
  const note = await store.add({ text: '参考图', link: 'https://example.com/a?b=1', image: IMAGE_A })
  assert.equal(note.link, 'https://example.com/a?b=1')
  assert.equal(note.image, IMAGE_A)

  const reopened = new NoteStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.list(), [note])
})

test('link and image input is validated', async () => {
  const { store } = await openStore()
  await assert.rejects(store.add({ text: 'x', link: 'javascript:alert(1)' }), assertNoteError('note-link-invalid'))
  await assert.rejects(store.add({ text: 'x', link: 'ftp://example.com' }), assertNoteError('note-link-invalid'))
  await assert.rejects(
    store.add({ text: 'x', link: 'https://example.com/' + 'a'.repeat(LIMITS.maxLinkChars) }),
    assertNoteError('note-link-too-long'),
  )
  await assert.rejects(store.add({ text: 'x', image: '../outside.png' }), assertNoteError('note-image-invalid'))
  await assert.rejects(store.add({ text: 'x', image: 'not-a-uuid.png' }), assertNoteError('note-image-invalid'))
})

test('update sets and clears link and image, deleting a replaced image file', async () => {
  const { dir, store } = await openStore()
  const imagesDir = join(dir, 'images')
  await mkdir(imagesDir, { recursive: true })
  await writeFile(join(imagesDir, IMAGE_A), Buffer.from([1]))
  await writeFile(join(imagesDir, IMAGE_B), Buffer.from([2]))

  const note = await store.add({ text: 'a', image: IMAGE_A })
  const updated = await store.update({ id: note.id, link: 'https://example.com/x', image: IMAGE_B })
  assert.equal(updated.link, 'https://example.com/x')
  assert.equal(updated.image, IMAGE_B)
  await assert.rejects(access(join(imagesDir, IMAGE_A)), 'replaced image should be deleted')
  await access(join(imagesDir, IMAGE_B))

  const cleared = await store.update({ id: note.id, link: '', image: '' })
  assert.equal(cleared.link, '')
  assert.equal(cleared.image, '')
  await assert.rejects(access(join(imagesDir, IMAGE_B)), 'cleared image should be deleted')
})

test('removing a note deletes its image; discard respects references', async () => {
  const { dir, store } = await openStore()
  const imagesDir = join(dir, 'images')
  await mkdir(imagesDir, { recursive: true })
  await writeFile(join(imagesDir, IMAGE_A), Buffer.from([1]))
  await writeFile(join(imagesDir, IMAGE_B), Buffer.from([2]))

  const note = await store.add({ text: 'a', image: IMAGE_A })
  assert.equal(await store.discardImage({ id: IMAGE_A }), false, 'referenced image must be kept')
  assert.equal(await store.discardImage({ id: IMAGE_B }), true)
  await assert.rejects(access(join(imagesDir, IMAGE_B)))

  assert.equal(await store.remove({ id: note.id }), true)
  await assert.rejects(access(join(imagesDir, IMAGE_A)), 'removed note image should be deleted')
  await assert.rejects(store.discardImage({ id: 'x' }), assertNoteError('note-image-invalid'))
})

test('stored notes keep their text when link or image is malformed', async () => {
  const dir = await freshDir()
  const bad = seedNote(0, { id: 'keep', link: 'javascript:alert(1)', image: '../x.png' })
  await writeFile(join(dir, 'store.json'), JSON.stringify({ version: 1, notes: [bad] }), 'utf8')
  const { store } = await openStore({ dir })
  const notes = store.list()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].link, '')
  assert.equal(notes[0].image, '')
  assert.equal(notes[0].text, 'seed note 0')
})

test('notes cannot reference an image file that is missing', async () => {
  const { dir, store } = await openStore()
  const imagesDir = join(dir, 'images')
  await mkdir(imagesDir, { recursive: true })

  await assert.rejects(store.add({ text: 'x', image: IMAGE_A }), assertNoteError('note-image-missing'))
  await writeFile(join(imagesDir, IMAGE_A), Buffer.from([1]))
  const note = await store.add({ text: 'x', image: IMAGE_A })

  await assert.rejects(store.update({ id: note.id, image: IMAGE_B }), assertNoteError('note-image-missing'))
  assert.equal(store.list()[0].image, IMAGE_A)
})

test('a stale editor update is rejected instead of overwriting a newer note', async () => {
  let clock = BASE_MS
  const { store } = await openStore({ now: () => clock })
  const note = await store.add({ text: 'a' })
  clock += 10_000
  const first = await store.update({ id: note.id, text: 'b', baseUpdatedAt: note.updatedAt })
  assert.equal(first.text, 'b')

  clock += 10_000
  await assert.rejects(
    store.update({ id: note.id, text: 'stale edit', baseUpdatedAt: note.updatedAt }),
    assertNoteError('note-conflict'),
  )
  assert.equal(store.list()[0].text, 'b')
})
