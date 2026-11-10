// dsh-note-wall — settings store unit tests.
//
// Explicit file list: node --test test/settings.test.mjs

import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, SettingsStore } from '../lib/settings.js'

const quietLogger = { warn() {}, error() {} }
const BASE_MS = Date.parse('2026-01-02T03:04:05.000Z')
const tempDirs = []

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function freshDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-note-wall-settings-'))
  tempDirs.push(dir)
  return dir
}

async function openSettings(options = {}) {
  const dir = options.dir ?? await freshDir()
  const store = new SettingsStore({
    dir,
    logger: quietLogger,
    now: options.now ?? (() => BASE_MS),
  })
  await store.load()
  return { dir, store }
}

function expectedDefaults() {
  return { version: SETTINGS_VERSION, ...DEFAULT_SETTINGS }
}

test('a missing settings file loads the defaults without creating it', async () => {
  const { dir, store } = await openSettings()
  assert.deepEqual(store.get(), expectedDefaults())
  assert.equal(store.get().agentWrite.enabled, false, 'agent writes must default to disabled')
  assert.equal(store.get().imageDisplay, 'thumbnail', 'card images default to the compact thumbnail')
  assert.deepEqual(await readdir(dir), [])
})

test('get returns a detached copy', async () => {
  const { store } = await openSettings()
  const first = store.get()
  first.agentWrite.enabled = true
  first.reminders.volume = 1
  first.motion = false
  const second = store.get()
  assert.equal(second.agentWrite.enabled, false)
  assert.equal(second.reminders.volume, 0.7)
  assert.equal(second.motion, true)
})

test('partial updates merge, persist and survive a reload', async () => {
  const { dir, store } = await openSettings()
  const updated = await store.update({
    agentWrite: { enabled: true },
    categoryHistory: { limit: 12 },
    reminders: { sound: true, volume: 0.25 },
    imageDisplay: 'thumbnail',
    motion: false,
  })
  assert.equal(updated.agentWrite.enabled, true)
  assert.equal(updated.categoryHistory.enabled, false, 'unspecified sibling fields keep their values')
  assert.equal(updated.categoryHistory.limit, 12)
  assert.equal(updated.reminders.sound, true)
  assert.equal(updated.reminders.volume, 0.25)
  assert.equal(updated.reminders.enabled, false)
  assert.equal(updated.imageDisplay, 'thumbnail')
  assert.equal(updated.motion, false)

  const stored = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored.version, SETTINGS_VERSION)
  assert.equal(stored.agentWrite.enabled, true)
  assert.equal(stored.reminders.volume, 0.25)

  const reopened = new SettingsStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.get(), updated)

  const unchanged = await store.update({})
  assert.deepEqual(unchanged, updated, 'an empty patch is a no-op')
  await assert.rejects(store.update(null), error => error.code === 'settings-invalid')
  await assert.rejects(store.update([]), error => error.code === 'settings-invalid')
})

test('unknown keys and a version field in a patch are ignored', async () => {
  const { store } = await openSettings()
  const value = await store.update({ version: 7, futureField: true, motion: false })
  assert.equal(value.version, SETTINGS_VERSION)
  assert.equal(value.motion, false)
  assert.equal(Object.prototype.hasOwnProperty.call(value, 'futureField'), false)
})

test('invalid setting values are rejected without changing anything', async () => {
  const { dir, store } = await openSettings()
  const before = store.get()
  const cases = [
    [{ agentWrite: { enabled: 'yes' } }, 'settings-value-invalid'],
    [{ agentWrite: 'on' }, 'settings-value-invalid'],
    [{ categoryHistory: { limit: 0 } }, 'settings-value-invalid'],
    [{ categoryHistory: { limit: 51 } }, 'settings-value-invalid'],
    [{ categoryHistory: { limit: 2.5 } }, 'settings-value-invalid'],
    [{ folders: { enabled: null } }, 'settings-value-invalid'],
    [{ imageDisplay: 'huge' }, 'settings-value-invalid'],
    [{ reminders: { volume: -0.1 } }, 'settings-value-invalid'],
    [{ reminders: { volume: 1.1 } }, 'settings-value-invalid'],
    [{ reminders: { enabled: 1 } }, 'settings-value-invalid'],
    [{ globalAlarm: { mode: 'loud' } }, 'settings-value-invalid'],
    [{ globalAlarm: { sound: 'yes' } }, 'settings-value-invalid'],
    [{ motion: 'off' }, 'settings-value-invalid'],
  ]
  for (const [patch, code] of cases) {
    await assert.rejects(store.update(patch), error => error.code === code, JSON.stringify(patch))
  }
  assert.deepEqual(store.get(), before)
  await assert.rejects(access(join(dir, 'settings.json')), 'a rejected update must not create a settings file')
})

