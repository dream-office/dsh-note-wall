// dsh-note-wall — Host half.
//
// Three same-origin routes backed by a JSON note store, its settings file and
// an image directory under `$DSH_HOME` (one wall per home, shared by profiles
// using it):
//
//   POST /plugins/dsh-note-wall/api        note actions (JSON)
//   POST /plugins/dsh-note-wall/image      raw image upload
//   GET  /plugins/dsh-note-wall/image/<id> the uploaded bytes (prefix route)
//
// The Web half (client.js) owns all presentation; this file owns request
// admission, validation hand-off and error mapping. Nothing here touches a
// Session log or writes outside the plugin's own data directory.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  IMAGE_ID_PATTERN,
  IMAGE_PATH_PREFIX,
  IMAGE_UPLOAD_PATH,
  mediaTypeForImage,
  sniffImage,
} from './lib/images.js'
import { LIMITS, NoteError, NoteStore } from './lib/store.js'
import { SettingsStore } from './lib/settings.js'

const ROUTE_PATH = '/plugins/dsh-note-wall/api'
const TRUST_HEADER = 'x-dsh-note-wall'
const MAX_BODY_BYTES = 256 * 1024
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return ctx[name]
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function notFound(res) {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end('Not found')
}

/** Shared request-body reader: bounded, abort-aware, and always settles once. */
function readBody(req, limit, tooLargeCode, tooLargeMessage) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const succeed = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        fail(new NoteError(tooLargeCode, tooLargeMessage))
        return
      }
      succeed(Buffer.concat(chunks))
    })
    req.on('aborted', () => fail(new NoteError('request-aborted', '请求已中断。')))
    req.on('close', () => fail(new NoteError('request-aborted', '请求已中断。')))
    req.on('error', (error) => fail(error))
  })
}

async function readJsonBody(req) {
  const data = await readBody(req, MAX_BODY_BYTES, 'body-too-large', '请求体过大。')
  try {
    const parsed = JSON.parse(data.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new NoteError('invalid-body', '请求体必须是 JSON 对象。')
    }
    return parsed
  } catch (error) {
    if (error instanceof NoteError) throw error
    throw new NoteError('invalid-json', '请求体不是合法 JSON。')
  }
}

function readBinaryBody(req) {
  return readBody(req, LIMITS.maxImageBytes, 'image-too-large', '图片不能超过 3 MB。')
}

function trustedRequest(ctx) {
  return (req) => {
    const connection = readService(ctx, 'connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        // Canonical peer admission: only an undefined rejection admits a request.
        return connection.requestRejection(req) === undefined
      } catch {
        return false
      }
    }
    const host = req.headers?.host
    const origin = req.headers?.origin
    if (typeof host !== 'string') return false
    return origin === `http://${host}` || origin === `https://${host}`
  }
}

