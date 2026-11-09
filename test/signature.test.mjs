import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

// The client bundle is a hand-written module-loader script, and
// @deepseek-ai/dsh-client-modules forbids synchronously requiring a sibling
// client chunk, so the click tracker cannot live in a shared lib module. This
// test loads the REAL client.js in a sandbox and uses its test-only hook to
// exercise the pure tracker and the once-only console signature.

const EXPECTED_CONSOLE = 'dsh-note-wall · dream-office · 把灵感，一张一张贴起来'

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const logged = []
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value },
      },
      __DSH_NOTE_WALL_TEST__: {},
    },
    console: {
      info(message) { logged.push(message) },
      warn() {},
      error() {},
    },
    URL,
    Date,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  assert.ok(definition, 'client bundle should register a module')
  assert.equal(definition.id, 'dsh-note-wall')

  const fakeReact = {
    createElement() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, function () {}] },
    useEffect() {},
    useSyncExternalStore() { return 'zh' },
  }
  const factory = definition.factory
  const module = factory(function (id) {
    if (id === 'react') return fakeReact
    throw new Error('unexpected require: ' + id)
  })
  return {
    module,
    logged,
    testHook: sandbox.window.__DSH_NOTE_WALL_TEST__,
  }
}

const client = await loadClient()
const tap = client.testHook.signatureTap

test('client module loads with its expected surface', () => {
  assert.deepEqual(Array.from(client.module.inject), ['slots', 'locale'])
  assert.equal(typeof client.module.apply, 'function')
  assert.equal(typeof tap, 'function')
  assert.equal(client.testHook.signatureWindowMs, 2000)
  assert.equal(client.testHook.signatureConsoleText, EXPECTED_CONSOLE)
})

test('one or two taps do not open the author note', () => {
  let state = tap([], 1000, 2000)
  assert.equal(state.opened, false)
  assert.deepEqual(Array.from(state.taps), [1000])

  state = tap(state.taps, 1200, 2000)
  assert.equal(state.opened, false)
  assert.deepEqual(Array.from(state.taps), [1000, 1200])
})

test('three taps inside two seconds open the note and reset the streak', () => {
  let state = tap([], 0, 2000)
  state = tap(state.taps, 700, 2000)
  assert.equal(state.opened, false)
  state = tap(state.taps, 1500, 2000)
  assert.equal(state.opened, true)
  assert.deepEqual(Array.from(state.taps), [])
})

test('the third tap outside the two-second window does not open', () => {
  let state = tap([], 0, 2000)
  state = tap(state.taps, 1000, 2000)
  state = tap(state.taps, 2501, 2000)
  assert.equal(state.opened, false)
  assert.deepEqual(Array.from(state.taps), [1000, 2501])
})

test('a long pause resets the streak', () => {
  let state = tap([], 0, 2000)
  state = tap(state.taps, 100, 2000)
  state = tap(state.taps, 3000, 2000)
  assert.equal(state.opened, false)
  assert.deepEqual(Array.from(state.taps), [3000])
})

test('taps exactly two seconds apart still count', () => {
  let state = tap([], 0, 2000)
  state = tap(state.taps, 1000, 2000)
  state = tap(state.taps, 2000, 2000)
  assert.equal(state.opened, true)
})

test('the console signature prints exactly once per module', () => {
  const fakeContext = {
    slots: {
      inject(_name, callback) { return callback() },
      register() { return function () {} },
    },
  }
  client.module.apply(fakeContext)
  client.module.apply(fakeContext)
  assert.deepEqual(Array.from(client.logged), [EXPECTED_CONSOLE])
})
