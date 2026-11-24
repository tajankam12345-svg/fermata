// Paints the day's orders as a picture on the page's own dark ground, with the member's number and address
// running across it on a slant.
import { BIG, SMALL } from './glyphs.js'

const WIDE = 720, EDGE = 28, ROW = 44
const GROUND = [0x0d, 0x0e, 0x11], LIGHT = [0xf2, 0xf3, 0xf5]                  // a pixel is a step from the page's ground to near white
const SLANT = -24 * Math.PI / 180, PITCH = 58, FAINT = 0.1                     // the mark: its angle, the distance between its lines, its strength
const plain = (font, s) => [...String(s)].map(ch => font.of[ch] ? ch : '?')      // only the letters the font has
const span = (font, s) => plain(font, s).reduce((n, ch) => n + font.of[ch][0], 0)

function write(px, wide, high, font, s, x, y, shade) {
  for (const ch of plain(font, s)) {
    const [w, bits] = font.of[ch]
    for (let r = 0; r < font.high; r++) {
      const yy = y + r
      if (yy < 0 || yy >= high) continue
      for (let c = 0; c < w; c++) {
        const xx = x + c
        if (xx < 0 || xx >= wide) continue
        const a = parseInt(bits[r * w + c], 16) / 15
        if (a) { const k = yy * wide + xx; px[k] = px[k] + (shade - px[k]) * a }
      }
    }
    x += w
  }
}

// The owner's words end to end with no gap, line after line on a slant, each line shifted against the one before.
function mark(px, high, words) {
  const unit = plain(SMALL, words).join('') + ' ', mw = span(SMALL, unit), mh = SMALL.high
  const one = new Uint8Array(mw * mh)
  write(one, mw, mh, SMALL, unit, 0, 0, 255)
  const cos = Math.cos(SLANT), sin = Math.sin(SLANT), shift = Math.round(mw * 0.37)
  for (let y = 0; y < high; y++) {
    let u = y * sin, v = y * cos
    for (let x = 0; x < WIDE; x++, u += cos, v -= sin) {
      const line = Math.floor(v / PITCH), vv = v - line * PITCH
      if (vv >= mh - 1) continue
      let uu = (u + line * shift) % mw
      if (uu < 0) uu += mw
      const c = uu | 0, r = vv | 0, fc = uu - c, fr = vv - r, c2 = c + 1 === mw ? 0 : c + 1
      const a = (one[r * mw + c] * (1 - fc) + one[r * mw + c2] * fc) * (1 - fr) + (one[(r + 1) * mw + c] * (1 - fc) + one[(r + 1) * mw + c2] * fc) * fr
      if (a > 8) { const k = y * WIDE + x; px[k] = px[k] + (255 - px[k]) * (a / 255) * FAINT }
    }
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
  view.setUint32(0, WIDE); view.setUint32(4, high); head[8] = 8; head[9] = 3    // one byte a pixel, looked up in the colours below
  const colours = new Uint8Array(768)
  for (let k = 0; k < 256; k++) for (let c = 0; c < 3; c++) colours[k * 3 + c] = Math.round(GROUND[c] + (LIGHT[c] - GROUND[c]) * k / 255)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('PLTE', colours), chunk('IDAT', packed), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const commas = n => String(n).replace(/\B(?=(\d{3})+$)/g, ',')
const dollars = n => { const c = Math.round(n * 100); return commas(Math.floor(c / 100)) + '.' + String(c % 100).padStart(2, '0') }      // to the cent, as fractional orders are placed

// body: { buy: [[symbol, percent]], sell: [[symbol, percent, percent of the holding]], hold: [...] }; words: whose picture this is;
// base: an amount in dollars to show every share of, beside the percentage (0: percentages only)
export async function picture(title, body, words, base = 0) {
  const parts = [['살 종목', body.buy || []], ['팔 종목', body.sell || []], ['주문 뒤 보유', body.hold || []]].filter(p => p[1].length)
  const lines = parts.reduce((n, p) => n + 1 + Math.ceil(p[1].length / 2), 0)
  const high = EDGE * 2 + 52 + Math.max(lines, 3) * ROW
  const px = new Uint8Array(WIDE * high)
  mark(px, high, words)                                                          // under the letters, so they stay sharp
  write(px, WIDE, high, BIG, title, EDGE, EDGE, 250)
  if (base) { const per = '기준 금액 $' + commas(base); write(px, WIDE, high, SMALL, per, WIDE - EDGE - span(SMALL, per), EDGE + 10, 150) }
  let y = EDGE + 52
  if (!parts.length) write(px, WIDE, high, SMALL, '주문 없음', EDGE, y + 12, 150)
  for (const [name, rows] of parts) {
    write(px, WIDE, high, SMALL, name + '  ' + rows.length, EDGE, y + 16, 150)
    for (let x = EDGE; x < WIDE - EDGE; x++) px[(y + ROW - 6) * WIDE + x] = 44
    y += ROW
    rows.forEach(([symbol, percent, portion], k) => {
      const left = EDGE + (k % 2) * (WIDE / 2 - EDGE / 2), top = y + Math.floor(k / 2) * ROW
      const share = Number(percent).toFixed(1) + '%'
      write(px, WIDE, high, BIG, symbol, left, top + 4, 255)
      const right = left + WIDE / 2 - EDGE * 2
      if (portion) { const say = portion >= 100 ? '전량' : '보유분 ' + portion + '%'; return write(px, WIDE, high, SMALL, say, right - span(SMALL, say), top + 14, 215) }      // a sale: the part of what is held
      if (!base) return write(px, WIDE, high, BIG, share, right - span(BIG, share), top + 4, 185)
      const sum = dollars(base * percent / 100), font = span(BIG, sum) <= 125 ? BIG : SMALL
      write(px, WIDE, high, SMALL, share, right - 135 - span(SMALL, share), top + 14, 140)
      write(px, WIDE, high, font, sum, right - span(font, sum), top + (font === BIG ? 4 : 14), base * percent / 100 < 1 ? 110 : 215)      // under a dollar: too small to order
    })
    y += Math.ceil(rows.length / 2) * ROW
  }
  return png(px, high)
}
