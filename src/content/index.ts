/**
 * content script：
 * 1. 扫描 DOM 中的 video/source/embed/object，上报元信息（时长、分辨率）
 * 2. 扫描 performance resource entries（兜底：content script 注入前已发出的请求）
 * 3. 充当"页面上下文 fetch 代理"：offscreen 直连失败时经 background 中继，
 *    在页面自己的上下文里 fetch（带 Cookie/Referer，绕开 CORS）
 */

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|flv|mov|mkv|avi|ts|m4s|m3u8|mpd)(\?|#|$)/i
const isTop = window === window.top

function sendToBackground(payload: Record<string, unknown>) {
  chrome.runtime.sendMessage({ target: 'background', ...payload }).catch(() => {})
}

// ---------------------------------------------------------------- 扫描

interface DomItem {
  url: string
  duration?: number
  width?: number
  height?: number
  transferSize?: number
}

function scanDom() {
  const items: DomItem[] = []
  const seen = new Set<string>()

  const push = (rawUrl: string | null | undefined, el?: HTMLVideoElement) => {
    if (!rawUrl) return
    let url = rawUrl
    try {
      url = new URL(rawUrl, location.href).href
    } catch {
      return
    }
    if (!/^https?:/.test(url) && !url.startsWith('blob:')) return
    if (seen.has(url)) return
    seen.add(url)
    items.push({
      url,
      duration: el && isFinite(el.duration) ? el.duration : undefined,
      width: el?.videoWidth || undefined,
      height: el?.videoHeight || undefined,
    })
  }

  document.querySelectorAll('video').forEach((v) => {
    push(v.currentSrc || v.src, v)
    v.querySelectorAll('source').forEach((s) => push(s.src, v))
  })
  document.querySelectorAll('object[data], embed[src]').forEach((el) => {
    const u = (el as HTMLObjectElement).data || (el as HTMLEmbedElement).src
    if (u && VIDEO_EXT_RE.test(u)) push(u)
  })

  if (items.length) sendToBackground({ type: 'DOM_MEDIA_FOUND', items })
}

function scanPerf() {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const items: DomItem[] = entries
      .filter((e) => VIDEO_EXT_RE.test(e.name))
      .map((e) => ({ url: e.name, transferSize: e.transferSize || undefined }))
    if (items.length) sendToBackground({ type: 'DOM_MEDIA_FOUND', items })
  } catch {
    /* ignore */
  }
}

let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan() {
  if (scanTimer) return
  scanTimer = setTimeout(() => {
    scanTimer = null
    scanDom()
  }, 400)
}

// ---------------------------------------------------------------- 启动

// 顶层 frame 上报页面上下文（background 用来判断导航、生成文件名）
if (isTop) {
  sendToBackground({ type: 'PAGE_CONTEXT', pageUrl: location.href, pageTitle: document.title })
}

scanDom()
scanPerf()

// DOM 变化 / 视频元信息就绪时重扫
new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true })
document.addEventListener('loadedmetadata', scheduleScan, true)
setInterval(scheduleScan, 5000)

// ---------------------------------------------------------------- 消息

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (!msg || msg.target !== 'content') return
  if (msg.type === 'RESCAN') {
    scanDom()
    scanPerf()
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'PAGE_FETCH') {
    ;(async () => {
      try {
        const resp = await fetch(msg.url, { credentials: 'include' })
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status })
          return
        }
        const buf = await resp.arrayBuffer()
        sendResponse({
          ok: true,
          status: resp.status,
          contentType: resp.headers.get('content-type') ?? undefined,
          base64: bufToB64(buf),
        })
      } catch (e: any) {
        sendResponse({ ok: false, error: e?.message ?? String(e) })
      }
    })()
    return true // 异步 sendResponse
  }
})
