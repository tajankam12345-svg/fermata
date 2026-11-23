// Serves the page from public/ and keeps the launch list.
const TABLE = 'CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, joined TEXT NOT NULL, place TEXT)'
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/api/waitlist') return env.ASSETS.fetch(request)
    try {
      await env.DB.prepare(TABLE).run()
      if (request.method === 'GET') {
        await env.DB.prepare('SELECT 1 FROM waitlist LIMIT 1').first()
        return reply({ ok: true })
      }
      if (request.method !== 'POST') return reply({ ok: false }, 405)
      if (Number(request.headers.get('content-length') || 0) > 2000) return reply({ ok: false }, 413)
      const got = await request.json().catch(() => null)
      const email = String(got?.email || '').trim().toLowerCase()
      if (got?.site) return reply({ ok: true })                                  // the hidden field: filled only by scripts
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply({ ok: false, why: 'email' }, 400)
      const place = String(got?.where || '').slice(0, 20)
      await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, joined, place) VALUES (?, ?, ?)').bind(email, new Date().toISOString(), place).run()
      return reply({ ok: true })
    } catch (e) {
      return reply({ ok: false }, 500)
    }
  },
}
