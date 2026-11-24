// Serves the page from public/, keeps the launch list, the member accounts, their subscriptions and the day's orders.
import { picture } from './draw.js'

const TABLES = [
  'CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, joined TEXT NOT NULL, place TEXT)',
  'CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, email TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, joined TEXT NOT NULL, code TEXT UNIQUE NOT NULL, invited_by INTEGER, news INTEGER NOT NULL DEFAULT 0, place TEXT)',
  'CREATE TABLE IF NOT EXISTS pending (token TEXT PRIMARY KEY, kind TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, made INTEGER NOT NULL, invited_by INTEGER, news INTEGER NOT NULL DEFAULT 0, place TEXT, checks INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, member INTEGER NOT NULL, device TEXT NOT NULL, made INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS devices (member INTEGER NOT NULL, device TEXT NOT NULL, month TEXT NOT NULL, PRIMARY KEY (member, device, month))',
  'CREATE TABLE IF NOT EXISTS tries (key TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS spent (mark TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS subs (member INTEGER PRIMARY KEY, plan TEXT NOT NULL, period TEXT NOT NULL, started INTEGER NOT NULL, since INTEGER NOT NULL, ends INTEGER NOT NULL, paid INTEGER NOT NULL, state TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, member INTEGER NOT NULL, plan TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, coupon INTEGER, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, member INTEGER NOT NULL, why TEXT NOT NULL, made INTEGER NOT NULL, used INTEGER)',
  'CREATE TABLE IF NOT EXISTS rewards (invitee INTEGER PRIMARY KEY, made INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS feed (day TEXT NOT NULL, model TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (day, model))',
  'CREATE TABLE IF NOT EXISTS oaths (member INTEGER PRIMARY KEY, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS views (member INTEGER NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, device TEXT, at INTEGER NOT NULL)',
]
const OCTOMO = 'https://api.octoverse.kr/octomo/v1/public/message/exists', TO = '16663538'
const DEVICES = 3                 // devices one account may sign in from in a calendar month
const WAIT = 10                   // minutes a text may take to arrive
const CHECKS = 8                  // lookups one sign-up may spend (the lookup service counts every call)
const STAY = 30 * 86400           // seconds a sign-in lasts
const PRICE = { all: { month: 19900, year: 199000 } }      // one plan
const FIRST = 9900                // an account's first month, once for a phone number
const SEES = { all: ['LVX-B01', 'LVX-WH1', 'LVX-061', 'LVX-P32'], lyric: ['LVX-061'] }      // lyric: not sold any more
const NAMES = { 'LVX-B01': 'Ode 2.2', 'LVX-WH1': 'Ode Encore 2.2', 'LVX-061': 'Lyric 2.2', 'LVX-P32': 'Rhapsody 2.2' }
const OFF = 0.2                   // what a coupon takes off one monthly payment
const DAY = 86400e3
const RIPE = 7 * DAY              // how long an invited friend's subscription must last before the coupons are handed out
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PHONE = /^010\d{8}$/

const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
const random = n => hex(crypto.getRandomValues(new Uint8Array(n)))
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const digits = n => [...crypto.getRandomValues(new Uint32Array(n))].map(x => x % 10).join('')
const letters = n => [...crypto.getRandomValues(new Uint32Array(n))].map(x => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join('')
const month = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7)          // Korean time
const mask = p => p.slice(0, 3) + '-****-' + p.slice(7)

async function lock(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256))
}

