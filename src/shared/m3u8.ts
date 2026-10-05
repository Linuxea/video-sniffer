/**
 * 轻量 m3u8 解析器（无需依赖）。
 * 支持：master/media playlist、多清晰度、AES-128 KEY、fMP4 EXT-X-MAP init 段。
 * 不支持（忽略）：EXT-X-BYTERANGE 子区间、替代音频轨、直播窗口滚动。
 */

export interface HlsSegment {
  url: string
  duration: number
  /** AES-128 加密信息（继承自最近的 EXT-X-KEY） */
  keyMethod?: string
  keyUri?: string
  keyIv?: Uint8Array | null
}

export interface HlsVariant {
  url: string
  bandwidth?: number
  resolution?: string
  codecs?: string
  name?: string
}

export interface HlsPlaylist {
  isMaster: boolean
  variants: HlsVariant[]
  segments: HlsSegment[]
  /** fMP4 流的 init segment（EXT-X-MAP） */
  initUrl?: string
  mediaSequence: number
  targetDuration: number
  totalDuration: number
  encrypted: boolean
}

export function parseM3u8(text: string, playlistUrl: string): HlsPlaylist {
  const lines = text.split('\n').map((l) => l.trim())
  const out: HlsPlaylist = {
    isMaster: false,
    variants: [],
    segments: [],
    mediaSequence: 0,
    targetDuration: 0,
    totalDuration: 0,
    encrypted: false,
  }

  let pendingVariantAttrs: Record<string, string> | null = null
  let pendingDuration = 0
  let currentKey: { method: string; uri?: string; iv?: Uint8Array | null } | null = null

  const resolve = (u: string) => {
    try {
      return new URL(u, playlistUrl).href
    } catch {
      return u
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (!line.startsWith('#')) {
      // URI 行：master 的 variant 或 media 的 segment
      const url = resolve(line)
      if (pendingVariantAttrs) {
        out.isMaster = true
        out.variants.push({
          url,
          bandwidth: num(pendingVariantAttrs['BANDWIDTH']),
          resolution: pendingVariantAttrs['RESOLUTION'],
          codecs: pendingVariantAttrs['CODECS'],
          name: pendingVariantAttrs['NAME'],
        })
        pendingVariantAttrs = null
      } else if (pendingDuration >= 0) {
        // 注意：duration 为 0 的分片也合法，用 >= 0 判断"有 EXTINF 在等待"
        out.segments.push({
          url,
          duration: pendingDuration,
          keyMethod: currentKey?.method,
          keyUri: currentKey?.uri ? resolve(currentKey.uri) : undefined,
          keyIv: currentKey?.iv ?? null,
        })
        out.totalDuration += pendingDuration
        pendingDuration = -1
      }
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariantAttrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
    } else if (line.startsWith('#EXTINF:')) {
      const val = line.slice('#EXTINF:'.length).split(',')[0]
      pendingDuration = parseFloat(val) || 0
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length))
      const method = attrs['METHOD'] ?? 'NONE'
      if (method === 'NONE') {
        currentKey = null
      } else {
        currentKey = {
          method,
          uri: attrs['URI'],
          iv: attrs['IV'] ? parseHex16(attrs['IV']) : null,
        }
        if (method === 'AES-128') out.encrypted = true
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length))
      if (attrs['URI']) out.initUrl = resolve(attrs['URI'])
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      out.mediaSequence = parseInt(line.split(':')[1], 10) || 0
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      out.targetDuration = parseFloat(line.split(':')[1]) || 0
    }
    // 其余 tag 忽略
  }

  // 无 EXTINF 等待状态的裸 URI 不处理；master 判定兜底
  if (!out.isMaster && out.segments.length === 0 && out.variants.length > 0) out.isMaster = true
  return out
}

function num(v?: string): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return isFinite(n) ? n : undefined
}

/** 解析 HLS 属性串：METHOD=AES-128,URI="https://...",IV=0x1234... */
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < s.length) {
    const eq = s.indexOf('=', i)
    if (eq < 0) break
    const key = s.slice(i, eq).trim()
    let val = ''
    i = eq + 1
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1)
      val = s.slice(i + 1, end < 0 ? s.length : end)
      i = (end < 0 ? s.length : end) + 1
      if (s[i] === ',') i++
    } else {
      const end = s.indexOf(',', i)
      if (end < 0) {
        val = s.slice(i)
        i = s.length
      } else {
        val = s.slice(i, end)
        i = end + 1
      }
    }
    out[key] = val
  }
  return out
}

/** 解析 16 字节 hex IV（如 0x9c7e8f0a...） */
export function parseHex16(hex: string): Uint8Array {
  const h = hex.replace(/^0[xX]/, '').padStart(32, '0').slice(-32)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0
  }
  return out
}