test('allowed enums and numeric limits are enforced at their boundaries', async () => {
  const { store } = await openSettings()
  for (const mode of ['overlay', 'banner', 'silent']) {
    const value = await store.update({ globalAlarm: { mode } })
    assert.equal(value.globalAlarm.mode, mode)
  }
  for (const imageDisplay of ['large', 'thumbnail', 'icon']) {
    const value = await store.update({ imageDisplay })
    assert.equal(value.imageDisplay, imageDisplay)
  }
  assert.equal((await store.update({ categoryHistory: { limit: 1 } })).categoryHistory.limit, 1)
  assert.equal((await store.update({ categoryHistory: { limit: 50 } })).categoryHistory.limit, 50)
  assert.equal((await store.update({ reminders: { volume: 0 } })).reminders.volume, 0)
  assert.equal((await store.update({ reminders: { volume: 1 } })).reminders.volume, 1)
  assert.equal((await store.update({ categoryHistory: { enabled: true } })).categoryHistory.enabled, true)
  assert.equal((await store.update({ folders: { enabled: true } })).folders.enabled, true)
})

test('load keeps valid fields and defaults malformed ones', async () => {
  const dir = await freshDir()
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      version: 1,
      agentWrite: { enabled: true },
      categoryHistory: { enabled: true, limit: 0 },
      folders: 'yes',
      imageDisplay: 'huge',
      reminders: { enabled: true, sound: 'yes', volume: 1.5, notifications: true, overdue: false },
      globalAlarm: { enabled: true, mode: 'nope', sound: true },
      motion: 'off',
      futureField: 1,
    }),
    'utf8',
  )
  const { store } = await openSettings({ dir })
  const value = store.get()
  assert.equal(value.agentWrite.enabled, true)
  assert.equal(value.categoryHistory.enabled, true)
  assert.equal(value.categoryHistory.limit, 8)
  assert.equal(value.folders.enabled, false)
  assert.equal(value.imageDisplay, 'thumbnail')
  assert.equal(value.reminders.enabled, true)
  assert.equal(value.reminders.sound, false)
  assert.equal(value.reminders.volume, 0.7)
  assert.equal(value.reminders.notifications, true)
  assert.equal(value.reminders.overdue, false)
  assert.equal(value.globalAlarm.enabled, true)
  assert.equal(value.globalAlarm.mode, 'overlay')
  assert.equal(value.globalAlarm.sound, true)
  assert.equal(value.motion, true)
  assert.equal(Object.prototype.hasOwnProperty.call(value, 'futureField'), false)
})

test('a corrupt settings file falls back to defaults and is preserved', async () => {
  const dir = await freshDir()
  const original = '{ this is not json'
  const noteRaw = JSON.stringify({ version: 2, folders: [], notes: [] })
  await writeFile(join(dir, 'settings.json'), original, 'utf8')
  await writeFile(join(dir, 'store.json'), noteRaw, 'utf8')
  const { store } = await openSettings({ dir })
  assert.deepEqual(store.get(), expectedDefaults())

  const names = await readdir(dir)
  const quarantined = names.find(name => name.startsWith('settings.corrupt-'))
  assert.ok(quarantined, names.join(','))
  assert.ok(!names.includes('settings.json'), 'corrupt settings should be moved away, not rewritten')
  assert.equal(await readFile(join(dir, quarantined), 'utf8'), original)
  assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), noteRaw, 'note data must be untouched')
})

test('an unsupported settings version falls back to defaults without touching the file', async () => {
  const dir = await freshDir()
  const original = JSON.stringify({ version: 99, agentWrite: { enabled: true } })
  await writeFile(join(dir, 'settings.json'), original, 'utf8')
  const { store } = await openSettings({ dir })
  assert.equal(store.get().agentWrite.enabled, false)
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), original)
})

test('reset restores defaults and a failed write rolls back', async () => {
  const { dir, store } = await openSettings()
  await store.update({ agentWrite: { enabled: true }, motion: false })
  const reset = await store.reset()
  assert.deepEqual(reset, expectedDefaults())

  const reopened = new SettingsStore({ dir, logger: quietLogger })
  await reopened.load()
  assert.deepEqual(reopened.get(), reset)

  store.writeSnapshot = async () => {
    throw new Error('disk full')
  }
  const before = store.get()
  await assert.rejects(store.update({ motion: false }), /disk full/)
  assert.deepEqual(store.get(), before)
  await assert.rejects(store.reset(), /disk full/)
  assert.deepEqual(store.get(), before)
})
