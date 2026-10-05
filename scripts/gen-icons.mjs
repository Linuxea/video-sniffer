/**
 * 零依赖扩展图标生成器：圆角渐变方块 + 白色播放三角。
 * 输出 public/icons/icon-{16,32,48,128}.png
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'icons')

// ------------------------------------------------------------ PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ------------------------------------------------------------ 绘制（4x 超采样）

const TOP = [0x34, 0xd3, 0x99] // emerald-400
const BOTTOM = [0x05, 0x96, 0x69] // emerald-600

/** 圆角矩形 SDF（归一化坐标），返回带符号距离：内部为负 */
function roundedRectDist(px, py) {
  const half = 0.5
  const r = 0.19
  const dx = Math.abs(px - 0.5) - (half - r)
  const dy = Math.abs(py - 0.5) - (half - r)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside
}

/** 点是否在播放三角内 */
function inTriangle(px, py) {
  const A = [0.4, 0.29]
  const B = [0.4, 0.71]
  const C = [0.7, 0.5]
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  const d1 = sign([px, py], A, B)
  const d2 = sign([px, py], B, C)
  const d3 = sign([px, py], C, A)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function draw(size) {
  const SS = 4 // 超采样倍数
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          const dist = roundedRectDist(px, py)
          const alpha = Math.max(0, Math.min(1, 0.5 - dist * size)) // 边缘 1px 抗锯齿
          const t = py
          let cr = TOP[0] + (BOTTOM[0] - TOP[0]) * t
          let cg = TOP[1] + (BOTTOM[1] - TOP[1]) * t
          let cb = TOP[2] + (BOTTOM[2] - TOP[2]) * t
          if (alpha > 0 && inTriangle(px, py)) {
            cr = 255
            cg = 255
            cb = 255
          }
          r += cr * alpha
          g += cg * alpha
          b += cb * alpha
          a += alpha
        }
      }
      const n = SS * SS
      pixels[(y * size + x) * 4] = Math.round(r / n)
      pixels[(y * size + x) * 4 + 1] = Math.round(g / n)
      pixels[(y * size + x) * 4 + 2] = Math.round(b / n)
      pixels[(y * size + x) * 4 + 3] = Math.round((a / n) * 255)
    }
  }
  return pixels
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, draw(size))
  const file = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, png)
  console.log(`✓ ${file} (${png.length} bytes)`)
}
