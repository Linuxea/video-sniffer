import { parseM3u8, type HlsPlaylist } from '../shared/m3u8'

/**
 * offscreen 下载策略（两级）：
 * 1. 直连 fetch —— 扩展持有 <all_urls> host 权限，可绕过 CORS
 * 2. 页面上下文 fetch —— 经 background 中继到 content script，
 *    带页面的 Cookie/Referer，解决签名 URL / 防盗链
 */

export class CanceledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CanceledError'
  }
}

export interface FetchedBytes {
  bytes: Uint8Array
  contentType?: string
}

export async function fetchText(url: string, tabId: number, signal: AbortSignal): Promise<string> {
  const { bytes } = await fetchBytes(url, tabId, signal)
  // m3u8 内容为 ASCII/UTF-8 文本
  return new TextDecoder('utf-8').decode(bytes)
}

export async function fetchBytes(url: string, tabId: number, signal: AbortSignal): Promise<FetchedBytes> {
  let directError: unknown
  try {
    const resp = await fetch(url, { credentials: 'include', redirect: 'follow', signal })
    if (resp.ok) {
      const buf = await resp.arrayBuffer()
      return { bytes: new Uint8Array(buf), contentType: resp.headers.get('content-type') ?? undefined }
    }
    directError = new Error(`HTTP ${resp.status}`)
    // 403/401 通常是防盗链，交给页面上下文重试
  } catch (e) {
    if (signal.aborted) throw new CanceledError()
    directError = e // CORS / 网络错误 → 页面上下文重试
  }

  const relayed = await relayPageFetch(url, tabId, signal)
  if (relayed) return relayed
  throw directError instanceof Error ? directError : new Error(String(directError))
}

async function relayPageFetch(url: string, tabId: number, signal: AbortSignal): Promise<FetchedBytes | null> {
  if (tabId < 0) return null
  if (signal.aborted) throw new CanceledError()
  try {
    const resp: any = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'PAGE_FETCH_RELAY',
      url,
      tabId,
    })
    if (resp?.ok && typeof resp.base64 === 'string') {
      return { bytes: b64ToBytes(resp.base64), contentType: resp.contentType }
    }
  } catch {
    /* 页面已关闭等情况 */
  }
  return null
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 拉取并解析 playlist（跟随 master → 最佳清晰度），给 popup 展示概要 */
export async function fetchAndParsePlaylist(
  url: string,
  _pageUrl: string,
  tabId: number,
): Promise<{
  type: 'master' | 'media'
  variants: { url: string; bandwidth?: number; resolution?: string; codecs?: string; name?: string }[]
  segmentCount: number
  totalDuration: number
  encrypted: boolean
  contentType?: string
}> {
  const ac = new AbortController()
  const text = await fetchText(url, tabId, ac.signal)
  let pl: HlsPlaylist
  try {
    pl = parseM3u8(text, url)
  } catch (e: any) {
    throw new Error(`m3u8 解析失败: ${e?.message ?? e}`)
  }
  if (pl.isMaster && pl.variants.length > 0) {
    return {
      type: 'master',
      variants: pl.variants.map((v) => ({
        url: v.url,
        bandwidth: v.bandwidth,
        resolution: v.resolution,
        codecs: v.codecs,
        name: v.name,
      })),
      segmentCount: 0,
      totalDuration: 0,
      encrypted: false,
    }
  }
  if (pl.segments.length === 0) throw new Error('playlist 中没有分片（可能是直播流或不受支持的格式）')
  return {
    type: 'media',
    variants: [],
    segmentCount: pl.segments.length,
    totalDuration: pl.totalDuration,
    encrypted: pl.encrypted,
  }
}
