
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import compression from 'compression'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

// tiny access log
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`); next() })

// gzip
app.use(compression())

// static
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p){
    if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
    else res.setHeader('Cache-Control', 'public, max-age=604800')
  }
}))

// health
app.get('/health', (_req, res) => res.json({ ok: true }))

// simple in-memory cache for /api/player responses
const cache = new Map() // key: `${id}:${season}` -> {data, exp}
const TTL = 3 * 60 * 1000
const getC = k => { const v = cache.get(k); if (!v || v.exp < Date.now()) return null; return v.data }
const setC = (k,d) => cache.set(k, { data: d, exp: Date.now() + TTL })

// helper fetch with timeout
async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ac = new AbortController()
  const id = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal })
    return r
  } finally {
    clearTimeout(id)
  }
}

// player search via Records API (no CORS from browser → proxy through server)
app.get('/api/search', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim()
    if (!name || name.length < 2) return res.status(400).json({ error: 'name >= 2 chars required' })
    const cayenne = `fullName like "%${name}%"`
    const url = 'https://records.nhl.com/site/api/player?cayenneExp=' + encodeURIComponent(cayenne)
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'PoolApp/1.0' } })
    if (!r.ok) {
      const body = await r.text().catch(()=> '')
      console.error('Records API error', r.status, body)
      return res.status(r.status).json({ error: 'records fetch failed', status: r.status })
    }
    const data = await r.json()
    const rows = Array.isArray(data?.data) ? data.data : []
    const out = rows.map(row => ({
      id: Number(row?.playerId ?? row?.id),
      name: String(row?.fullName || row?.name || 'Tuntematon')
    }))
    const uniq = Array.from(new Map(out.filter(p => p.id && p.name).map(p=>[p.id,p])).values())
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.json(uniq.slice(0, 100))
  } catch (e) {
    console.error('Search fatal error', e)
    return res.status(500).json({ error: 'search error', detail: String(e?.message || e) })
  }
})

// player season stats via api.nhle.com (skater/goalie). Name via api-web.nhle.com.
app.get('/api/player/:id', async (req, res) => {
  const id = Number(req.params.id)
  const season = String(req.query.season || '').trim()
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  if (!/^[0-9]{8}$/.test(season)) return res.status(400).json({ error: 'invalid season (YYYYYYYY)' })

  const startYear = Number(season.slice(0,4))
  const now = new Date()
  const currentSeasonStart = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
  if (!Number.isFinite(startYear) || startYear > currentSeasonStart + 1) {
    return res.json({ id, name: `#${id}`, games: 0, goals: 0, assists: 0, points: 0 })
  }

  const key = `${id}:${season}`
  const hit = getC(key)
  if (hit) { res.setHeader('Access-Control-Allow-Origin','*'); return res.json(hit) }

  try {
    // Name
    let fullName = `#${id}`
    try {
      const landing = await fetchWithTimeout(`https://api-web.nhle.com/v1/player/${id}/landing`, { headers: { 'User-Agent': 'PoolApp/1.0' } })
      if (landing.ok) {
        const j = await landing.json()
        if (j?.firstName?.default || j?.lastName?.default) {
          const fn = (j.firstName?.default || '').trim()
          const ln = (j.lastName?.default || '').trim()
          const combined = `${fn} ${ln}`.trim()
          if (combined) fullName = combined
        } else if (j?.name) {
          fullName = String(j.name)
        }
      }
    } catch {}

    const qs = (obj) => new URLSearchParams(obj).toString()
    const common = {
      isAggregate: 'true',
      isGame: 'false',
      sort: '[{"property":"playerId","direction":"ASC"}]',
      limit: '100',
      cayenneExp: `seasonId=${season} and gameTypeId=2 and playerId=${id}`
    }

    let games=0, goals=0, assists=0, points=0, ok=false

    // Skater
    const sUrl = `https://api.nhle.com/stats/rest/en/skater/summary?${qs(common)}`
    const r1 = await fetchWithTimeout(sUrl, { headers: { 'User-Agent': 'PoolApp/1.0' } })
    if (r1.ok) {
      const j = await r1.json()
      const row = j?.data?.[0]
      if (row) {
        games = Number(row.gamesPlayed || 0)
        goals = Number(row.goals || 0)
        assists = Number(row.assists || 0)
        points = Number(row.points != null ? row.points : (goals + assists))
        ok = true
      }
    }

    // Goalie fallback
    if (!ok) {
      const gUrl = `https://api.nhle.com/stats/rest/en/goalie/summary?${qs(common)}`
      const r2 = await fetchWithTimeout(gUrl, { headers: { 'User-Agent': 'PoolApp/1.0' } })
      if (r2.ok) {
        const j = await r2.json()
        const row = j?.data?.[0]
        if (row) {
          games = Number(row.gamesPlayed || 0)
          goals = Number(row.goals || 0)
          assists = Number(row.assists || 0)
          points = Number(row.points != null ? row.points : (goals + assists))
          ok = true
        }
      }
    }

    const payload = { id, name: fullName, games, goals, assists, points }
    setC(key, payload)
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.json(payload)
  } catch (e) {
    console.error('Player fatal error', e)
    return res.status(500).json({ error: 'player error', detail: String(e?.message || e) })
  }
})

// root + SPA fallbacks
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.head('/', (_req, res) => res.status(200).end())
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
app.head('*', (_req, res) => res.status(200).end())

app.listen(PORT, () => console.log('Server running http://localhost:' + PORT))
