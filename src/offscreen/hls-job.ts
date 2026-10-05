import { fetchText, fetchBytes, CanceledError, type FetchedBytes } from './fetcher'
import { transmuxTsToMp4 } from './muxer'
import { parseM3u8, type HlsPlaylist } from '../shared/m3u8'
import type { DownloadJob, Settings } from '../shared/types'

interface JobState {
  ac: AbortController
  canceled: boolean
}

const active = new Map<string, JobState>()

export function cancelJob(jobId: string) {
  const s = active.get(jobId)
  if (s) {
    s.canceled = true
    s.ac.abort()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function report(jobId: string, patch: Partial<DownloadJob>) {
  chrome.runtime.sendMessage({ target: 'background', type: 'JOB_PROGRESS', jobId, patch }).catch(() => {})
}

// ============================================================ 主流程

export async function runHlsJob(job: DownloadJob, settings: Settings) {
  const state: JobState = { ac: new AbortController(), canceled: false }
  active.set(job.id, state)

  try {
    // 1. 解析 playlist（master 则挑用户选的/最高码率的 variant）
    report(job.id, { status: 'downloading' })
    let pl = await loadPlaylist(job.mediaUrl, job.tabId, state)

    // 2. init segment（fMP4 流）
    let initBytes: Uint8Array | null = null
    if (pl.initUrl) {
      initBytes = (await fetchBytes(pl.initUrl, job.tabId, state.ac.signal)).bytes
    }

    // 3. 并发下载分片
    report(job.id, { totalSegments: pl.segments.length })
    const chunks = await downloadSegments(job, pl, settings, state)

    // 4. 组装
    report(job.id, { status: 'muxing' })
    const { blob, ext } = await assemble(initBytes, chunks, pl, settings)

    // 5. 落盘
    report(job.id, { status: 'saving' })
    const filename = buildFilename(job, ext, settings)
    saveBlob(blob, filename)
    report(job.id, { status: 'done', filename, endedAt: Date.now() })
  } catch (e: any) {
    const canceled = state.canceled || e instanceof CanceledError || e?.name === 'AbortError'
    report(job.id, {
      status: canceled ? 'canceled' : 'error',
      error: canceled ? undefined : String(e?.message ?? e),
      endedAt: Date.now(),
    })
  } finally {
    active.delete(job.id)
  }
}

async function loadPlaylist(url: string, tabId: number, state: JobState): Promise<HlsPlaylist> {
  const text = await fetchText(url, tabId, state.ac.signal)
  let pl = parseM3u8(text, url)
  if (pl.isMaster && pl.variants.length > 0) {
    // 挑带宽最高的 variant（popup 已让用户选过一次，这里是兜底）
    const best = [...pl.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
    const vText = await fetchText(best.url, tabId, state.ac.signal)
    pl = parseM3u8(vText, best.url)
  }
  if (pl.segments.length === 0) throw new Error('playlist 中没有分片（可能是直播流）')
  if (pl.segments.some((s) => s.keyMethod && s.keyMethod !== 'AES-128')) {
    throw new Error(`不支持的加密方式: ${pl.segments[0].keyMethod}（可能是 DRM 保护内容）`)
  }
  return pl
}

// ============================================================ 分片下载

async function downloadSegments(
  job: DownloadJob,
  pl: HlsPlaylist,
  settings: Settings,
  state: JobState,
): Promise<Uint8Array[]> {
  const parts: (Uint8Array | null)[] = new Array(pl.segments.length).fill(null)
  const keyCache = new Map<string, CryptoKey>()
  let next = 0
  let done = 0
  let doneBytes = 0

  const concurrency = Math.max(1, Math.min(16, settings.concurrency ?? 6))
  const total = pl.segments.length

  const worker = async () => {
    while (true) {
      if (state.canceled) throw new CanceledError()
      const i = next++
      if (i >= total) return
      const seg = pl.segments[i]

      for (let attempt = 0; ; attempt++) {
        try {
          let { bytes } = await fetchBytes(seg.url, job.tabId, state.ac.signal)
          if (seg.keyUri && seg.keyMethod === 'AES-128') {
            const key = await getAesKey(seg.keyUri, keyCache, job, state)
            const iv = seg.keyIv ?? seqIv(pl.mediaSequence + i)
            bytes = await aesDecrypt(bytes, key, iv)
          }
          parts[i] = bytes
          done++
          doneBytes += bytes.length
          report(job.id, { doneSegments: done, doneBytes, totalBytes: doneBytes, status: 'downloading' })
          break
        } catch (e: any) {
          if (state.canceled || e instanceof CanceledError || e?.name === 'AbortError') throw new CanceledError()
          if (attempt >= 3) throw new Error(`分片 ${i + 1}/${total} 下载失败: ${e?.message ?? e}`)
          await sleep(400 * (attempt + 1))
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))

  if (parts.some((p) => p == null)) throw new Error('存在缺失分片')
  return parts as Uint8Array[]
}

async function getAesKey(
  uri: string,
  cache: Map<string, CryptoKey>,
  job: DownloadJob,
  state: JobState,
): Promise<CryptoKey> {
  const cached = cache.get(uri)
  if (cached) return cached
  const { bytes } = await fetchBytes(uri, job.tabId, state.ac.signal)
  const key = await crypto.subtle.importKey('raw', bytes as unknown as BufferSource, { name: 'AES-CBC' }, false, [
    'decrypt',
  ])
  cache.set(uri, key)
  return key
}

async function aesDecrypt(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as unknown as BufferSource },
    key,
    data as unknown as BufferSource,
  )
  return new Uint8Array(buf)
}

/** HLS 规范：未显式给 IV 时，用分片的 media sequence number 大端 16 字节 */
function seqIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16)
  new DataView(iv.buffer).setUint32(12, seq >>> 0)
  return iv
}

// ============================================================ 组装与保存

async function assemble(
  initBytes: Uint8Array | null,
  chunks: Uint8Array[],
  _pl: HlsPlaylist,
  settings: Settings,
): Promise<{ blob: Blob; ext: string }> {
  // fMP4 分片：init + 分片顺序拼接即为合法 MP4
  if (initBytes) {
    const blob = new Blob([initBytes as unknown as BlobPart, ...chunks.map((c) => c as unknown as BlobPart)], {
      type: 'video/mp4',
    })
    return { blob, ext: 'mp4' }
  }
  // TS 分片：转封装 MP4；失败则回退保存 .ts
  if (settings.preferMp4) {
    try {
      const mp4Parts = transmuxTsToMp4(chunks)
      return { blob: new Blob(mp4Parts, { type: 'video/mp4' }), ext: 'mp4' }
    } catch (e) {
      console.warn('[VideoSniffer] transmux 失败，回退保存 .ts', e)
    }
  }
  return { blob: new Blob(chunks.map((c) => c as unknown as BlobPart), { type: 'video/mp2t' }), ext: 'ts' }
}

function buildFilename(job: DownloadJob, ext: string, settings: Settings): string {
  const folder = settings.subfolder ? 'VideoSniffer/' : ''
  const label = job.variantLabel ? `-${sanitizeSeg(job.variantLabel)}` : ''
  return `${folder}${job.title}${label}.${ext}`
}

function sanitizeSeg(s: string): string {
  return (s || '').replace(/[^a-zA-Z0-9x×pP_-]/g, '')
}

/** offscreen 内触发浏览器下载（anchor click，绕开 chrome.downloads 对 blob 的上下文限制） */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 大文件写入磁盘需要时间，延迟回收
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000)
}
