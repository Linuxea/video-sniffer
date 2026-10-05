export type MediaKind =
  | 'direct' // mp4/webm/flv/mov/mkv 等可直接下载
  | 'hls' // m3u8
  | 'dash' // mpd，暂只检测
  | 'segment' // ts/m4s 分片
  | 'blob' // MSE blob: URL（无法直接下载，等待网络层抓到真实地址）

export interface MediaResource {
  id: string
  url: string
  kind: MediaKind
  ext: string
  contentType?: string
  sizeBytes?: number
  duration?: number
  width?: number
  height?: number
  capturedAt: number
  source: 'network' | 'dom' | 'perf'
  pageUrl: string
}

export interface HlsVariant {
  url: string
  bandwidth?: number
  resolution?: string
  codecs?: string
  name?: string
}

/** INSPECT_HLS 返回的 playlist 概要（给 popup 展示用） */
export interface PlaylistInfo {
  type: 'master' | 'media'
  variants: HlsVariant[]
  segmentCount: number
  totalDuration: number
  encrypted: boolean
  contentType?: string
}

export type JobStatus =
  | 'preparing'
  | 'downloading'
  | 'muxing'
  | 'saving'
  | 'done'
  | 'error'
  | 'canceled'

export interface DownloadJob {
  id: string
  tabId: number
  pageUrl: string
  title: string
  /** 嗅探时捕获的原始地址（可能是 master playlist） */
  url: string
  /** 实际下载的 media playlist（popup 选中某个清晰度后传入） */
  mediaUrl: string
  variantLabel?: string
  status: JobStatus
  totalSegments: number
  doneSegments: number
  totalBytes: number
  doneBytes: number
  filename?: string
  error?: string
  startedAt: number
  endedAt?: number
}

export interface Settings {
  /** 分片并发下载数 */
  concurrency: number
  /** 保存到 Downloads/VideoSniffer 子文件夹 */
  subfolder: boolean
  /** TS 分片转封装为 MP4（失败时回退保存 .ts） */
  preferMp4: boolean
}

// ---------------------------------------------------------------- helpers

const EXTS: Record<string, MediaKind> = {
  mp4: 'direct',
  m4v: 'direct',
  webm: 'direct',
  flv: 'direct',
  mov: 'direct',
  mkv: 'direct',
  avi: 'direct',
  m3u8: 'hls',
  mpd: 'dash',
  ts: 'segment',
  m4s: 'segment',
}

export function classifyUrl(rawUrl: string): { kind: MediaKind; ext: string } | null {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i)
    if (m) {
      const ext = m[1].toLowerCase()
      const kind = EXTS[ext]
      if (kind) return { kind, ext }
    }
    // 无扩展名但路径/查询里带 m3u8/mp4 的常见写法
    const q = (u.pathname + u.search).toLowerCase()
    if (/m3u8/.test(q)) return { kind: 'hls', ext: 'm3u8' }
    if (/mp4/.test(q)) return { kind: 'direct', ext: 'mp4' }
    return null
  } catch {
    return null
  }
}

export function contentTypeKind(ct?: string): MediaKind | null {
  if (!ct) return null
  const t = ct.split(';')[0].trim().toLowerCase()
  if (t === 'application/vnd.apple.mpegurl' || t === 'application/x-mpegurl' || t === 'audio/mpegurl') return 'hls'
  if (t === 'application/dash+xml') return 'dash'
  if (t.startsWith('video/')) return 'direct'
  return null
}

export function hashUrl(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function sanitizeFilename(name: string, fallback = 'video'): string {
  let n = (name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (n.length > 80) n = n.slice(0, 80).trim()
  return n || fallback
}

export function formatBytes(n?: number): string {
  if (!n || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatDuration(sec?: number): string {
  if (!sec || !isFinite(sec) || sec <= 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 根据资源生成建议文件名（不含扩展名） */
export function baseNameFor(res: { url: string; pageUrl?: string }, pageTitle?: string): string {
  const title = sanitizeFilename(pageTitle || '', '')
  if (title) return title
  const host = hostOf(res.url) || hostOf(res.pageUrl || '') || 'video'
  return host.replace(/^www\./, '')
}
