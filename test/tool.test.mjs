import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

const quietLogger = { warn() {}, error() {}, info() {} }

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-note-wall-tool-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = []
  const disposers = []
  const ctx = {
    logger: quietLogger,
    get() { return undefined },
    webServer: {
      register() { return () => {} },
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
  return {
    home,
    tool: tools[0],
    async cleanup() {
      for (const dispose of disposers) dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('registers note_wall_add with the v1.2.0 parameter surface', async () => {
  const { tool, cleanup } = await setup()
  try {
    assert.equal(tool.name, 'note_wall_add')
    assert.deepEqual(Array.from(tool.parameters.required), ['text'])
    for (const key of ['text', 'category', 'color', 'link']) {
      assert.equal(tool.parameters.properties[key].type, 'string')
    }
    assert.equal(tool.parameters.properties.image, undefined, 'v1.2.0 tool must not accept images')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(tool.output.render(undefined, { note: { text: '一条便签' } })[0].type, 'text')
  } finally {
    await cleanup()
  }
})

test('adds a note through the agent tool and persists it', async () => {
  const { home, tool, cleanup } = await setup()
  try {
    const value = await tool.execute({
      text: '  工具写一条  ',
      category: ' 代理 ',
      color: 'mint',
      link: 'https://example.com/x',
    })
    assert.equal(value.note.text, '工具写一条')
    assert.equal(value.note.tag, '代理')
    assert.equal(value.note.tone, 'mint')
    assert.equal(value.note.link, 'https://example.com/x')
    assert.equal(value.note.image, '')

    const stored = JSON.parse(await readFile(join(home, 'note-wall', 'store.json'), 'utf8'))
    assert.equal(stored.notes.length, 1)
    assert.equal(stored.notes[0].text, '工具写一条')
    assert.equal(stored.notes[0].image, '')
  } finally {
    await cleanup()
  }
})

test('defaults color to amber and rejects invalid arguments', async () => {
  const { tool, cleanup } = await setup()
  try {
    const value = await tool.execute({ text: '默认色' })
    assert.equal(value.note.tone, 'amber')

    await assert.rejects(tool.execute({ text: '   ' }), error => error.code === 'note-text-required')
    await assert.rejects(tool.execute({ text: 'x', color: 'magenta' }), error => error.code === 'note-tone-invalid')
    await assert.rejects(tool.execute({ text: 'x', link: 'javascript:alert(1)' }), error => error.code === 'note-link-invalid')
    await assert.rejects(tool.execute({ text: 'x', category: 'x'.repeat(25) }), error => error.code === 'note-tag-too-long')
  } finally {
    await cleanup()
  }
})
