import mux from 'mux.js'
import type { BlobPart } from '../shared/dom-types'

/**
 * MPEG-TS → fMP4 转封装（mux.js，纯 JS，体积远小于 ffmpeg.wasm）。
 * 逐分片 push + flush，data 事件给出 initSegment（首个）与 media data。
 */
export function transmuxTsToMp4(chunks: Uint8Array[]): BlobPart[] {
  const transmuxer = new (mux as any).mp4.Transmuxer()
  const out: Uint8Array[] = []
  let init: Uint8Array | null = null

  transmuxer.on('data', (segment: any) => {
    if (segment.initSegment?.length) {
      if (!init) init = new Uint8Array(segment.initSegment)
    }
    if (segment.data?.length) out.push(new Uint8Array(segment.data))
  })

  for (const c of chunks) {
    transmuxer.push(c)
    transmuxer.flush()
  }

  if (!init || out.length === 0) throw new Error('transmux 输出为空')
  return [init as BlobPart, ...out.map((c) => c as BlobPart)]
}