function cookies(request) {
  const out = {}
  for (const part of (request.headers.get('cookie') || '').split(';')) { const k = part.indexOf('='); if (k > 0) out[part.slice(0, k).trim()] = part.slice(k + 1).trim() }
  return out
}
const bake = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`

function reply(body, status = 200, set = []) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  for (const c of set) headers.append('set-cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}

// More than `most` tries under one key within `minutes`: refuse.
async function crowded(db, key, most, minutes) {
  const now = Date.now()
  const row = await db.prepare('SELECT COUNT(*) AS n FROM tries WHERE key = ? AND at > ?').bind(key, now - minutes * 60e3).first()
  if (row.n >= most) return true
  await db.prepare('INSERT INTO tries (key, at) VALUES (?, ?)').bind(key, now).run()
  return false
}

// Did this phone text these words to the lookup number within the last minutes?
async function texted(env, phone, text) {
  if (env.OCTOMO_TEST === '1') return true                                       // local runs only: never set on the deployed worker
  const r = await fetch(OCTOMO, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Octomo ' + env.OCTOMO_KEY }, body: JSON.stringify({ mobileNum: phone, text, withinMinutes: WAIT }) })
  if (!r.ok) throw new Error('lookup ' + r.status)
  return (await r.json()).exists === true
}

async function who(db, request) {
  const token = cookies(request).fs
  if (!token) return null
  const row = await db.prepare('SELECT m.* FROM sessions s JOIN members m ON m.id = s.member WHERE s.token = ? AND s.made > ?').bind(await sha(token), Date.now() - STAY * 1000).first()
  return row || null
}

const day = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10)
const before = env => !env.LAUNCH || Date.now() < Date.parse(env.LAUNCH)        // subscriptions are not open yet

// The day's orders go up at eight in the morning in Korea, and a service day runs from one eight o'clock to the next.
const EIGHT = 3600e3                                                            // eight in Korea is an hour before midnight UTC
const eight = t => Math.floor((t + EIGHT) / DAY) * DAY - EIGHT                 // the last eight o'clock at or before t
const shown = () => new Date(eight(Date.now()) + 9 * 3600e3).toISOString().slice(0, 10)      // the day whose orders are out
// Paid before eight in the evening: the subscription starts with that day's eight o'clock in the morning. Paid later: with the next day's.
function opens(at) {
  const k = new Date(at + 9 * 3600e3), start = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - EIGHT
  return k.getUTCHours() >= 20 ? start + DAY : start
}
const coupon = (db, member) => db.prepare("SELECT id FROM coupons WHERE member = ? AND used IS NULL AND why != 'early'").bind(member).first()      // 'early': the coupons once given for joining before the launch, replaced by the first month's price
const due = (plan, period, off, first) => period === 'gift' ? 0 : period === 'month' && first ? FIRST : period === 'month' && off ? Math.round((PRICE[plan] || PRICE.all).month * (1 - OFF)) : (PRICE[plan] || PRICE.all)[period]
// The first month's price: for an account that has never paid, whose number has not left after paying within a year.
async function fresh(db, member, at = Date.now()) {
  if (await db.prepare('SELECT 1 FROM payments WHERE member = ?').bind(member).first()) return false
  const m = await db.prepare('SELECT phone FROM members WHERE id = ?').bind(member).first()
  return !!m && !await db.prepare('SELECT 1 FROM spent WHERE mark = ? AND at > ?').bind(await sha('first:' + m.phone), at - 365 * DAY).first()
}
const live = (db, member) => db.prepare("SELECT * FROM subs WHERE member = ? AND state = 'on' AND ends > ?").bind(member, Date.now()).first()      // paid for; it may not have started yet

// One coupon for an account, ever: a member who has had one, spent or not, gets nothing more.
async function grant(db, member, why, at) {
  if (await db.prepare('SELECT 1 FROM coupons WHERE member = ?').bind(member).first()) return
  const m = await db.prepare('SELECT phone FROM members WHERE id = ?').bind(member).first()      // a number that left with a coupon does not earn another by joining again
  if (!m || await db.prepare('SELECT 1 FROM spent WHERE mark = ? AND at > ?').bind(await sha('coupon:' + m.phone), at - 365 * DAY).first()) return
  await db.prepare('INSERT INTO coupons (member, why, made) VALUES (?, ?, ?)').bind(member, why, at).run()
}

// An invited friend whose subscription has lasted a week earns a coupon for both, once.
async function ripen(db, member, at = Date.now()) {
  const ready = await db.prepare("SELECT m.id, m.invited_by FROM members m JOIN subs s ON s.member = m.id WHERE (m.id = ? OR m.invited_by = ?) AND m.invited_by IS NOT NULL AND s.state = 'on' AND s.ends > ? AND s.since <= ? AND NOT EXISTS (SELECT 1 FROM rewards r WHERE r.invitee = m.id)").bind(member, member, at, at - RIPE).all()
  for (const row of ready.results) {
    const made = await db.prepare('INSERT OR IGNORE INTO rewards (invitee, made) VALUES (?, ?)').bind(row.id, at).run()
    if (!made.meta.changes) continue
    await grant(db, row.id, 'invited', at); await grant(db, row.invited_by, 'inviter', at)
  }
}

// Every payment comes through here, whoever takes the money: the amount, the coupon spent, the days bought.
async function pay(db, member, plan, period, at = Date.now()) {
  if (!PRICE[plan]?.[period]) throw new Error('plan')
  const first = period === 'month' && await fresh(db, member, at)
  const held = period === 'month' && !first ? await coupon(db, member) : null, amount = due(plan, period, held, first)      // the coupon waits for a month at the full price
  const long = (period === 'year' ? 365 : 30) * DAY, had = await db.prepare('SELECT * FROM subs WHERE member = ?').bind(member).first()
  const going = had && had.state === 'on' && had.ends > at
  await db.batch([
    db.prepare('INSERT INTO payments (member, plan, period, amount, coupon, at) VALUES (?, ?, ?, ?, ?, ?)').bind(member, plan, period, amount, held?.id ?? null, at),
    ...(held ? [db.prepare('UPDATE coupons SET used = ? WHERE id = ?').bind(at, held.id)] : []),
    db.prepare("INSERT INTO subs (member, plan, period, started, since, ends, paid, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'on') ON CONFLICT (member) DO UPDATE SET plan = excluded.plan, period = excluded.period, started = excluded.started, since = excluded.since, ends = excluded.ends, paid = excluded.paid, state = 'on'")
      .bind(member, plan, period, going ? had.ends : opens(at), going ? had.since : opens(at), (going ? had.ends : opens(at)) + long, amount),
  ])
  return amount
}

// Leaving: the unused days come back. A day is used once its eight o'clock has passed, so leaving before the first one returns everything.
// A year bought at the yearly price is charged the monthly price for the days used.
async function leave(db, member, at = Date.now()) {
  const s = await db.prepare("SELECT * FROM subs WHERE member = ? AND state = 'on'").bind(member).first()
  if (!s || s.ends <= at) return 0
  const all = Math.round((s.ends - s.started) / DAY), used = at < s.started ? 0 : Math.min(all, Math.floor((at - s.started) / DAY) + 1)
  const back = s.period === 'year' ? Math.max(0, s.paid - Math.round((PRICE[s.plan] || PRICE.all).month * 12 * used / 365)) : Math.max(0, Math.round(s.paid * (all - used) / all))
  await db.prepare("UPDATE subs SET state = 'off', ends = ? WHERE member = ?").bind(at, member).run()
  return back
}

async function card(db, m, env) {
  await ripen(db, m.id)
  const invited = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE invited_by = ?').bind(m.id).first()
  const s = await live(db, m.id), held = !!await coupon(db, m.id)
  return { early: before(env), first: await fresh(db, m.id) ? FIRST : 0, month: PRICE.all.month, phone: mask(m.phone), email: m.email, code: m.code, invited: invited.n, coupon: held, off: OFF, sub: s ? { plan: s.plan, period: s.period, from: s.since > Date.now() ? day(s.since) : null, ends: day(s.ends), next: due(s.plan, s.period, held) } : null, joined: new Date(Date.parse(m.joined) + 9 * 3600e3).toISOString().slice(0, 10) }
}

// Sign this device in and every other device out. Null when the month's devices are used up.
async function enter(db, request, member) {
  const had = cookies(request).fd, device = /^[0-9a-f]{32}$/.test(had || '') ? had : random(16), now = month()
  const seen = await db.prepare('SELECT device FROM devices WHERE member = ? AND month = ?').bind(member, now).all()
  const known = seen.results.some(r => r.device === device)
  if (!known && seen.results.length >= DEVICES) return null
  if (!known) await db.prepare('INSERT INTO devices (member, device, month) VALUES (?, ?, ?)').bind(member, device, now).run()
  const token = random(32)
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE member = ?').bind(member),
    db.prepare('INSERT INTO sessions (token, member, device, made) VALUES (?, ?, ?, ?)').bind(await sha(token), member, device, Date.now()),
  ])
  return [bake('fs', token, STAY), bake('fd', device, 365 * 86400)]
}

async function waitlist(db, got) {
  const email = String(got?.email || '').trim().toLowerCase()
  if (got?.site) return reply({ ok: true })                                      // the hidden field: filled only by scripts
  if (email.length > 254 || !MAIL.test(email)) return reply({ ok: false, why: 'email' }, 400)
  await db.prepare('INSERT OR IGNORE INTO waitlist (email, joined, place) VALUES (?, ?, ?)').bind(email, new Date().toISOString(), String(got?.where || '').slice(0, 20)).run()
  return reply({ ok: true })
}

// Step one of joining or of a new password: remember what was asked and hand out the words to text.
async function begin(env, db, got, kind) {
  if (!env.OCTOMO_KEY && env.OCTOMO_TEST !== '1') return reply({ ok: false, why: 'closed' }, 503)
  if (got?.site) return reply({ ok: false, why: 'phone' }, 400)
  const phone = String(got?.phone || '').replace(/\D/g, ''), email = String(got?.email || '').trim().toLowerCase(), password = String(got?.password || '')
  if (!PHONE.test(phone)) return reply({ ok: false, why: 'phone' }, 400)
  if (password.length < 9 || password.length > 100 || !/[A-Za-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) return reply({ ok: false, why: 'password' }, 400)      // letters, digits and a sign, nine or more
  const member = await db.prepare('SELECT id FROM members WHERE phone = ?').bind(phone).first()
  let invited = null
  if (kind === 'join') {
    if (email.length > 254 || !MAIL.test(email)) return reply({ ok: false, why: 'email' }, 400)
    if (got?.agree !== true) return reply({ ok: false, why: 'agree' }, 400)
    if (member) return reply({ ok: false, why: 'taken' }, 409)
    const from = String(got?.ref || '').toUpperCase().slice(0, 8)
    if (from) invited = (await db.prepare('SELECT id FROM members WHERE code = ?').bind(from).first())?.id ?? null
  } else if (!member) return reply({ ok: false, why: 'unknown' }, 404)
  if (await crowded(db, 'begin:' + phone, 5, 60)) return reply({ ok: false, why: 'often' }, 429)
  const token = random(24), salt = random(16), text = digits(6)
  await db.batch([
    db.prepare('DELETE FROM pending WHERE made < ?').bind(Date.now() - 3600e3),
    db.prepare('DELETE FROM tries WHERE at < ?').bind(Date.now() - 86400e3),
    db.prepare('INSERT INTO pending (token, kind, phone, email, salt, hash, text, made, invited_by, news, place) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(token, kind, phone, email, salt, await lock(password, salt), text, Date.now(), invited, got?.news === true ? 1 : 0, String(got?.where || '').slice(0, 20)),
  ])
  let qr = null                                                                  // for a visitor at a desk: a picture the phone reads to open the text, written
  if (env.OCTOMO_KEY) {
    try {
      const r = await fetch(OCTOMO.replace('/exists', '/qr-code'), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Octomo ' + env.OCTOMO_KEY }, body: JSON.stringify({ text, width: 320 }) })
      if (r.ok) qr = (await r.json()).qrCode || null
    } catch (e) {}
  }
  return reply({ ok: true, token, text, to: TO, minutes: WAIT, qr })
}

// Step two: the text has been sent, so look it up and finish.
async function finish(env, db, request, got) {
  const p = await db.prepare('SELECT * FROM pending WHERE token = ? AND made > ?').bind(String(got?.token || ''), Date.now() - WAIT * 60e3).first()
  if (!p) return reply({ ok: false, why: 'late' }, 410)
  if (p.checks >= CHECKS) return reply({ ok: false, why: 'late' }, 410)
  await db.prepare('UPDATE pending SET checks = checks + 1 WHERE token = ?').bind(p.token).run()
  if (!await texted(env, p.phone, p.text)) return reply({ ok: true, done: false })
  let id
  if (p.kind === 'join') {
    for (let k = 0; k < 5 && id == null; k++) {
      const made = await db.prepare('INSERT OR IGNORE INTO members (phone, email, salt, hash, joined, code, invited_by, news, place) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(p.phone, p.email, p.salt, p.hash, new Date().toISOString(), letters(6), p.invited_by, p.news, p.place).run()
      if (made.meta.changes) id = made.meta.last_row_id
      else if (await db.prepare('SELECT id FROM members WHERE phone = ?').bind(p.phone).first()) return reply({ ok: false, why: 'taken' }, 409)
    }
    if (id == null) return reply({ ok: false }, 500)
  } else {
    id = (await db.prepare('SELECT id FROM members WHERE phone = ?').bind(p.phone).first()).id
    await db.prepare('UPDATE members SET salt = ?, hash = ? WHERE id = ?').bind(p.salt, p.hash, id).run()
  }
  await db.prepare('DELETE FROM pending WHERE token = ?').bind(p.token).run()
  const set = await enter(db, request, id)
  if (!set) return reply({ ok: true, done: true, why: 'devices' })              // the password is changed; this device cannot come in this month
  return reply({ ok: true, done: true, me: await card(db, await db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first(), env) }, 200, set)
}

async function login(env, db, request, got) {
  const phone = String(got?.phone || '').replace(/\D/g, ''), password = String(got?.password || '')
  if (!PHONE.test(phone) || !password) return reply({ ok: false, why: 'wrong' }, 400)
  if (await crowded(db, 'login:' + phone, 10, 15)) return reply({ ok: false, why: 'often' }, 429)
  const m = await db.prepare('SELECT * FROM members WHERE phone = ?').bind(phone).first()
  if (!m || await lock(password.slice(0, 100), m.salt) !== m.hash) return reply({ ok: false, why: 'wrong' }, 401)
  const set = await enter(db, request, m.id)
  if (!set) return reply({ ok: false, why: 'devices' }, 403)
  return reply({ ok: true, me: await card(db, m, env) }, 200, set)
}

// Leaving for good, from the account page, with the password once more.
async function quit(db, request, got) {
  const m = await who(db, request)
  if (!m) return reply({ ok: false, why: 'login' }, 401)
  if (await crowded(db, 'quit:' + m.id, 5, 15)) return reply({ ok: false, why: 'often' }, 429)
  if (await lock(String(got?.password || '').slice(0, 100), m.salt) !== m.hash) return reply({ ok: false, why: 'wrong' }, 401)
  const s = await live(db, m.id)
  if (s && s.paid > 0) return reply({ ok: false, why: 'sub' }, 409)              // a paid subscription is ended first, so its refund is settled
  const had = await db.prepare('SELECT 1 FROM coupons WHERE member = ?').bind(m.id).first(), paid = await db.prepare('SELECT 1 FROM payments WHERE member = ?').bind(m.id).first()
  await db.batch([
    ...(had ? [db.prepare('INSERT INTO spent (mark, at) VALUES (?, ?) ON CONFLICT (mark) DO UPDATE SET at = excluded.at').bind(await sha('coupon:' + m.phone), Date.now())] : []),
    ...(paid ? [db.prepare('INSERT INTO spent (mark, at) VALUES (?, ?) ON CONFLICT (mark) DO UPDATE SET at = excluded.at').bind(await sha('first:' + m.phone), Date.now())] : []),
    db.prepare('DELETE FROM spent WHERE at < ?').bind(Date.now() - 365 * DAY),
    ...['sessions', 'devices', 'coupons', 'oaths', 'subs', 'views'].map(t => db.prepare(`DELETE FROM ${t} WHERE member = ?`).bind(m.id)),
    db.prepare('DELETE FROM pending WHERE phone = ?').bind(m.phone),
    db.prepare('DELETE FROM members WHERE id = ?').bind(m.id),
  ])
  return reply({ ok: true }, 200, [bake('fs', '', 0)])
}

// What a subscriber may open today.
async function orders(db, request, url, kind) {
  const m = await who(db, request)
  if (!m) return reply({ ok: false, why: 'login' }, 401)
  const s = await live(db, m.id)
  if (!s || s.since > Date.now()) return reply({ ok: false, why: 'plan', from: s ? day(s.since) : null }, 402)
  const sworn = !!await db.prepare('SELECT 1 FROM oaths WHERE member = ?').bind(m.id).first()
  const last = await db.prepare('SELECT MAX(day) AS day FROM feed WHERE day <= ?').bind(shown()).first()      // nothing shows before its eight o'clock
  const rows = last.day ? (await db.prepare('SELECT model FROM feed WHERE day = ?').bind(last.day).all()).results.map(r => r.model) : []
  const models = SEES[s.plan].filter(n => rows.includes(n))
  if (kind === 'list') return reply({ ok: true, day: last.day, models: models.map(n => ({ id: n, name: NAMES[n] })), sworn, mark: mask(m.phone) })
  if (!sworn) return reply({ ok: false, why: 'oath' }, 403)
  const model = url.searchParams.get('model')
  if (!models.includes(model)) return reply({ ok: false }, 404)
  const row = await db.prepare('SELECT body FROM feed WHERE day = ? AND model = ?').bind(last.day, model).first()
  await db.prepare('INSERT INTO views (member, day, model, device, at) VALUES (?, ?, ?, ?, ?)').bind(m.id, last.day, model, cookies(request).fd || null, Date.now()).run()
  const mark = m.phone.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3') + ' ' + m.email
  const base = Math.min(Math.max(Math.floor(Number(request.headers.get('x-base')) || 0), 0), 1e9)       // dollars; used for this picture only, kept nowhere
  return new Response(await picture(NAMES[model] + '   ' + last.day, JSON.parse(row.body), mark, base), { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' } })
}

// The day's orders arrive from the machine that makes them, with its own key.
async function feed(env, db, request) {
  if (!env.FEED_KEY) return reply({ ok: false }, 503)
  if (request.headers.get('authorization') !== 'Feed ' + env.FEED_KEY) return reply({ ok: false }, 401)
  const got = await request.json().catch(() => null)
  const list = v => Array.isArray(v) && v.length <= 200 && v.every(r => Array.isArray(r) && /^[A-Z0-9.\-]{1,10}$/.test(r[0]) && Number.isFinite(r[1]))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(got?.day || '') || !NAMES[got?.model] || !['buy', 'sell', 'hold'].every(k => list(got[k] || []))) return reply({ ok: false }, 400)
  await db.batch([
    db.prepare('INSERT INTO feed (day, model, body) VALUES (?, ?, ?) ON CONFLICT (day, model) DO UPDATE SET body = excluded.body').bind(got.day, got.model, JSON.stringify({ buy: got.buy || [], sell: got.sell || [], hold: got.hold || [] })),
    db.prepare('DELETE FROM feed WHERE day < ?').bind(day(Date.now() - 14 * DAY)),
  ])
  return reply({ ok: true })
}

// The owner opens a subscription for a member without a payment: for the owner's own account, a reviewer, a guest.
// It is open at once, costs nothing, and takes no coupon. Zero days closes it.
async function gift(env, db, request) {
  if (!env.FEED_KEY) return reply({ ok: false }, 503)
  if (request.headers.get('authorization') !== 'Feed ' + env.FEED_KEY) return reply({ ok: false }, 401)
  const got = await request.json().catch(() => null)
  const phone = String(got?.phone || '').replace(/\D/g, ''), plan = String(got?.plan || 'all'), days = Number(got?.days ?? 30)
  if (!PRICE[plan] || !(days >= 0 && days <= 3660)) return reply({ ok: false }, 400)
  const m = await db.prepare('SELECT id FROM members WHERE phone = ?').bind(phone).first()
  if (!m) return reply({ ok: false, why: 'unknown' }, 404)
  const nine = eight(Date.now())                                                 // the last eight o'clock that has passed: open at once
  await db.prepare("INSERT INTO subs (member, plan, period, started, since, ends, paid, state) VALUES (?, ?, 'gift', ?, ?, ?, 0, ?) ON CONFLICT (member) DO UPDATE SET plan = excluded.plan, period = 'gift', started = excluded.started, since = excluded.since, ends = excluded.ends, paid = 0, state = excluded.state")
    .bind(m.id, plan, nine, nine, nine + days * DAY, days ? 'on' : 'off').run()
  return reply({ ok: true, plan, until: day(nine + days * DAY) })
}

// Stand-ins for the payment provider, on a local run only.
async function pretend(db, request, path, got) {
  const m = await who(db, request)
  if (!m) return reply({ ok: false, why: 'login' }, 401)
  const at = got?.at ? Date.parse(got.at) : Date.now() - Number(got?.daysAgo || 0) * DAY
  if (path === '/api/test/pay') return reply({ ok: true, amount: await pay(db, m.id, String(got?.plan), String(got?.period), at) })
  if (path === '/api/test/leave') return reply({ ok: true, back: await leave(db, m.id, at) })
  return reply({ ok: false }, 404)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request)
    const db = env.DB
    try {
      await db.batch(TABLES.map(t => db.prepare(t)))
      if (request.method === 'GET') {
        if (path === '/api/waitlist') return reply({ ok: true })
        if (path === '/api/me') { const m = await who(db, request); return reply({ ok: true, me: m ? await card(db, m, env) : null, open: !!env.OCTOMO_KEY || env.OCTOMO_TEST === '1' }) }
        if (path === '/api/orders') return await orders(db, request, url, 'list')
        if (path === '/api/orders.png') return await orders(db, request, url, 'picture')
        return reply({ ok: false }, 404)
      }
      if (request.method !== 'POST') return reply({ ok: false }, 405)
      const origin = request.headers.get('origin')
      if (origin && origin !== url.origin) return reply({ ok: false }, 403)
      if (path === '/api/feed') return await feed(env, db, request)
      if (path === '/api/gift') return await gift(env, db, request)
      if (Number(request.headers.get('content-length') || 0) > 2000) return reply({ ok: false }, 413)
      const got = await request.json().catch(() => null)
      if (path === '/api/waitlist') return await waitlist(db, got)
      if (path === '/api/join') return await begin(env, db, got, 'join')
      if (path === '/api/reset') return await begin(env, db, got, 'reset')
      if (path === '/api/check') return await finish(env, db, request, got)
      if (path === '/api/login') return await login(env, db, request, got)
      if (path === '/api/quit') return await quit(db, request, got)
      if (path === '/api/oath') {
        const m = await who(db, request)
        if (!m) return reply({ ok: false, why: 'login' }, 401)
        await db.prepare('INSERT OR IGNORE INTO oaths (member, at) VALUES (?, ?)').bind(m.id, Date.now()).run()
        return reply({ ok: true })
      }
      if (env.OCTOMO_TEST === '1' && path.startsWith('/api/test/')) return await pretend(db, request, path, got)
      if (path === '/api/logout') {
        const token = cookies(request).fs
        if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha(token)).run()
        return reply({ ok: true }, 200, [bake('fs', '', 0)])
      }
      return reply({ ok: false }, 404)
    } catch (e) {
      return reply({ ok: false }, 500)
    }
  },
}
