// Paints the day's orders as a grey picture with the member's own number and address all over it.
import { BIG, SMALL } from './glyphs.js'

const WIDE = 720, EDGE = 28, ROW = 44
const plain = s => String(s).replace(/[^\x20-\x7e]/g, '?')
const span = (font, s) => [...plain(s)].reduce((n, ch) => n + font.of[ch][0], 0)

function write(px, high, font, s, x, y, shade, strength = 1) {
  for (const ch of plain(s)) {
    const [w, bits] = font.of[ch]
    for (let r = 0; r < font.high; r++) {
      const yy = y + r
      if (yy < 0 || yy >= high) continue
      for (let c = 0; c < w; c++) {
        const xx = x + c
        if (xx < 0 || xx >= WIDE) continue
        const a = parseInt(bits[r * w + c], 16) / 15 * strength
        if (a) { const k = yy * WIDE + xx; px[k] = px[k] + (shade - px[k]) * a }
      }
    }
    x += w
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function chunk(kind, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let k = 0; k < 4; k++) out[4 + k] = kind.charCodeAt(k)
  out.set(data, 8)
  let c = 0xffffffff
  for (let k = 4; k < 8 + data.length; k++) c = CRC[(c ^ out[k]) & 255] ^ (c >>> 8)
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0)
  return out
}

async function png(px, high) {
  const raw = new Uint8Array((WIDE + 1) * high)
  for (let r = 0; r < high; r++) raw.set(px.subarray(r * WIDE, (r + 1) * WIDE), r * (WIDE + 1) + 1)
  const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const head = new Uint8Array(13), view = new DataView(head.buffer)
  view.setUint32(0, WIDE); view.setUint32(4, high); head[8] = 8                 // eight bits of grey, nothing else
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', packed), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// body: { buy: [[symbol, percent]], sell: [...], hold: [...] }; mark: the words that say whose picture this is
export async function picture(title, body, mark) {
  const parts = [['BUY', body.buy || []], ['SELL', body.sell || []], ['HOLD', body.hold || []]].filter(p => p[1].length)
  const lines = parts.reduce((n, p) => n + 1 + Math.ceil(p[1].length / 2), 0)
  const high = EDGE * 2 + 52 + Math.max(lines, 3) * ROW
  const px = new Uint8Array(WIDE * high).fill(18)
  write(px, high, BIG, title, EDGE, EDGE, 235)
  let y = EDGE + 52
  if (!parts.length) write(px, high, SMALL, 'NO ORDERS', EDGE, y + 12, 150)
  for (const [name, rows] of parts) {
    write(px, high, SMALL, name + '  ' + rows.length, EDGE, y + 16, 150)
    for (let x = EDGE; x < WIDE - EDGE; x++) px[(y + ROW - 6) * WIDE + x] = 48
    y += ROW
    rows.forEach(([symbol, percent], k) => {
      const left = EDGE + (k % 2) * (WIDE / 2 - EDGE / 2), top = y + Math.floor(k / 2) * ROW
      const share = Number(percent).toFixed(1) + '%'
      write(px, high, BIG, symbol, left, top + 4, 240)
      write(px, high, BIG, share, left + WIDE / 2 - EDGE * 2 - span(BIG, share), top + 4, 170)
    })
    y += Math.ceil(rows.length / 2) * ROW
  }
  const step = span(SMALL, mark) + 46                                            // the owner's mark, over everything, so no crop is clean
  for (let r = 0, yy = 6; yy < high; r++, yy += 34) for (let x = -((r * 97) % step); x < WIDE; x += step) write(px, high, SMALL, mark, x, yy, 255, 0.2)
  return png(px, high)
}
