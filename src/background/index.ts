import { store, mergeDomItems } from './store'
import { jobManager } from './jobs'
import { ensureOffscreen } from './offscreen'
import {
  classifyUrl,
  contentTypeKind,
  hashUrl,
  sanitizeFilename,
  hostOf,
  baseNameFor,
  type PlaylistInfo,
} from '../shared/types'
import { getSettings } from '../shared/settings'

// ============================================================ 初始化

void store.restore()
void jobManager.restore().then(() => syncKeepaliveAlarm())

// ============================================================ 网络嗅探（观察模式，不阻塞）

const URL_FILTER = { urls: ['<all_urls>'] }

chrome.webRequest.onBeforeRequest.addListener(
  (details): chrome.webRequest.BlockingResponse | undefined => {
    // tabId < 0 的请求来自扩展自身（offscreen 下载等），忽略避免自我污染
    if (details.tabId < 0) return
    const c = classifyUrl(details.url)
    if (!c) return
    store.add(details.tabId, {
      id: `${details.tabId}:${hashUrl(details.url)}`,
      url: details.url,
      kind: c.kind,
      ext: c.ext,
      capturedAt: Date.now(),
      source: 'network',
      pageUrl: store.getMeta(details.tabId).url,
    })
    broadcastResources(details.tabId)
  },
  URL_FILTER,
)

// 用响应头补充 content-type / 大小；无扩展名但 content-type 是视频的 URL 也能被抓到
chrome.webRequest.onHeadersReceived.addListener(
  (details): chrome.webRequest.BlockingResponse | undefined => {
    if (details.tabId < 0) return
    const headers = details.responseHeaders ?? []
    const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
    const cl = headers.find((h) => h.name.toLowerCase() === 'content-length')?.value
    const size = cl ? Number(cl) : undefined
    const c = classifyUrl(details.url)
    const fromCt = contentTypeKind(ct)
    if (!c && !fromCt) return
    const updated = store.updateByUrl(details.tabId, details.url, {
      contentType: ct,
      sizeBytes: size,
      ...(c ? {} : { kind: fromCt!, ext: extForKind(fromCt!) }),
    })
    if (updated) broadcastResources(details.tabId)
  },
  URL_FILTER,
  ['responseHeaders'],
)

// 重定向跟随：把旧 URL 条目迁移到最终 URL
chrome.webRequest.onBeforeRedirect.addListener(
  (details): chrome.webRequest.BlockingResponse | undefined => {
    if (details.tabId < 0) return
    if (!classifyUrl(details.url) && !classifyUrl(details.redirectUrl)) return
    store.supersede(details.tabId, details.url, details.redirectUrl)
  },
  URL_FILTER,
)

// ============================================================ tab 生命周期

chrome.tabs.onRemoved.addListener((tabId) => {
  store.onTabRemoved(tabId)
})

// ============================================================ 资源广播（给 popup）

let lastResBcast = 0
let resBcastTimer: ReturnType<typeof setTimeout> | null = null

function broadcastResources(tabId: number, force = false) {
  const send = () => {
    lastResBcast = Date.now()
    chrome.runtime
      .sendMessage({ target: 'popup', type: 'RESOURCES_UPDATED', tabId, resources: store.listVisible(tabId) })
      .catch(() => {})
  }
  if (force) return send()
  const wait = Math.max(0, 500 - (Date.now() - lastResBcast))
  if (wait === 0) send()
  else {
    clearTimeout(resBcastTimer!)
    resBcastTimer = setTimeout(send, wait)
  }
}

// ============================================================ SW 保活（下载进行期间）

function syncKeepaliveAlarm() {
  if (jobManager.hasActive()) {
    chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }).catch(() => {})
  } else {
    chrome.alarms.clear('keepalive').catch(() => {})
  }
}
jobManager.onChanged(syncKeepaliveAlarm)
chrome.alarms.onAlarm.addListener(() => {
  // 空闹钟：仅用于唤醒 SW；被唤醒后模块顶层代码自动恢复监听器
})