export const inject = ['webServer', 'tools']

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const dataDir = join(home, 'note-wall')
  const imagesDir = join(dataDir, 'images')
  const store = new NoteStore({ dir: dataDir, imagesDir, logger })
  const settingsStore = new SettingsStore({ dir: dataDir, logger })
  let loadError
  const ready = store.load().catch((error) => {
    loadError = error
    logger.error?.('[note-wall] 便签存储无法加载', error)
  })
  let settingsError
  const settingsReady = settingsStore.load().catch((error) => {
    settingsError = error
    logger.error?.('[note-wall] 便签墙设置无法加载', error)
  })
  const trusted = trustedRequest(ctx)

  async function ensureStore() {
    await ready
    if (loadError !== undefined) {
      if (loadError instanceof NoteError) throw loadError
      throw new NoteError('store-unavailable', '便签存储无法加载，请查看 Harness 日志。')
    }
    return store
  }

  async function ensureSettings() {
    await settingsReady
    if (settingsError !== undefined) {
      if (settingsError instanceof NoteError) throw settingsError
      throw new NoteError('settings-unavailable', '便签墙设置无法加载，请查看 Harness 日志。')
    }
    return settingsStore
  }

  function view() {
    return { notes: store.list(), folders: store.listFolders(), limits: { ...LIMITS } }
  }

  const actions = {
    async state() {
      await ensureStore()
      return view()
    },
    async settings() {
      await ensureSettings()
      return { settings: settingsStore.get() }
    },
    async settingsUpdate(body) {
      await ensureSettings()
      return { settings: await settingsStore.update(body) }
    },
    async settingsReset() {
      await ensureSettings()
      return { settings: await settingsStore.reset() }
    },
    async add(body) {
      await ensureStore()
      const note = await store.add(body)
      return { ...view(), note }
    },
    async update(body) {
      await ensureStore()
      const note = await store.update(body)
      return { ...view(), note }
    },
    async remove(body) {
      await ensureStore()
      const removed = await store.remove(body)
      return { ...view(), removed }
    },
    async folderAdd(body) {
      await ensureStore()
      const folder = await store.addFolder(body)
      return { ...view(), folder }
    },
    async folderRename(body) {
      await ensureStore()
      const folder = await store.renameFolder(body)
      return { ...view(), folder }
    },
    async folderRemove(body) {
      await ensureStore()
      const removed = await store.removeFolder(body)
      return { ...view(), removed }
    },
    async moveNotes(body) {
      await ensureStore()
      const moved = await store.moveNotes(body)
      return { ...view(), moved }
    },
    async discardImage(body) {
      await ensureStore()
      const discarded = await store.discardImage(body)
      return { discarded }
    },
  }

  async function noteHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, failure('method-not-allowed', '只接受 POST。'))
        return
      }
      if (!trusted(req) || req.headers[TRUST_HEADER] !== '1') {
        sendJson(res, 403, failure('forbidden', '请求未通过同源校验。'))
        return
      }
      const contentType = req.headers['content-type']
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, failure('unsupported-media-type', '请求必须是 JSON。'))
        return
      }
      const body = await readJsonBody(req)
      const action = typeof body.action === 'string' ? body.action : ''
      const handlerForAction = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined
      if (handlerForAction === undefined) {
        sendJson(res, 400, failure('unknown-action', `未知操作：${action}`))
        return
      }
      const value = await handlerForAction(body)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof NoteError) {
        const status = error.code === 'body-too-large'
          ? 413
          : error.code === 'store-unavailable'
            || error.code === 'store-corrupt-unreadable'
            || error.code === 'settings-unavailable'
            ? 503
            : 400
        sendJson(res, status, failure(error.code, error.message))
        return
      }
      // Keep filesystem details (and absolute paths) out of the response.
      logger.error?.('[note-wall] 处理便签请求失败', error)
      sendJson(res, 500, failure('internal', '便签保存失败，请查看 Harness 日志。'))
    }
  }

  async function uploadHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, failure('method-not-allowed', '只接受 POST。'))
        return
      }
      if (!trusted(req) || req.headers[TRUST_HEADER] !== '1') {
        sendJson(res, 403, failure('forbidden', '请求未通过同源校验。'))
        return
      }
      // Never accept bytes while the note store itself is unusable: an upload
      // could not be attached and could no longer be discarded.
      await ensureStore()
      const declared = typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type'].split(';')[0].trim().toLowerCase()
        : ''
      if (!UPLOAD_TYPES.has(declared)) {
        sendJson(res, 415, failure('image-type-invalid', '只支持 PNG、JPEG、WebP、GIF 图片。'))
        return
      }
      const data = await readBinaryBody(req)
      if (data.length === 0) {
        sendJson(res, 400, failure('image-empty', '图片内容为空。'))
        return
      }
      const sniffed = sniffImage(data)
      if (sniffed === undefined || sniffed.mediaType !== declared) {
        sendJson(res, 415, failure('image-type-invalid', '图片内容与声明的格式不一致。'))
        return
      }
      const id = `${randomUUID()}.${sniffed.ext}`
      try {
        await mkdir(imagesDir, { recursive: true })
        await writeFile(join(imagesDir, id), data)
      } catch (error) {
        logger.error?.('[note-wall] 无法保存便签图片', error)
        sendJson(res, 500, failure('image-write-failed', '图片保存失败，请查看 Harness 日志。'))
        return
      }
      sendJson(res, 200, { ok: true, value: { id, url: IMAGE_PATH_PREFIX + id } })
    } catch (error) {
      if (error instanceof NoteError) {
        const status = error.code === 'image-too-large'
          ? 413
          : error.code === 'store-unavailable' || error.code === 'store-corrupt-unreadable'
            ? 503
            : 400
        sendJson(res, status, failure(error.code, error.message))
        return
      }
      logger.error?.('[note-wall] 处理图片上传失败', error)
      sendJson(res, 500, failure('image-write-failed', '图片保存失败，请查看 Harness 日志。'))
    }
  }

  // Image bytes are served without the plugin header because an <img> request
  // cannot send custom headers. Ids are random UUIDs, there is no listing route,
  // and the handler only reads from the plugin's own images directory.
  async function imageHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      res.end()
      return
    }
    const pathname = (typeof req.url === 'string' ? req.url : '').split('?')[0]
    const id = pathname.slice(IMAGE_PATH_PREFIX.length)
    if (!IMAGE_ID_PATTERN.test(id)) {
      notFound(res)
      return
    }
    let data
    try {
      data = await readFile(join(imagesDir, id))
    } catch {
      notFound(res)
      return
    }
    const mediaType = mediaTypeForImage(id)
    if (mediaType === undefined) {
      notFound(res)
      return
    }
    res.writeHead(200, {
      'content-type': mediaType,
      'content-length': data.length,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(data)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: noteHandler }),
    'note-wall: note API route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: IMAGE_UPLOAD_PATH, handler: uploadHandler }),
    'note-wall: image upload route',
  )

  // The webServer match appends '/' to a prefix (`pathname === prefix ||
  // pathname.startsWith(prefix + '/')`), so the registered prefix must not
  // carry a trailing slash. IMAGE_PATH_PREFIX (with the slash) stays for URL
  // building and for slicing the id inside imageHandler.
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: IMAGE_UPLOAD_PATH, handler: imageHandler }),
    'note-wall: image read route',
  )

  // Host-side tool: lets the agent add a note without going through the page.
  // v1.2.0 deliberately excludes images (upload stays a UI action). It is also
  // gated by the agentWrite setting, checked at call time, so installs that did
  // not opt in never receive notes written by an agent.
  ctx.effect(
    () => ctx.tools.register({
      name: 'note_wall_add',
      description: 'Add a sticky note to the Note wall. Use it for quick ideas or reminders; text is required. category is the note tag, color accepts the preset names (amber/peach/sky/mint/lilac/cream) or a #RRGGBB value, and link must be http(s). remindAt accepts an ISO 8601 date-time or any parseable date and is stored as ISO. folderId targets an existing folder; folderName targets a folder by exact name and creates it when missing (folderId wins when both are given). Requires the user to enable agent writes in the note wall settings. Images are not supported by this tool.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Note body, 1-500 characters.' },
          category: { type: 'string', description: 'Optional category/tag, up to 24 characters.' },
          color: { type: 'string', description: 'Optional note color: amber, peach, sky, mint, lilac, cream, or #RRGGBB.' },
          link: { type: 'string', description: 'Optional http/https link, up to 2048 characters.' },
          remindAt: { type: 'string', description: 'Optional reminder time as an ISO 8601 date-time (or any parseable date); stored normalized to ISO.' },
          folderId: { type: 'string', description: 'Optional existing folder id. Takes precedence over folderName.' },
          folderName: { type: 'string', description: 'Optional folder name, up to 40 characters; created when no folder with that exact name exists.' },
        },
        required: ['text'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: `Added to the note wall: ${value.note.text}` }],
      },
      async execute(args) {
        await ensureStore()
        await ensureSettings()
        if (!settingsStore.get().agentWrite.enabled) {
          throw new NoteError('tool-disabled', '便签墙的「允许 AI 写入」未开启，请先在便签墙设置里打开。')
        }
        const payload = args !== null && typeof args === 'object' ? args : {}
        const providedFolderId = payload.folderId
        const hasFolderId = typeof providedFolderId === 'string'
          ? providedFolderId.trim().length > 0
          : providedFolderId !== undefined && providedFolderId !== null
        let folderId = hasFolderId ? providedFolderId : ''
        if (!hasFolderId && typeof payload.folderName === 'string' && payload.folderName.trim().length > 0) {
          const name = payload.folderName.trim()
          const existing = store.listFolders().find(folder => folder.name === name)
          folderId = existing !== undefined ? existing.id : (await store.addFolder({ name })).id
        }
        const note = await store.add({
          text: payload.text,
          tag: payload.category,
          tone: payload.color,
          link: payload.link,
          folderId,
          remindAt: payload.remindAt,
        })
        return { note }
      },
    }),
    'note-wall: note_wall_add tool',
  )

  ctx.effect(
    () => () => {
      void store.flush()
      void settingsStore.flush()
    },
    'note-wall: flush note store and settings on unload',
  )
}
