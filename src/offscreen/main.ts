import { fetchAndParsePlaylist } from './fetcher'
import { runHlsJob, cancelJob } from './hls-job'
import type { DownloadJob, Settings } from '../shared/types'

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return
  ;(async () => {
    try {
      switch (msg.type) {
        case 'FETCH_PLAYLIST': {
          const info = await fetchAndParsePlaylist(msg.url, msg.pageUrl ?? '', msg.tabId ?? -1)
          sendResponse({ ok: true, info })
          break
        }
        case 'START_HLS_JOB': {
          // fire-and-forget：进度通过 JOB_PROGRESS 上报
          void runHlsJob(msg.job as DownloadJob, msg.settings as Settings)
          sendResponse({ ok: true })
          break
        }
        case 'CANCEL_JOB': {
          cancelJob(msg.jobId)
          sendResponse({ ok: true })
          break
        }
        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` })
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: e?.message ?? String(e) })
    }
  })()
  return true // 异步 sendResponse
})