// ============================================================ 消息路由

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return
  switch (msg.type) {
    case 'PAGE_CONTEXT': {
      // content script（顶层 frame）上报页面上下文；导航后清空旧资源
      const tabId = sender.tab?.id ?? -1
      if (tabId >= 0) {
        store.setPageContext(tabId, msg.pageUrl, msg.pageTitle ?? '')
        broadcastResources(tabId)
      }
      sendResponse({ ok: true })
      break
    }

    case 'DOM_MEDIA_FOUND': {
      const tabId = sender.tab?.id ?? -1
      if (tabId >= 0 && Array.isArray(msg.items)) {
        mergeDomItems(tabId, msg.items)
        broadcastResources(tabId)
      }
      sendResponse({ ok: true })
      break
    }

    case 'GET_RESOURCES': {
      sendResponse({ ok: true, resources: store.listVisible(msg.tabId) })
      break
    }

    case 'CLEAR_RESOURCES': {
      void store.clear(msg.tabId).then(() => broadcastResources(msg.tabId, true))
      sendResponse({ ok: true })
      break
    }

    case 'RESCAN': {
      // 让 content script 立刻重扫 DOM + performance entries
      chrome.tabs
        .sendMessage(msg.tabId, { target: 'content', type: 'RESCAN' })
        .then(() => sendResponse({ ok: true }))
        .catch((e: any) => sendResponse({ ok: false, error: e?.message ?? String(e) }))
      break
    }

    case 'INSPECT_HLS': {
      ;(async () => {
        try {
          const res = store.get(msg.tabId, msg.id)
          if (!res) throw new Error('资源不存在')
          await ensureOffscreen()
          const resp: any = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'FETCH_PLAYLIST',
            url: res.url,
            pageUrl: store.getMeta(msg.tabId).url,
            tabId: msg.tabId,
          })
          if (!resp?.ok) throw new Error(resp?.error ?? '解析 m3u8 失败')
          sendResponse({ ok: true, info: resp.info as PlaylistInfo })
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message ?? String(e) })
        }
      })()
      break
    }

    case 'START_DIRECT': {
      ;(async () => {
        try {
          const res = store.get(msg.tabId, msg.id)
          if (!res) throw new Error('资源不存在')
          const settings = await getSettings()
          const folder = settings.subfolder ? 'VideoSniffer/' : ''
          const filename = `${folder}${sanitizeFilename(
            baseNameFor(res, store.getMeta(msg.tabId).title),
          )}.${res.ext || 'mp4'}`
          const downloadId = await chrome.downloads.download({
            url: res.url,
            filename,
            conflictAction: 'uniquify',
            saveAs: false,
          })
          sendResponse({ ok: true, downloadId })
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message ?? String(e) })
        }
      })()
      break
    }

    case 'START_HLS': {
      ;(async () => {
        try {
          const res = store.get(msg.tabId, msg.id)
          if (!res) throw new Error('资源不存在')
          const meta = store.getMeta(msg.tabId)
          const settings = await getSettings()
          const job = {
            id: `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            tabId: msg.tabId,
            pageUrl: meta.url || res.pageUrl,
            title: sanitizeFilename(baseNameFor(res, meta.title), hostOf(res.url) || 'video'),
            url: res.url,
            mediaUrl: msg.variantUrl ?? res.url,
            variantLabel: msg.variantLabel,
            status: 'preparing' as const,
            totalSegments: 0,
            doneSegments: 0,
            totalBytes: 0,
            doneBytes: 0,
            startedAt: Date.now(),
          }
          await ensureOffscreen()
          const resp: any = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'START_HLS_JOB',
            job,
            settings,
          })
          if (!resp?.ok) throw new Error(resp?.error ?? '启动下载失败')
          jobManager.create(job)
          sendResponse({ ok: true, job })
        } catch (e: any) {
          sendResponse({ ok: false, error: e?.message ?? String(e) })
        }
      })()
      break
    }

    case 'GET_JOBS': {
      sendResponse({ ok: true, jobs: jobManager.list() })
      break
    }

    case 'CANCEL_JOB': {
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'CANCEL_JOB', jobId: msg.jobId })
        .catch(() => {})
      // offscreen 会回报 canceled；若 offscreen 已死则直接标记
      setTimeout(() => {
        const j = jobManager.jobs.get(msg.jobId)
        if (j && !['done', 'error', 'canceled'].includes(j.status)) {
          jobManager.update(msg.jobId, { status: 'canceled', endedAt: Date.now() })
        }
      }, 1500)
      sendResponse({ ok: true })
      break
    }

    // offscreen → background：分片级页面上下文 fetch 中继（带 cookie/referer）
    case 'PAGE_FETCH_RELAY': {
      chrome.tabs
        .sendMessage(msg.tabId, { target: 'content', type: 'PAGE_FETCH', url: msg.url })
        .then((resp: any) => sendResponse(resp ?? { ok: false, error: '页面无响应' }))
        .catch((e: any) => sendResponse({ ok: false, error: e?.message ?? String(e) }))
      break
    }

    // offscreen → background：任务进度/完成上报
    case 'JOB_PROGRESS': {
      jobManager.update(msg.jobId, msg.patch ?? {})
      sendResponse({ ok: true })
      break
    }

    default:
      return
  }
  return true // 异步 sendResponse
})

function extForKind(kind: string): string {
  switch (kind) {
    case 'hls':
      return 'm3u8'
    case 'dash':
      return 'mpd'
    default:
      return 'mp4'
  }
}
