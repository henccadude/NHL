
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

// Simple request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  next()
})

// Static
app.use(express.static(path.join(__dirname, 'public')))

// Health check
app.get('/health', (req, res) => res.json({ ok: true }))

// Helper fetch with timeout
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

// Search NHL players by name using Records API (covers all players, historical + active)
app.get('/api/search', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim()
    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'name >= 2 chars required' })
    }
    const cayenne = `fullName like "%${name}%"`
    const url = 'https://records.nhl.com/site/api/player?cayenneExp=' + encodeURIComponent(cayenne)
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'PoolApp/1.0' } })
    if (!r.ok) {
      const body = await r.text().catch(()=>'')
      console.error('Records API error', r.status, body)
      return res.status(r.status).json({ error: 'records fetch failed', status: r.status })
    }
    const data = await r.json()
    const rows = Array.isArray(data?.data) ? data.data : []
    const out = rows.map(row => ({
      id: Number(row?.playerId ?? row?.id),
      name: String(row?.fullName || row?.name || 'Tuntematon')
    }))
    // de-dup by id
    const map = new Map()
    out.forEach(p => { if (p.id && p.name) map.set(p.id, p) })
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.json(Array.from(map.values()).slice(0, 100))
  } catch (e) {
    console.error('Search fatal error', e)
    return res.status(500).json({ error: 'search error', detail: String(e?.message || e) })
  }
})

// Player season stats via api.nhle.com (skater/goalie summary). Name from api-web.nhle.com.
app.get('/api/player/:id', async (req, res) => {
  const id = Number(req.params.id)
  const season = String(req.query.season || '').trim() // e.g. 20242025
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' })
  if (!/^[0-9]{8}$/.test(season)) return res.status(400).json({ error: 'invalid season (YYYYYYYY)' })

  // Guard for far-future seasons: return zeros
  const startYear = Number(season.slice(0,4))
  const now = new Date()
  const currentSeasonStart = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1
  if (!Number.isFinite(startYear) || startYear > currentSeasonStart + 1) {
    return res.json({ id, name: `#${id}`, games: 0, goals: 0, assists: 0, points: 0 })
  }

  try {
    // 1) Player display name
    let fullName = `#${id}`
    try {
      const landing = await fetchWithTimeout(`https://api-web.nhle.com/v1/player/${id}/landing`,
        { headers: { 'User-Agent': 'PoolApp/1.0' } })
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

    // 2) Stats via api.nhle.com skater/goalie summary
    const common = {
      isAggregate: 'true',
      isGame: 'false',
      sort: '[{"property":"playerId","direction":"ASC"}]',
      limit: '100',
      cayenneExp: `seasonId=${season} and gameTypeId=2 and playerId=${id}`
    }
    const toQS = (obj) => new URLSearchParams(obj).toString()
    let games=0, goals=0, assists=0, points=0, ok=false

    const skaterUrl = `https://api.nhle.com/stats/rest/en/skater/summary?${toQS(common)}`
    const r1 = await fetchWithTimeout(skaterUrl, { headers: { 'User-Agent': 'PoolApp/1.0' } })
    if (r1.ok) {
      const j1 = await r1.json()
      const row = j1?.data?.[0]
      if (row) {
        games = Number(row.gamesPlayed || 0)
        goals = Number(row.goals || 0)
        assists = Number(row.assists || 0)
        points = Number(row.points != null ? row.points : (goals + assists))
        ok = true
      }
    }

    if (!ok) {
      const goalieUrl = `https://api.nhle.com/stats/rest/en/goalie/summary?${toQS(common)}`
      const r2 = await fetchWithTimeout(goalieUrl, { headers: { 'User-Agent': 'PoolApp/1.0' } })
      if (r2.ok) {
        const j2 = await r2.json()
        const row = j2?.data?.[0]
        if (row) {
          games = Number(row.gamesPlayed || 0)
          goals = Number(row.goals || 0)
          assists = Number(row.assists || 0)
          points = Number(row.points != null ? row.points : (goals + assists))
          ok = true
        }
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.json({ id, name: fullName, games, goals, assists, points })
  } catch (e) {
    console.error('Player fatal error', e)
    return res.status(500).json({ error: 'player error', detail: String(e?.message || e) })
  }
})

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log('Server running http://localhost:' + PORT)
})
