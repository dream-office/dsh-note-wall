window.__ModuleLoader__.load({
  id: 'dsh-note-wall',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // dsh-note-wall — browser half, hand-written module-loader client.
    //
    // Registers two shell surfaces:
    //   sidebar.panellist  id  note-wall  — sticky-note glyph that opens the wall
    //   main               key note-wall  — the note wall page
    //
    // All traffic goes to the plugin's own same-origin route. No bundler, no JSX,
    // no client package imports; chrome colors come from --dsw-alias-* tokens,
    // while the pastel note fills are the plugin's own artwork.

    const API_PATH = '/plugins/dsh-note-wall/api'
    const IMAGE_UPLOAD_PATH = '/plugins/dsh-note-wall/image'
    const IMAGE_PATH_PREFIX = '/plugins/dsh-note-wall/image/'
    const API_HEADERS = { 'content-type': 'application/json', 'x-dsh-note-wall': '1' }
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    // Used until the host reports its own limits in `state`.
    const DEFAULT_LIMITS = {
      maxNotes: 500,
      maxNoteChars: 500,
      maxTagChars: 24,
      maxLinkChars: 2048,
      maxImageBytes: 3 * 1024 * 1024,
    }
    const CLOCK_INTERVAL_MS = 30000

    // A-version signature (see DESIGN-SIGNATURE.md): footer mark + console line
    // + a three-tap author note. No storage, no network, no data collection.
    const SIGNATURE_CLICK_COUNT = 3
    const SIGNATURE_CLICK_WINDOW_MS = 2000
    const SIGNATURE_PANEL_ID = 'nw-signature-note'
    const SIGNATURE_QUOTE_ZH = '把灵感，一张一张贴起来。'
    const SIGNATURE_QUOTE_EN = 'Pinning down inspiration, one note at a time.'
    const SIGNATURE_CONSOLE_TEXT = 'dsh-note-wall · dream-office · 把灵感，一张一张贴起来'

    const TONES = [
      { key: 'amber', zh: '暖黄', en: 'Amber' },
      { key: 'peach', zh: '蜜桃', en: 'Peach' },
      { key: 'sky', zh: '天蓝', en: 'Sky' },
      { key: 'mint', zh: '薄荷', en: 'Mint' },
      { key: 'lilac', zh: '丁香', en: 'Lilac' },
      { key: 'cream', zh: '奶油', en: 'Cream' },
    ]
    const TONE_KEYS = TONES.map(function (definition) { return definition.key })
    const HEX_TONE = /^#[0-9a-f]{6}$/i
    const PREFS_KEY = 'dsh-note-wall:prefs-v1'
    const DEFAULT_TONE = 'amber'

    function isPresetTone(tone) {
      return TONE_KEYS.indexOf(tone) >= 0
    }

    function isCustomTone(tone) {
      return typeof tone === 'string' && HEX_TONE.test(tone)
    }

    function isValidTone(tone) {
      return isPresetTone(tone) || isCustomTone(tone)
    }

    function toneClass(tone) {
      if (isPresetTone(tone)) return ' nw-tone-' + tone
      if (isCustomTone(tone)) return ' nw-tone-custom'
      return ''
    }

    function toneStyle(tone) {
      return isCustomTone(tone) ? { '--nw-accent': tone } : undefined
    }

    function readPrefs() {
      const fallback = { motion: true, tone: DEFAULT_TONE }
      try {
        if (typeof localStorage === 'undefined') return fallback
        const raw = localStorage.getItem(PREFS_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return {
          motion: !parsed || parsed.motion !== false,
          tone: parsed && isValidTone(parsed.tone) ? String(parsed.tone).toLowerCase() : DEFAULT_TONE,
        }
      } catch (error) {
        return fallback
      }
    }

    function writePrefs(next) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch (error) {
        // Preference persistence is optional; the page still works without it.
      }
    }

    /**
     * Pure three-tap tracker for the footer signature. Keeps only the taps that
     * are still inside the window; the third tap inside it opens the note and
     * clears the streak. Exposed on a test-only global so the real client file
     * can be exercised without a browser.
     */
    function signatureTap(taps, nowMs, windowMs) {
      const span = typeof windowMs === 'number' && windowMs > 0 ? windowMs : SIGNATURE_CLICK_WINDOW_MS
      const recent = []
      const history = Array.isArray(taps) ? taps : []
      for (const tap of history) {
        if (typeof tap === 'number' && nowMs - tap <= span) recent.push(tap)
      }
      recent.push(nowMs)
      if (recent.length >= SIGNATURE_CLICK_COUNT) return { taps: [], opened: true }
      return { taps: recent.slice(-(SIGNATURE_CLICK_COUNT - 1)), opened: false }
    }

    let signatureConsolePrinted = false

    function printSignatureConsole() {
      if (signatureConsolePrinted) return
      signatureConsolePrinted = true
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info(SIGNATURE_CONSOLE_TEXT)
        }
      } catch (error) {
        // A console line must never block plugin activation.
      }
    }

    if (typeof window !== 'undefined' && window.__DSH_NOTE_WALL_TEST__ && typeof window.__DSH_NOTE_WALL_TEST__ === 'object') {
      window.__DSH_NOTE_WALL_TEST__.signatureTap = signatureTap
      window.__DSH_NOTE_WALL_TEST__.signatureWindowMs = SIGNATURE_CLICK_WINDOW_MS
      window.__DSH_NOTE_WALL_TEST__.signatureConsoleText = SIGNATURE_CONSOLE_TEXT
    }

    // ---------------------------------------------------------------------------
    // HTTP
    // ---------------------------------------------------------------------------

    async function readApiResult(response) {
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        const failure = new Error('HTTP ' + response.status)
        failure.status = response.status
        failure.code = 'bad-response'
        throw failure
      }
      if (!response.ok || !body || body.ok !== true) {
        const info = body && body.error ? body.error : null
        const failure = new Error(
          info && info.message
            ? String(info.message)
            : info && info.code
              ? String(info.code)
              : 'HTTP ' + response.status,
        )
        failure.code = info && typeof info.code === 'string' ? info.code : ''
        failure.status = response.status
        throw failure
      }
      return body.value
    }

    async function apiCall(action, payload, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this shell')
      const options = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: API_HEADERS,
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      }
      if (signal) options.signal = signal
      return readApiResult(await fetch(API_PATH, options))
    }

    async function uploadImage(file, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this shell')
      const options = {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': file.type, 'x-dsh-note-wall': '1' },
        body: file,
      }
      if (signal) options.signal = signal
      return readApiResult(await fetch(IMAGE_UPLOAD_PATH, options))
    }

    // ---------------------------------------------------------------------------
    // Locale and formatting helpers
    // ---------------------------------------------------------------------------

    function isZhLocale(ctx) {
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        return active.toLowerCase().indexOf('zh') === 0
      } catch (error) {
        return false
      }
    }

    function useLocaleActive(ctx) {
      const subscribe = React.useCallback(function (listener) {
        const locale = ctx ? ctx.locale : null
        if (!locale || typeof locale.subscribe !== 'function') return function () {}
        const off = locale.subscribe(listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        try {
          const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
          return snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        } catch (error) {
          return ''
        }
      }, [ctx])
      const active = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return typeof active === 'string' ? active : ''
    }

    function useText(ctx) {
      const active = useLocaleActive(ctx)
      return React.useMemo(function () {
        const zh = String(active || '').toLowerCase().indexOf('zh') === 0
        return function (zhText, enText) {
          return zh ? zhText : enText
        }
      }, [active])
    }

    function themeColorScheme(ctx) {
      try {
        const theme = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : undefined
        const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null
        const scheme = snapshot && snapshot.active && snapshot.active.colorScheme
        return scheme === 'dark' ? 'dark' : 'light'
      } catch (error) {
        return 'light'
      }
    }

    function useColorScheme(ctx) {
      const subscribe = React.useCallback(function (listener) {
        if (!ctx || typeof ctx.on !== 'function') return function () {}
        const off = ctx.on('theme/change', listener)
        return typeof off === 'function' ? off : function () {}
      }, [ctx])
      const getSnapshot = React.useCallback(function () {
        return themeColorScheme(ctx)
      }, [ctx])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function toneName(t, definition) {
      return t(definition.zh, definition.en)
    }

    function formatRelative(iso, nowMs, t, locale) {
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      const diff = Math.max(0, nowMs - then)
      const minute = 60000
      if (diff < minute) return t('刚刚', 'Just now')
      if (diff < 60 * minute) {
        const minutes = Math.floor(diff / minute)
        return t(minutes + ' 分钟前', minutes + ' min ago')
      }
      if (diff < 24 * 60 * minute) {
        const hours = Math.floor(diff / (60 * minute))
        return t(hours + ' 小时前', hours + ' h ago')
      }
      if (diff < 7 * 24 * 60 * minute) {
        const days = Math.floor(diff / (24 * 60 * minute))
        return t(days + ' 天前', days + ' d ago')
      }
      const date = new Date(then)
      return t(
        date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日',
        date.toLocaleDateString(locale || undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      )
    }

    function formatAbsolute(iso, locale) {
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return ''
      try {
        return new Date(then).toLocaleString(locale || undefined)
      } catch (error) {
        return new Date(then).toString()
      }
    }

    function imageUrl(id) {
      return IMAGE_PATH_PREFIX + encodeURIComponent(id)
    }

    function shortenUrl(link) {
      try {
        const url = new URL(link)
        const rest = (url.pathname === '/' ? '' : url.pathname) + url.search
        const tail = rest.length > 30 ? rest.slice(0, 30) + '…' : rest
        return url.host + tail
      } catch (error) {
        return link.length > 42 ? link.slice(0, 42) + '…' : link
      }
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return Math.round(value) + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function revokeObjectUrl(url) {
      if (!url) return
      try {
        URL.revokeObjectURL(url)
      } catch (error) {
        // A URL from another document generation is already gone.
      }
    }

    function errorText(t, error, limits) {
      const codes = limits || DEFAULT_LIMITS
      const code = error && error.code ? String(error.code) : ''
      const messages = {
        forbidden: t('请求被拒绝，请从本机 Harness 页面打开便签墙。', 'The request was rejected; open this page from the local Harness.'),
        'method-not-allowed': t('请求方式不被允许。', 'That request method is not allowed.'),
        'unsupported-media-type': t('请求格式不正确。', 'Unsupported request format.'),
        'invalid-json': t('请求内容不是合法 JSON。', 'The request body is not valid JSON.'),
        'invalid-body': t('请求内容不完整。', 'The request body is incomplete.'),
        'request-aborted': t('请求中断了，请再试一次。', 'The request was interrupted; try again.'),
        'body-too-large': t('内容太长，无法保存。', 'The content is too large to save.'),
        'bad-response': t('便签服务返回了无法识别的内容。', 'The note service returned an unexpected response.'),
        'note-text-required': t('先写点什么再添加到墙上。', 'Write something before adding it to the wall.'),
        'note-text-too-long': t('便签最多 ' + codes.maxNoteChars + ' 个字符。', 'Notes are limited to ' + codes.maxNoteChars + ' characters.'),
        'note-tag-invalid': t('分类必须是文本。', 'The category must be text.'),
        'note-tag-too-long': t('分类最多 ' + codes.maxTagChars + ' 个字符。', 'Categories are limited to ' + codes.maxTagChars + ' characters.'),
        'note-tone-invalid': t('这个便签颜色不可用。', 'That note color is not available.'),
        'note-limit-reached': t('便签墙最多 ' + codes.maxNotes + ' 条，先删掉几条吧。', 'The wall holds up to ' + codes.maxNotes + ' notes; delete a few first.'),
        'note-id-required': t('缺少便签标识。', 'The note id is missing.'),
        'note-not-found': t('这条便签已经不存在了。', 'That note no longer exists.'),
        'note-nothing-to-update': t('没有需要保存的修改。', 'There is nothing to save.'),
        'note-link-invalid': t('链接必须是 http 或 https 地址。', 'The link must be an http or https address.'),
        'note-link-too-long': t('链接最多 ' + codes.maxLinkChars + ' 个字符。', 'Links are limited to ' + codes.maxLinkChars + ' characters.'),
        'note-image-invalid': t('图片标识无效。', 'That image reference is not valid.'),
        'note-image-missing': t('图片不存在或已被清理，请重新选择。', 'That image is gone; please pick it again.'),
        'note-conflict': t('这条便签已在别处修改，请重新打开后再编辑。', 'This note changed elsewhere; reopen it before editing.'),
        'image-too-large': t('图片不能超过 ' + formatBytes(codes.maxImageBytes) + '。', 'Images are limited to ' + formatBytes(codes.maxImageBytes) + '.'),
        'image-type-invalid': t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.'),
        'image-empty': t('图片内容为空。', 'The image is empty.'),
        'image-write-failed': t('图片保存失败，请查看 Harness 日志。', 'Saving the image failed; check the Harness log.'),
        'store-unavailable': t('便签存储暂时不可用，请查看 Harness 日志。', 'Note storage is unavailable; check the Harness log.'),
        'store-corrupt-unreadable': t('便签存储损坏且无法保留原文件，读写已停止。', 'Note storage is damaged and could not be preserved; reads and writes are stopped.'),
        'internal': t('便签保存失败，请查看 Harness 日志。', 'Saving the note failed; check the Harness log.'),
        'unknown-action': t('未知操作。', 'Unknown action.'),
      }
      if (messages[code]) return messages[code]
      if (error && error.message) return String(error.message)
      return t('操作失败，请重试。', 'Something went wrong; try again.')
    }

    // ---------------------------------------------------------------------------
    // Icon glyphs (currentColor only; no theme tokens needed inside the svg)
    // ---------------------------------------------------------------------------

    function svgProps(size) {
      return {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      }
    }

    function NoteGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', svgProps(size),
        h('path', { key: 'body', d: 'M6 3.5h9L19.5 8v11.6a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5z' }),
        h('path', { key: 'fold', d: 'M15 3.6V8h4.4' }),
        h('path', { key: 'line-a', d: 'M8.5 12.4h6.4' }),
        h('path', { key: 'line-b', d: 'M8.5 15.9h4' }),
      )
    }

    function PlusGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size), h('path', { d: 'M12 5v14M5 12h14' }))
    }

    function PencilGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('path', { key: 'body', d: 'M4 20l4.2-1 10.3-10.3a2.1 2.1 0 0 0-3-3L5.2 16 4 20z' }),
        h('path', { key: 'tip', d: 'M13.6 7.4l3 3' }),
      )
    }

    function TrashGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('path', { key: 'lid', d: 'M4 7h16' }),
        h('path', { key: 'handle', d: 'M9.2 7V5.4A1.4 1.4 0 0 1 10.6 4h2.8a1.4 1.4 0 0 1 1.4 1.4V7' }),
        h('path', { key: 'body', d: 'M6.6 7l.8 11.9a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.4 7' }),
        h('path', { key: 'line-a', d: 'M10.4 11v5.2' }),
        h('path', { key: 'line-b', d: 'M13.6 11v5.2' }),
      )
    }

    function LinkGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 13
      return h('svg', svgProps(size),
        h('path', { key: 'a', d: 'M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4' }),
        h('path', { key: 'b', d: 'M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4' }),
      )
    }

    function ImageGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 15
      return h('svg', svgProps(size),
        h('rect', { key: 'frame', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
        h('circle', { key: 'sun', cx: 9, cy: 10, r: 1.6 }),
        h('path', { key: 'hill', d: 'M5.2 17.4l4.4-4.4 3.2 3.2 2.4-2.4 3.6 3.6' }),
      )
    }

    function CloseGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size),
        h('path', { key: 'x', d: 'M6 6l12 12M18 6L6 18' }),
      )
    }

    function SparkleGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 14
      return h('svg', svgProps(size),
        h('path', { key: 'big', d: 'M12 3.5l1.7 4.6 4.8 1.7-4.8 1.7L12 16.1l-1.7-4.6-4.8-1.7 4.8-1.7z' }),
        h('path', { key: 'small', d: 'M18.2 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' }),
      )
    }

    function EmptyStackGlyph() {
      return h('svg', {
        width: 120,
        height: 88,
        viewBox: '0 0 120 88',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { key: 'back', x: 14, y: 22, width: 62, height: 52, rx: 11, fill: '#D9CBF7', transform: 'rotate(-8 45 48)' }),
        h('rect', { key: 'middle', x: 30, y: 14, width: 62, height: 52, rx: 11, fill: '#BFE9DD', transform: 'rotate(5 61 40)' }),
        h('rect', { key: 'front', x: 42, y: 22, width: 62, height: 52, rx: 11, fill: '#F8E5B0' }),
        h('path', { key: 'lines', d: 'M52 40h40M52 50h28', stroke: '#8A6A1C', strokeWidth: 2.4, strokeLinecap: 'round' }),
      )
    }

    // ---------------------------------------------------------------------------
    // Scoped stylesheet, rendered as a style element inside the page root
    // ---------------------------------------------------------------------------

    const CSS = `
.nw-root{height:100%;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.nw-root::-webkit-scrollbar{width:10px;height:10px}
.nw-root::-webkit-scrollbar-track{background:transparent}
.nw-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:999px}
.nw-page{max-width:1120px;margin:0 auto;padding:28px 32px 48px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px;min-height:100%}
.nw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.nw-title{margin:0;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.nw-sub{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.nw-count{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.nw-head-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nw-motion-toggle{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);font-family:inherit;font-size:11.5px;cursor:pointer}
.nw-motion-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nw-motion-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-motion-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.nw-motion-on .nw-motion-dot{background:var(--dsw-alias-brand-primary)}

.nw-tone-amber{--nw-accent:#F0C24B}
.nw-tone-peach{--nw-accent:#F2A6BC}
.nw-tone-sky{--nw-accent:#8FC4F0}
.nw-tone-mint{--nw-accent:#7FD3C0}
.nw-tone-lilac{--nw-accent:#B79CF0}
.nw-tone-cream{--nw-accent:#E4D3AE}

/* Dark theme: keep the tinted surfaces darker so the host's light text keeps
   full contrast instead of sitting on a mid-tone olive/brown card. */
.nw-dark .nw-compose{background:color-mix(in srgb,var(--nw-accent) 26%,var(--dsw-alias-bg-layer-1))}
.nw-dark .nw-note{background:color-mix(in srgb,var(--nw-accent) 22%,var(--dsw-alias-bg-layer-1))}

/* A custom color can be arbitrarily dark or light, so keep its surface near the
   theme surface and express the hue through a tinted border instead of dropping
   the text/placeholder contrast. */
.nw-tone-custom.nw-compose{background:color-mix(in srgb,var(--nw-accent) 22%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--nw-accent) 58%,var(--dsw-alias-border-l1))}
.nw-tone-custom.nw-note{background:color-mix(in srgb,var(--nw-accent) 20%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--nw-accent) 58%,var(--dsw-alias-border-l1))}
.nw-dark .nw-tone-custom.nw-compose{background:color-mix(in srgb,var(--nw-accent) 17%,var(--dsw-alias-bg-layer-1))}
.nw-dark .nw-tone-custom.nw-note{background:color-mix(in srgb,var(--nw-accent) 15%,var(--dsw-alias-bg-layer-1))}

.nw-compose{border-radius:22px;padding:20px 22px 14px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--nw-accent) 52%,var(--dsw-alias-bg-layer-1))}
.nw-compose:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-compose-dragging{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-compose-input{display:block;width:100%;box-sizing:border-box;min-height:92px;padding:0;border:none;outline:none;background:transparent;resize:none;font-family:inherit;font-size:17.5px;line-height:1.65;color:var(--dsw-alias-label-primary)}
.nw-compose-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 70%,transparent);opacity:1}
.nw-compose-input:focus-visible{outline:none}
.nw-compose-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:10px}
.nw-palette{display:flex;align-items:center;gap:4px;padding:2px}
.nw-swatch{position:relative;width:24px;height:24px;padding:0;border:none;border-radius:50%;background:transparent;cursor:pointer;flex:none;transition:transform .12s ease}
.nw-swatch::before{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--nw-accent);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.nw-motion .nw-swatch:hover{transform:scale(1.06)}
.nw-swatch-selected::before{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 3px var(--dsw-alias-label-primary)}
.nw-swatch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-swatch-small::before{inset:5px}
.nw-swatch-custom::before{background:var(--nw-custom,conic-gradient(from 210deg,#F0C24B,#F2A6BC,#8FC4F0,#7FD3C0,#B79CF0,#F0C24B))}
.nw-tag-input{width:128px;height:30px;padding:0 9px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.nw-tag-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 68%,transparent);opacity:1}
.nw-tag-input:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent)}
.nw-tag-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-bg-layer-1)}
.nw-link-field{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);min-width:0}
.nw-link-field:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent)}
.nw-link-field:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-bg-layer-1)}
.nw-link-input{width:132px;min-width:64px;border:none;outline:none;background:transparent;font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.nw-link-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent);opacity:1}
.nw-attach-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border-radius:999px;border:.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 30%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);font-family:inherit;font-size:12.5px;cursor:pointer}
.nw-attach-btn:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 65%,transparent);color:var(--dsw-alias-label-primary)}
.nw-attach-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-file-input{display:none}
.nw-compose-preview{display:flex;align-items:center;gap:10px;margin-top:10px;padding:6px 8px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.nw-preview-thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
.nw-preview-meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;font-size:11px;color:var(--dsw-alias-label-secondary)}
.nw-preview-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-compose-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.nw-kbd{font-size:11.5px;letter-spacing:.02em;color:color-mix(in srgb,var(--dsw-alias-label-primary) 68%,transparent);white-space:nowrap}
.nw-add{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 16px;border:none;border-radius:999px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background-color .15s ease}
.nw-add:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.nw-add:disabled{background:var(--dsw-alias-button-primary-dimmed);cursor:default}
.nw-add:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

.nw-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));align-items:start}
.nw-note{display:flex;flex-direction:column;gap:10px;min-height:182px;padding:16px 18px;border-radius:18px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--nw-accent) 42%,var(--dsw-alias-bg-layer-1));box-sizing:border-box}
.nw-note:hover{border-color:var(--dsw-alias-border-l2)}
.nw-note-editing:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note-body{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.nw-note-tag{font-size:12px;font-weight:600;letter-spacing:.04em;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent)}
.nw-note-text{margin:0;font-size:16px;line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.nw-note-image{display:block;border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);margin:0 0 2px;background:var(--dsw-alias-bg-layer-2)}
.nw-note-image img{display:block;width:100%;max-height:190px;object-fit:cover}
.nw-note-image:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-note-link{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;font-size:12px;color:var(--dsw-alias-link);text-decoration:none;padding:2px 0}
.nw-note-link:hover{text-decoration:underline}
.nw-note-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.nw-note-link-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-note-editor{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.nw-edit-input{display:block;width:100%;box-sizing:border-box;min-height:82px;padding:0;border:none;outline:none;background:transparent;resize:vertical;font-family:inherit;font-size:15px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.nw-edit-input:focus-visible{outline:none}
.nw-edit-tag{width:100%;box-sizing:border-box;height:26px;padding:0;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-edit-tag::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nw-edit-tag:focus-visible{outline:none;border-bottom-color:var(--dsw-alias-brand-primary)}
.nw-edit-link{width:100%;box-sizing:border-box;height:26px;padding:0;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-edit-link::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.nw-edit-link:focus-visible{outline:none;border-bottom-color:var(--dsw-alias-brand-primary)}
.nw-edit-image{display:flex;align-items:center;gap:8px;padding:6px;border-radius:10px;border:.5px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.nw-edit-image img{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
.nw-edit-image-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.nw-edit-palette{display:flex;align-items:center;gap:4px;padding-top:2px}
.nw-note-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 72%,transparent)}
.nw-note-time{flex:none}
.nw-note-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:wrap;opacity:.55;transition:opacity .12s ease}
.nw-note:hover .nw-note-actions,.nw-note:focus-within .nw-note-actions{opacity:1}
.nw-confirm-text{font-size:11.5px;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent)}
.nw-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-primary) 84%,transparent);cursor:pointer}
.nw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.nw-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-mini{height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;cursor:pointer}
.nw-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nw-mini:disabled{opacity:.6;cursor:default}
.nw-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.nw-mini-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base)}
.nw-mini-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.nw-mini-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.nw-mini-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.nw-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:12px;font-size:12px;line-height:1.6;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nw-banner-error{border-color:var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1))}
.nw-banner-text{flex:1;min-width:0;overflow-wrap:anywhere}
.nw-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:44px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nw-spinner{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:nw-spin .9s linear infinite;flex:none}
.nw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:52px 20px;border-radius:22px;border:.5px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);text-align:center}
.nw-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nw-empty-hint{max-width:420px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.nw-page-foot{display:flex;align-items:flex-end;justify-content:flex-start;margin-top:auto;padding-top:8px}
.nw-signature-wrap{position:relative;display:inline-flex;flex-direction:column;align-items:flex-start;gap:8px;max-width:100%}
.nw-signature{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 2px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;letter-spacing:.02em;opacity:.55;cursor:pointer;user-select:none}
.nw-signature:hover,.nw-signature:focus-visible{opacity:1}
.nw-signature:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.nw-signature-mark{width:10px;height:10px;border-radius:3px;background:#5B57F0;flex:none}
.nw-dark .nw-signature-mark{background:#8B87FF}
.nw-signature-pop{display:flex;align-items:center;gap:12px;max-width:min(100%,360px);box-sizing:border-box;padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.nw-signature-quote{margin:0;font-size:13px;line-height:1.6;min-width:0;overflow-wrap:anywhere}
.nw-signature-close{flex:none}
.nw-motion .nw-signature{transition:opacity .12s ease}
.nw-motion .nw-signature-pop{animation:nw-signature-in .16s ease-out}
@keyframes nw-signature-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes nw-spin{to{transform:rotate(360deg)}}
.nw-motion .nw-compose{transition:background-color .18s ease}
.nw-motion .nw-note{animation:nw-note-in .22s ease-out backwards;transition:transform .16s ease,border-color .18s ease,background-color .18s ease}
.nw-motion .nw-note:hover{transform:translateY(-2px)}
.nw-motion .nw-add:not(:disabled):active{transform:scale(.97)}
.nw-motion .nw-swatch-selected::before{animation:nw-pop .18s ease-out}
.nw-motion .nw-compose:focus-within{animation:nw-focus .25s ease-out}
@keyframes nw-note-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
@keyframes nw-pop{0%{transform:scale(.82)}100%{transform:scale(1)}}
@keyframes nw-focus{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}100%{box-shadow:0 0 0 6px transparent}}
@media (max-width:720px){.nw-page{padding:20px 16px 36px}.nw-compose{padding:16px 16px 12px;border-radius:18px}.nw-compose-input{min-height:76px;font-size:16.5px}.nw-compose-actions{margin-left:0;width:100%;justify-content:flex-end}.nw-kbd{display:none}.nw-tag-input{width:104px}.nw-grid{grid-template-columns:1fr}.nw-count{font-size:11px}}
@media (prefers-reduced-motion:reduce){.nw-swatch,.nw-note,.nw-note-actions,.nw-compose,.nw-add,.nw-spinner{transition:none;animation:none}.nw-motion .nw-note{animation:none;transform:none}.nw-motion .nw-note:hover{transform:none}.nw-motion .nw-compose:focus-within{animation:none}.nw-motion .nw-swatch-selected::before{animation:none}.nw-motion .nw-add:not(:disabled):active{transform:none}.nw-motion .nw-swatch:hover{transform:none}.nw-motion .nw-signature{transition:none}.nw-motion .nw-signature-pop{animation:none}}
`

    function Styles() {
      return h('style', null, CSS)
    }

    // ---------------------------------------------------------------------------
    // Page pieces
    // ---------------------------------------------------------------------------

    function EmptyWall(props) {
      const t = props.t
      return h('div', { className: 'nw-empty' },
        h(EmptyStackGlyph, null),
        h('div', { className: 'nw-empty-title' }, t('墙上还是一张白纸', 'The wall is still blank')),
        h('div', { className: 'nw-empty-hint' },
          t(
            '在上面写下第一个灵感，按 ⌘/Ctrl + Enter 就能贴上墙。',
            'Write your first idea above and press ⌘/Ctrl + Enter to pin it up.',
          ),
        ),
      )
    }

    function NoteCard(props) {
      const note = props.note
      const editing = props.editing
      const t = props.t
      const limits = props.limits || DEFAULT_LIMITS
      const edited = note.updatedAt !== note.createdAt
      const tone = editing !== null ? editing.tone : note.tone
      const pending = props.pending || null
      const busy = pending !== null
      const confirmRef = React.useRef(null)
      const editFileRef = React.useRef(null)
      const editColorRef = React.useRef(null)

      React.useEffect(function () {
        if (props.confirming && confirmRef.current && typeof confirmRef.current.focus === 'function') {
          confirmRef.current.focus()
        }
      }, [props.confirming])

      const attachedPreview = editing !== null
        ? (editing.imagePreview || (editing.image ? imageUrl(editing.image) : ''))
        : ''

      function pickEditImage() {
        if (editFileRef.current) editFileRef.current.click()
      }

      function onEditFilePicked(event) {
        const files = event.target.files
        const file = files && files.length > 0 ? files[0] : null
        event.target.value = ''
        if (file) props.onEditImageFile(file)
      }

      const editor = editing !== null
        ? h('div', { className: 'nw-note-editor' },
            h('textarea', {
              className: 'nw-edit-input',
              value: editing.text,
              rows: 3,
              maxLength: limits.maxNoteChars,
              autoFocus: true,
              'aria-label': t('编辑便签', 'Edit note'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { text: event.target.value }))
              },
            }),
            h('input', {
              className: 'nw-edit-tag',
              type: 'text',
              value: editing.tag,
              maxLength: limits.maxTagChars,
              placeholder: t('分类（可选）', 'Category (optional)'),
              'aria-label': t('分类（可选）', 'Category (optional)'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { tag: event.target.value }))
              },
            }),
            h('input', {
              className: 'nw-edit-link',
              type: 'text',
              value: editing.link || '',
              maxLength: limits.maxLinkChars,
              placeholder: t('链接（可选）', 'Link (optional)'),
              'aria-label': t('链接（可选）', 'Link (optional)'),
              onChange: function (event) {
                props.onChangeEdit(Object.assign({}, editing, { link: event.target.value }))
              },
            }),
            attachedPreview
              ? h('div', { className: 'nw-edit-image' },
                  h('img', { src: attachedPreview, alt: '', draggable: false }),
                  h('div', { className: 'nw-edit-image-actions' },
                    h('button', {
                      type: 'button',
                      className: 'nw-mini',
                      onClick: pickEditImage,
                    }, t('换一张', 'Replace')),
                    h('button', {
                      type: 'button',
                      className: 'nw-mini',
                      onClick: props.onClearEditImage,
                    }, t('移除图片', 'Remove image')),
                    h('input', {
                      ref: editFileRef,
                      type: 'file',
                      className: 'nw-file-input',
                      accept: IMAGE_TYPES.join(','),
                      onChange: onEditFilePicked,
                    }),
                  ),
                )
              : h('div', { className: 'nw-edit-image-actions' },
                  h('button', {
                    type: 'button',
                    className: 'nw-attach-btn',
                    onClick: pickEditImage,
                  },
                    h(ImageGlyph, { size: 14 }),
                    h('span', null, t('添加图片', 'Add image')),
                  ),
                  h('input', {
                    ref: editFileRef,
                    type: 'file',
                    className: 'nw-file-input',
                    accept: IMAGE_TYPES.join(','),
                    onChange: onEditFilePicked,
                  }),
                ),
            h('div', { className: 'nw-edit-palette', role: 'group', 'aria-label': t('便签颜色', 'Note color') },
              TONES.map(function (definition) {
                const name = toneName(t, definition)
                return h('button', {
                  key: definition.key,
                  type: 'button',
                  className: 'nw-swatch nw-swatch-small nw-tone-' + definition.key + (editing.tone === definition.key ? ' nw-swatch-selected' : ''),
                  'aria-label': name,
                  'aria-pressed': editing.tone === definition.key,
                  title: name,
                  onClick: function () {
                    props.onChangeEdit(Object.assign({}, editing, { tone: definition.key }))
                  },
                })
              }),
              h('button', {
                key: 'custom',
                type: 'button',
                className: 'nw-swatch nw-swatch-small nw-swatch-custom' + (isCustomTone(editing.tone) ? ' nw-swatch-selected' : ''),
                style: isCustomTone(editing.tone) ? { '--nw-custom': editing.tone } : undefined,
                'aria-label': t('自定义颜色', 'Custom color'),
                'aria-pressed': isCustomTone(editing.tone),
                title: t('自定义颜色', 'Custom color'),
                onClick: function () { if (editColorRef.current) editColorRef.current.click() },
              }),
              h('input', {
                ref: editColorRef,
                type: 'color',
                className: 'nw-file-input',
                value: isCustomTone(editing.tone) ? editing.tone : '#f0c24b',
                'aria-label': t('自定义颜色', 'Custom color'),
                onChange: function (event) {
                  props.onChangeEdit(Object.assign({}, editing, { tone: String(event.target.value).toLowerCase() }))
                },
              }),
            ),
          )
        : h('div', { className: 'nw-note-body' },
            note.tag ? h('div', { className: 'nw-note-tag' }, note.tag) : null,
            h('p', { className: 'nw-note-text' }, note.text),
            note.link
              ? h('a', {
                  className: 'nw-note-link',
                  href: note.link,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: note.link,
                },
                  h(LinkGlyph, { size: 13 }),
                  h('span', { className: 'nw-note-link-text' }, shortenUrl(note.link)),
                )
              : null,
          )

      const image = editing === null && note.image ? imageUrl(note.image) : ''

      let actions
      if (editing !== null) {
        actions = [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'nw-mini',
            disabled: busy,
            onClick: props.onCancelEdit,
          }, t('取消', 'Cancel')),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'nw-mini nw-mini-primary',
            disabled: busy,
            onClick: props.onSaveEdit,
          }, pending === 'save' ? t('保存中…', 'Saving…') : t('保存', 'Save')),
        ]
      } else if (props.confirming) {
        actions = [
          h('span', { key: 'ask', className: 'nw-confirm-text' }, t('删除这条便签？', 'Delete this note?')),
          h('button', {
            key: 'cancel-delete',
            type: 'button',
            className: 'nw-mini',
            disabled: busy,
            onClick: props.onCancelDelete,
          }, t('取消', 'Cancel')),
          h('button', {
            key: 'confirm-delete',
            type: 'button',
            className: 'nw-mini nw-mini-danger',
            disabled: busy,
            ref: confirmRef,
            onClick: function () { props.onDelete(note) },
          }, pending === 'delete' ? t('删除中…', 'Deleting…') : t('删除', 'Delete')),
        ]
      } else {
        actions = [
          h('button', {
            key: 'edit',
            type: 'button',
            className: 'nw-iconbtn',
            title: t('编辑', 'Edit'),
            'aria-label': t('编辑便签', 'Edit note'),
            onClick: function () { props.onBeginEdit(note) },
          }, h(PencilGlyph, { size: 15 })),
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'nw-iconbtn',
            title: t('删除', 'Delete'),
            'aria-label': t('删除便签', 'Delete note'),
            onClick: props.onAskDelete,
          }, h(TrashGlyph, { size: 15 })),
        ]
      }

      return h('article', {
        className: 'nw-note' + toneClass(tone) + (editing !== null ? ' nw-note-editing' : ''),
        style: toneStyle(tone),
        onKeyDown: function (event) {
          if (event.key !== 'Escape') return
          if (editing !== null) {
            event.preventDefault()
            props.onCancelEdit()
            return
          }
          if (props.confirming) {
            event.preventDefault()
            props.onCancelDelete()
          }
        },
      },
        image
          ? h('a', {
              className: 'nw-note-image',
              href: image,
              target: '_blank',
              rel: 'noreferrer noopener',
              title: t('打开图片', 'Open image'),
            }, h('img', { src: image, alt: t('便签图片', 'Note image'), loading: 'lazy', draggable: false }))
          : null,
        editor,
        h('footer', { className: 'nw-note-foot' },
          h('span', { className: 'nw-note-time', title: formatAbsolute(note.createdAt, props.locale) },
            formatRelative(note.createdAt, props.now, t, props.locale) + (edited ? t(' · 已编辑', ' · edited') : ''),
          ),
          h('div', { className: 'nw-note-actions' }, actions),
        ),
      )
    }

    function NoteWallPage(props) {
      const ctx = props.ctx
      const t = useText(ctx)
      const activeLocale = useLocaleActive(ctx)
      const colorScheme = useColorScheme(ctx)
      const [notes, setNotes] = React.useState([])
      const [limits, setLimits] = React.useState(DEFAULT_LIMITS)
      const [status, setStatus] = React.useState('loading')
      const [loadError, setLoadError] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [draftTag, setDraftTag] = React.useState('')
      const [draftLink, setDraftLink] = React.useState('')
      const [tone, setTone] = React.useState(function () { return readPrefs().tone })
      const [motion, setMotion] = React.useState(function () { return readPrefs().motion })
      const [composeFile, setComposeFile] = React.useState(null)
      const [composePreview, setComposePreview] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [now, setNow] = React.useState(function () { return Date.now() })
      const [signatureOpen, setSignatureOpen] = React.useState(false)
      const textareaRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const colorInputRef = React.useRef(null)
      const signatureButtonRef = React.useRef(null)
      const signatureCloseRef = React.useRef(null)
      const signatureWasOpenRef = React.useRef(false)
      const signatureTapsRef = React.useRef([])
      const aliveRef = React.useRef(true)
      const limitsRef = React.useRef(DEFAULT_LIMITS)
      const loadSeqRef = React.useRef(0)
      const hasDataRef = React.useRef(false)
      const pendingRef = React.useRef(false)
      const tRef = React.useRef(t)
      const composePreviewRef = React.useRef('')
      const editPreviewRef = React.useRef('')

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      React.useEffect(function () {
        return function () {
          revokeObjectUrl(composePreviewRef.current)
          revokeObjectUrl(editPreviewRef.current)
          composePreviewRef.current = ''
          editPreviewRef.current = ''
        }
      }, [])

      React.useEffect(function () {
        tRef.current = t
      }, [t])

      React.useEffect(function () {
        const controller = new AbortController()
        const loadId = loadSeqRef.current + 1
        loadSeqRef.current = loadId
        setStatus(function (current) { return hasDataRef.current ? current : 'loading' })
        setLoadError('')
        apiCall('state', null, controller.signal)
          .then(function (value) {
            if (loadSeqRef.current !== loadId) return
            if (value && Array.isArray(value.notes)) {
              accept(value)
            } else {
              setStatus('error')
              setLoadError(errorText(tRef.current, { code: 'bad-response' }, limitsRef.current))
            }
          })
          .catch(function (error) {
            if (loadSeqRef.current !== loadId || (error && error.name === 'AbortError')) return
            const message = errorText(tRef.current, error, limitsRef.current)
            if (hasDataRef.current) {
              setActionError(message)
            } else {
              setStatus('error')
              setLoadError(message)
            }
          })
        return function () { controller.abort() }
      }, [reloadKey])

      React.useEffect(function () {
        const element = textareaRef.current
        if (element && typeof element.focus === 'function') element.focus()
      }, [])

      React.useEffect(function () {
        const timer = setInterval(function () {
          if (aliveRef.current) setNow(Date.now())
        }, CLOCK_INTERVAL_MS)
        return function () { clearInterval(timer) }
      }, [])

      React.useEffect(function () {
        if (signatureOpen) {
          signatureWasOpenRef.current = true
          if (signatureCloseRef.current && typeof signatureCloseRef.current.focus === 'function') {
            signatureCloseRef.current.focus()
          }
          return
        }
        if (signatureWasOpenRef.current) {
          signatureWasOpenRef.current = false
          if (signatureButtonRef.current && typeof signatureButtonRef.current.focus === 'function') {
            signatureButtonRef.current.focus()
          }
        }
      }, [signatureOpen])

      React.useEffect(function () {
        if (!signatureOpen) return function () {}
        function onSignatureKeyDown(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setSignatureOpen(false)
        }
        document.addEventListener('keydown', onSignatureKeyDown)
        return function () { document.removeEventListener('keydown', onSignatureKeyDown) }
      }, [signatureOpen])

      function accept(value) {
        if (!value || !Array.isArray(value.notes)) return
        if (value.limits && typeof value.limits === 'object') {
          const next = {
            maxNotes: Number(value.limits.maxNotes) || DEFAULT_LIMITS.maxNotes,
            maxNoteChars: Number(value.limits.maxNoteChars) || DEFAULT_LIMITS.maxNoteChars,
            maxTagChars: Number(value.limits.maxTagChars) || DEFAULT_LIMITS.maxTagChars,
            maxLinkChars: Number(value.limits.maxLinkChars) || DEFAULT_LIMITS.maxLinkChars,
            maxImageBytes: Number(value.limits.maxImageBytes) || DEFAULT_LIMITS.maxImageBytes,
          }
          limitsRef.current = next
          setLimits(next)
        }
        setNotes(value.notes)
        setStatus('ready')
        setLoadError('')
        hasDataRef.current = true
      }

      function beginPending(kind) {
        pendingRef.current = true
        setPending(kind)
        setActionError('')
      }

      function endPending() {
        pendingRef.current = false
        if (aliveRef.current) setPending(null)
      }

      function validateImageFile(file) {
        if (!file) return ''
        if (IMAGE_TYPES.indexOf(file.type) < 0) {
          return t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.')
        }
        if (file.size > limitsRef.current.maxImageBytes) {
          const limit = formatBytes(limitsRef.current.maxImageBytes)
          return t('图片不能超过 ' + limit + '。', 'Images are limited to ' + limit + '.')
        }
        return ''
      }

      function setToneValue(next) {
        const normalized = String(next || '').toLowerCase()
        if (!isValidTone(normalized)) return
        setTone(normalized)
        writePrefs({ motion: motion, tone: normalized })
      }

      function toggleMotion() {
        const next = !motion
        setMotion(next)
        writePrefs({ motion: next, tone: tone })
      }

      function openSignature() {
        signatureTapsRef.current = []
        setSignatureOpen(true)
      }

      function closeSignature() {
        signatureTapsRef.current = []
        setSignatureOpen(false)
      }

      function onSignatureClick(event) {
        if (signatureOpen) {
          closeSignature()
          return
        }
        // A keyboard-generated click (Enter/Space) opens immediately; the
        // three-tap rule is only for pointer input.
        if (event && event.detail === 0) {
          openSignature()
          return
        }
        const result = signatureTap(signatureTapsRef.current, Date.now(), SIGNATURE_CLICK_WINDOW_MS)
        signatureTapsRef.current = result.taps
        if (result.opened) openSignature()
      }

      function setComposeAttachment(file) {
        const problem = validateImageFile(file)
        if (problem) {
          setActionError(problem)
          return
        }
        revokeObjectUrl(composePreviewRef.current)
        const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
        composePreviewRef.current = url
        setComposeFile(file)
        setComposePreview(url)
      }

      function clearComposeAttachment() {
        revokeObjectUrl(composePreviewRef.current)
        composePreviewRef.current = ''
        setComposeFile(null)
        setComposePreview('')
      }

      function pickComposeImage() {
        if (fileRef.current) fileRef.current.click()
      }

      function onComposeFilePicked(event) {
        const files = event.target.files
        const file = files && files.length > 0 ? files[0] : null
        event.target.value = ''
        if (file) setComposeAttachment(file)
      }

      function onComposePaste(event) {
        const data = event.clipboardData
        if (!data || !data.files) return
        for (let index = 0; index < data.files.length; index += 1) {
          const file = data.files[index]
          if (file && typeof file.type === 'string' && file.type.indexOf('image/') === 0) {
            event.preventDefault()
            setComposeAttachment(file)
            return
          }
        }
      }

      function onComposeDragOver(event) {
        const types = event.dataTransfer && event.dataTransfer.types
        if (!types || types.length === 0) return
        // Claim every drop over the composer so a non-image drop cannot navigate
        // the page away and discard the draft.
        event.preventDefault()
        for (let index = 0; index < types.length; index += 1) {
          if (types[index] === 'Files') {
            setDragging(true)
            return
          }
        }
      }

      function onComposeDragLeave() {
        setDragging(false)
      }

      function onComposeDrop(event) {
        // Always claim the drop; only supported images are attached.
        event.preventDefault()
        setDragging(false)
        const files = event.dataTransfer && event.dataTransfer.files
        if (!files || files.length === 0) return
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          if (file && typeof file.type === 'string' && file.type.indexOf('image/') === 0) {
            setComposeAttachment(file)
            return
          }
        }
        setActionError(t('只支持 PNG、JPEG、WebP、GIF 图片。', 'Only PNG, JPEG, WebP and GIF images are supported.'))
      }

      function revokeEditPreview() {
        revokeObjectUrl(editPreviewRef.current)
        editPreviewRef.current = ''
      }

      function attachEditImage(file) {
        if (editing === null || !file) return
        const problem = validateImageFile(file)
        if (problem) {
          setActionError(problem)
          return
        }
        revokeEditPreview()
        const url = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
        editPreviewRef.current = url
        setEditing(Object.assign({}, editing, { imageFile: file, imagePreview: url, imageTouched: true }))
      }

      function clearEditImage() {
        if (editing === null) return
        revokeEditPreview()
        setEditing(Object.assign({}, editing, { imageFile: null, imagePreview: '', image: '', imageTouched: true }))
      }

      async function addNote(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const text = draft.trim()
        if (text.length === 0 || pendingRef.current) return
        beginPending('add')
        let uploadedId = ''
        try {
          if (composeFile) {
            const uploaded = await uploadImage(composeFile)
            if (!uploaded || typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
              throw Object.assign(new Error('bad upload response'), { code: 'bad-response' })
            }
            uploadedId = uploaded.id
          }
          const value = await apiCall('add', {
            text: text,
            tag: draftTag.trim(),
            tone: tone,
            link: draftLink.trim(),
            image: uploadedId,
          })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setDraft('')
          setDraftTag('')
          setDraftLink('')
          clearComposeAttachment()
          if (textareaRef.current && typeof textareaRef.current.focus === 'function') textareaRef.current.focus()
        } catch (error) {
          if (uploadedId) void apiCall('discardImage', { id: uploadedId }).catch(function () {})
          if (aliveRef.current) setActionError(errorText(t, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      function beginEdit(note) {
        revokeEditPreview()
        setConfirming(null)
        setEditing({
          id: note.id,
          text: note.text,
          tag: note.tag || '',
          tone: note.tone,
          link: note.link || '',
          image: note.image || '',
          imageFile: null,
          imagePreview: '',
          imageTouched: false,
          baseUpdatedAt: note.updatedAt,
        })
      }

      function cancelEdit() {
        revokeEditPreview()
        setEditing(null)
      }

      /**
       * A stale editor is recoverable: reload the wall, adopt the newest revision
       * (and image unless the user changed it locally), then let the user save
       * again instead of locking them out with the same conflict forever.
       */
      async function recoverFromConflict(noteId) {
        try {
          const value = await apiCall('state')
          if (!aliveRef.current) return
          accept(value)
          const latest = value && Array.isArray(value.notes)
            ? value.notes.find(function (item) { return item && item.id === noteId })
            : undefined
          if (!latest) {
            revokeEditPreview()
            setEditing(null)
            setActionError(t('这条便签已在别处删除。', 'That note was deleted elsewhere.'))
            return
          }
          setEditing(function (current) {
            if (!current || current.id !== noteId) return current
            return Object.assign({}, current, {
              baseUpdatedAt: latest.updatedAt,
              image: current.imageTouched ? current.image : latest.image,
            })
          })
          setActionError(t(
            '这条便签已在别处修改。已同步最新版本，再点「保存」会覆盖为你现在的内容。',
            'This note changed elsewhere. The latest version is loaded; saving again will overwrite it with your text.',
          ))
        } catch (refreshError) {
          if (aliveRef.current) {
            setActionError(t(
              '这条便签已在别处修改。请关闭并重新打开编辑，或刷新页面后再试。',
              'This note changed elsewhere. Close and reopen the editor, or reload the page.',
            ))
          }
        }
      }

      async function saveEdit() {
        if (editing === null || pendingRef.current) return
        const text = editing.text.trim()
        if (text.length === 0) {
          setActionError(t('便签内容不能为空。', 'A note cannot be empty.'))
          return
        }
        beginPending('save')
        let uploadedId = ''
        try {
          let imageId = editing.image || ''
          if (editing.imageFile) {
            const uploaded = await uploadImage(editing.imageFile)
            if (!uploaded || typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
              throw Object.assign(new Error('bad upload response'), { code: 'bad-response' })
            }
            uploadedId = uploaded.id
            imageId = uploaded.id
          }
          const value = await apiCall('update', {
            id: editing.id,
            text: text,
            tag: editing.tag.trim(),
            tone: editing.tone,
            link: editing.link.trim(),
            image: imageId,
            baseUpdatedAt: editing.baseUpdatedAt,
          })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          revokeEditPreview()
          setEditing(null)
        } catch (error) {
          if (uploadedId) void apiCall('discardImage', { id: uploadedId }).catch(function () {})
          if (aliveRef.current) {
            if (error && error.code === 'note-conflict' && editing !== null) {
              await recoverFromConflict(editing.id)
            } else {
              setActionError(errorText(t, error, limitsRef.current))
            }
          }
        } finally {
          endPending()
        }
      }

      async function removeNote(note) {
        if (pendingRef.current) return
        beginPending('delete')
        try {
          const value = await apiCall('remove', { id: note.id })
          if (!aliveRef.current) return
          loadSeqRef.current += 1
          accept(value)
          setConfirming(null)
          if (editing !== null && editing.id === note.id) {
            revokeEditPreview()
            setEditing(null)
          }
        } catch (error) {
          if (aliveRef.current) setActionError(errorText(t, error, limitsRef.current))
        } finally {
          endPending()
        }
      }

      const canAdd = draft.trim().length > 0 && pending === null
      const countText = notes.length === 0
        ? t('还没有便签', 'No notes yet')
        : t('共 ' + notes.length + ' 条便签', notes.length + (notes.length === 1 ? ' note' : ' notes'))

      return h('div', {
        className: 'nw-root' + (motion ? ' nw-motion' : '') + (colorScheme === 'dark' ? ' nw-dark' : ''),
      },
        h(Styles, { key: 'styles' }),
        h('div', { className: 'nw-page' },
          h('header', { className: 'nw-head', key: 'head' },
            h('div', null,
              h('h2', { className: 'nw-title' }, t('灵感便签墙', 'Inspiration wall')),
              h('p', { className: 'nw-sub' },
                t('随手记下，等它长成下一个想法。', 'Capture it now — let it grow into the next idea.'),
              ),
            ),
            h('div', { className: 'nw-head-tools' },
              status === 'ready' ? h('span', { className: 'nw-count' }, countText) : null,
              h('button', {
                type: 'button',
                className: 'nw-motion-toggle' + (motion ? ' nw-motion-on' : ''),
                'aria-pressed': motion,
                title: t('切换便签动效', 'Toggle note motion'),
                onClick: toggleMotion,
              },
                h(SparkleGlyph, { size: 14 }),
                h('span', null, t('动效', 'Motion')),
                h('span', { className: 'nw-motion-dot', 'aria-hidden': 'true' }),
              ),
            ),
          ),
          h('form', {
            className: 'nw-compose' + toneClass(tone) + (dragging ? ' nw-compose-dragging' : ''),
            style: toneStyle(tone),
            key: 'compose',
            onSubmit: addNote,
            onPaste: onComposePaste,
            onDragOver: onComposeDragOver,
            onDragLeave: onComposeDragLeave,
            onDrop: onComposeDrop,
          },
            h('textarea', {
              ref: textareaRef,
              className: 'nw-compose-input',
              value: draft,
              rows: 3,
              maxLength: limits.maxNoteChars,
              placeholder: t('写下你的下一个灵感…', 'Write down your next idea…'),
              'aria-label': t('新便签内容', 'New note text'),
              onChange: function (event) { setDraft(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void addNote(event)
                }
              },
            }),
            composeFile
              ? h('div', { className: 'nw-compose-preview', key: 'attach' },
                  composePreview
                    ? h('img', { className: 'nw-preview-thumb', src: composePreview, alt: '' })
                    : h('span', { className: 'nw-preview-thumb', 'aria-hidden': 'true' }),
                  h('div', { className: 'nw-preview-meta' },
                    h('span', { className: 'nw-preview-name' }, composeFile.name || t('图片', 'Image')),
                    h('span', null, formatBytes(composeFile.size)),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'nw-iconbtn',
                    title: t('移除图片', 'Remove image'),
                    'aria-label': t('移除图片', 'Remove image'),
                    onClick: clearComposeAttachment,
                  }, h(CloseGlyph, { size: 14 })),
                )
              : null,
            h('div', { className: 'nw-compose-foot' },
              h('div', { className: 'nw-palette', role: 'group', 'aria-label': t('便签颜色', 'Note color') },
                TONES.map(function (definition) {
                  const name = toneName(t, definition)
                  return h('button', {
                    key: definition.key,
                    type: 'button',
                    className: 'nw-swatch nw-tone-' + definition.key + (tone === definition.key ? ' nw-swatch-selected' : ''),
                    'aria-label': name,
                    'aria-pressed': tone === definition.key,
                    title: name,
                    onClick: function () { setToneValue(definition.key) },
                  })
                }),
                h('button', {
                  key: 'custom',
                  type: 'button',
                  className: 'nw-swatch nw-swatch-custom' + (isCustomTone(tone) ? ' nw-swatch-selected' : ''),
                  style: isCustomTone(tone) ? { '--nw-custom': tone } : undefined,
                  'aria-label': t('自定义颜色', 'Custom color'),
                  'aria-pressed': isCustomTone(tone),
                  title: t('自定义颜色', 'Custom color'),
                  onClick: function () { if (colorInputRef.current) colorInputRef.current.click() },
                }),
                h('input', {
                  ref: colorInputRef,
                  type: 'color',
                  className: 'nw-file-input',
                  value: isCustomTone(tone) ? tone : '#f0c24b',
                  'aria-label': t('自定义颜色', 'Custom color'),
                  onChange: function (event) { setToneValue(event.target.value) },
                }),
              ),
              h('input', {
                className: 'nw-tag-input',
                type: 'text',
                value: draftTag,
                maxLength: limits.maxTagChars,
                placeholder: t('分类（可选）', 'Category (optional)'),
                'aria-label': t('分类（可选）', 'Category (optional)'),
                onChange: function (event) { setDraftTag(event.target.value) },
              }),
              h('div', { className: 'nw-link-field' },
                h(LinkGlyph, { size: 13 }),
                h('input', {
                  className: 'nw-link-input',
                  type: 'text',
                  value: draftLink,
                  maxLength: limits.maxLinkChars,
                  placeholder: t('链接（可选）', 'Link (optional)'),
                  'aria-label': t('链接（可选）', 'Link (optional)'),
                  onChange: function (event) { setDraftLink(event.target.value) },
                }),
              ),
              h('button', {
                type: 'button',
                className: 'nw-attach-btn',
                title: t('添加图片（也可粘贴或拖入）', 'Attach an image (or paste/drop one)'),
                'aria-label': t('添加图片', 'Attach image'),
                onClick: pickComposeImage,
              },
                h(ImageGlyph, { size: 15 }),
                h('span', null, t('图片', 'Image')),
              ),
              h('input', {
                ref: fileRef,
                type: 'file',
                className: 'nw-file-input',
                accept: IMAGE_TYPES.join(','),
                onChange: onComposeFilePicked,
              }),
              h('div', { className: 'nw-compose-actions' },
                h('span', { className: 'nw-kbd', 'aria-hidden': 'true' }, '⌘/Ctrl + Enter'),
                h('button', { type: 'submit', className: 'nw-add', disabled: !canAdd },
                  h(PlusGlyph, { size: 14 }),
                  h('span', null, pending === 'add' ? t('添加中…', 'Adding…') : t('添加到墙上', 'Add to the wall')),
                ),
              ),
            ),
          ),
          actionError
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert', key: 'action-error' },
                h('span', { className: 'nw-banner-text' }, actionError),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setActionError('') },
                }, t('关闭', 'Dismiss')),
              )
            : null,
          status === 'loading'
            ? h('div', { className: 'nw-loading', key: 'loading' },
                h('span', { className: 'nw-spinner', 'aria-hidden': 'true' }),
                h('span', null, t('正在读取便签…', 'Loading notes…')),
              )
            : null,
          status === 'error'
            ? h('div', { className: 'nw-banner nw-banner-error', role: 'alert', key: 'load-error' },
                h('span', { className: 'nw-banner-text' }, loadError),
                h('button', {
                  type: 'button',
                  className: 'nw-mini',
                  onClick: function () { setReloadKey(function (value) { return value + 1 }) },
                }, t('重试', 'Retry')),
              )
            : null,
          status === 'ready' && notes.length === 0 ? h(EmptyWall, { key: 'empty', t: t }) : null,
          status === 'ready' && notes.length > 0
            ? h('div', { className: 'nw-grid', key: 'grid' },
                notes.map(function (note) {
                  return h(NoteCard, {
                    key: note.id,
                    note: note,
                    now: now,
                    t: t,
                    locale: activeLocale,
                    limits: limits,
                    pending: pending,
                    editing: editing !== null && editing.id === note.id ? editing : null,
                    confirming: confirming === note.id,
                    onChangeEdit: setEditing,
                    onBeginEdit: beginEdit,
                    onCancelEdit: cancelEdit,
                    onSaveEdit: saveEdit,
                    onCancelDelete: function () { setConfirming(null) },
                    onDelete: removeNote,
                    onAskDelete: function () { setConfirming(note.id) },
                    onEditImageFile: attachEditImage,
                    onClearEditImage: clearEditImage,
                  })
                }),
              )
            : null,
          h('footer', { className: 'nw-page-foot', key: 'signature' },
            h('div', { className: 'nw-signature-wrap' },
              h('button', {
                type: 'button',
                className: 'nw-signature',
                'aria-label': t('关于作者', 'About the author'),
                'aria-haspopup': 'dialog',
                'aria-expanded': signatureOpen,
                'aria-controls': SIGNATURE_PANEL_ID,
                title: t('关于作者', 'About the author'),
                ref: signatureButtonRef,
                onClick: onSignatureClick,
              },
                h('span', { className: 'nw-signature-mark', 'aria-hidden': 'true' }),
                h('span', null, 'dream-office'),
              ),
              signatureOpen
                ? h('div', {
                    id: SIGNATURE_PANEL_ID,
                    role: 'dialog',
                    className: 'nw-signature-pop',
                    'aria-label': t('关于作者', 'About the author'),
                  },
                    h('p', { className: 'nw-signature-quote' }, t(SIGNATURE_QUOTE_ZH, SIGNATURE_QUOTE_EN)),
                    h('button', {
                      type: 'button',
                      className: 'nw-iconbtn nw-signature-close',
                      'aria-label': t('关闭', 'Close'),
                      title: t('关闭', 'Close'),
                      ref: signatureCloseRef,
                      onClick: closeSignature,
                    }, h(CloseGlyph, { size: 14 })),
                  )
                : null,
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h(NoteGlyph, { size: size })
    }

    function apply(ctx) {
      printSignatureConsole()
      function label() {
        return isZhLocale(ctx) ? '便签墙' : 'Note wall'
      }

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'note-wall',
          order: 30,
          label: label,
        }, PanelIcon)
      })

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'note-wall',
        }, function NoteWallMain(props) {
          return h(NoteWallPage, Object.assign({}, props, { ctx: ctx }))
        })
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})
