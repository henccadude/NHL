
const STORAGE_KEY = 'nhl_pool_anyserver_v5_4'

// randomUUID polyfill
if (!('crypto' in window) || !('randomUUID' in crypto)) {
  window.crypto = window.crypto || {}
  crypto.randomUUID = () => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10)
}

const state = {
  season: currentNHLSeason(),
  participants: loadState()
}

function currentNHLSeason(date = new Date()) {
  const y = date.getFullYear()
  const m = date.getMonth()
  return (m >= 8) ? `${y}${y + 1}` : `${y - 1}${y}`
}
function seasonFromStartYear(y) { return `${y}${y+1}` }
function fmtSeason(s){ return `${s.slice(0,4)}–${s.slice(4)}` }

function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.participants)) }
  catch(e){ console.error('saveState failed', e); alert('Tallennus epäonnistui (selainvarasto täynnä?)') }
}
function loadState(){ try{ const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : [] }catch{ return [] }}

// --- Export / Import JSON ---
function exportJSON(){
  try{
    const data = JSON.stringify(state.participants, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `nhl-pool-${state.season}.json`
    document.body.appendChild(a)
    a.click()
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove() }, 500)
  }catch(e){ alert('Vienti epäonnistui') }
}
function importJSONFile(file){
  const reader = new FileReader()
  reader.onload = () => {
    try{
      const arr = JSON.parse(reader.result)
      if (!Array.isArray(arr)) throw new Error('not array')
      state.participants = arr
      saveState()
      render({ autoRefresh: true })
    }catch(e){ alert('Virheellinen JSON-tiedosto') }
  }
  reader.readAsText(file)
}

// Static refs fetched on DOMContentLoaded
let participantsEl, newParticipantEl, addParticipantBtn, seasonLabel, rankingBody, refreshAllBtn, btnExport, btnImport, fileImport

function buildSeasonButtons(){
  const seasonPickerEl = document.getElementById('seasonPicker')
  if (!seasonPickerEl) return
  seasonPickerEl.innerHTML = ''
  const start = Number(state.season.slice(0,4))
  const seasons = [seasonFromStartYear(start-1), seasonFromStartYear(start), seasonFromStartYear(start+1)]
  seasons.forEach(s=>{
    const btn = document.createElement('button')
    btn.className = 'btn' + (s===state.season ? ' btn-primary' : '')
    btn.textContent = fmtSeason(s)
    btn.dataset.season = s
    btn.addEventListener('click', ()=>{
      if (state.season !== s) {
        state.season = s
        render({ autoRefresh: true })
      }
    })
    seasonPickerEl.appendChild(btn)
  })
}

function computeParticipantTotal(p){
  let total = 0
  for (const pick of (p.picks || [])){
    const pts = pick && pick._stats && typeof pick._stats.points === 'number' ? pick._stats.points : 0
    total += pts
  }
  return total
}

function renderRanking(){
  if (!rankingBody) return
  const items = state.participants.map(p => ({
    id: p.id,
    name: p.name,
    count: p.picks?.length || 0,
    total: computeParticipantTotal(p)
  }))
  items.sort((a,b)=> b.total - a.total || a.name.localeCompare(b.name))
  rankingBody.innerHTML = ''
  items.forEach((it, idx) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${it.name}</td>
      <td>${it.count}</td>
      <td><b>${it.total}</b></td>
    `
    rankingBody.appendChild(tr)
  })
}

function render(opts={}){
  const autoRefresh = !!opts.autoRefresh
  buildSeasonButtons()
  seasonLabel.textContent = `Valittu kausi: ${fmtSeason(state.season)}`

  participantsEl.innerHTML = ''
  if (state.participants.length === 0){
    const empty = document.createElement('div')
    empty.className = 'card'
    empty.innerHTML = '<p class="muted">Ei osallistujia vielä.</p>'
    participantsEl.appendChild(empty);
    rankingBody.innerHTML = ''
    return
  }

  const pairs = []
  state.participants.forEach(p => {
    const card = renderParticipant(p)
    participantsEl.appendChild(card)
    pairs.push({ p, card })
  })

  if (autoRefresh) {
    pairs.forEach(({p, card}) => { refreshStats(p, card).then(()=>renderRanking()).catch(()=>renderRanking()) })
  } else {
    renderRanking()
  }
}

function renderParticipant(participant){
  const card = document.createElement('div')
  card.className = 'card'

  const header = document.createElement('div')
  header.className = 'flex justify-between'
  header.innerHTML = `
    <div>
      <h3>${participant.name}</h3>
      <div class="muted small">Valittuja pelaajia: ${participant.picks.length}/10</div>
    </div>
    <div class="tools">
      <button class="btn" data-action="refresh">Päivitä pisteet</button>
      <button class="btn" data-action="remove">Poista</button>
    </div>
  `
  card.appendChild(header)

  const content = document.createElement('div')
  content.className = 'row gap'
  content.innerHTML = `
    <div style="flex:1; min-width: 260px;">
      <h4>Lisää pelaaja</h4>
      <input class="input" placeholder="Hae nimellä (väh. 2 merkkiä)" data-role="search" />
      <div class="list" data-role="results" style="margin-top:8px;"></div>
    </div>
    <div style="flex:2; min-width: 400px;">
      <h4>Pelaajat & pisteet (kausi ${fmtSeason(state.season)})</h4>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Pelaaja</th><th>O</th><th>M</th><th>S</th><th>P</th><th></th>
            </tr>
          </thead>
          <tbody data-role="tbody"></tbody>
        </table>
      </div>
      <div class="row" style="justify-content:flex-end; margin-top:6px;">
        <div class="muted small" style="text-align:right">
          <div>Pisteet yhteensä</div>
          <div id="total" style="font-weight:700; font-size:20px; text-align:right">0</div>
        </div>
      </div>
    </div>
  `
  card.appendChild(content)

  header.querySelector('[data-action="remove"]').addEventListener('click', ()=>{
    state.participants = state.participants.filter(pp => pp.id !== participant.id)
    saveState(); render()
  })
  header.querySelector('[data-action="refresh"]').addEventListener('click', ()=> {
    refreshStats(participant, card).then(()=>renderRanking())
  })

  // search
  const searchInput = content.querySelector('[data-role="search"]')
  const resultsEl = content.querySelector('[data-role="results"]')
  let t = null
  searchInput.addEventListener('input', ()=>{
    clearTimeout(t)
    const q = searchInput.value.trim()
    if (q.length < 2){ resultsEl.innerHTML=''; return }
    t = setTimeout(async ()=>{
      resultsEl.innerHTML = '<div class="muted small" style="padding:8px">Haetaan…</div>'
      try{
        const r = await fetch('/api/search?name=' + encodeURIComponent(q))
        if (!r.ok) throw new Error('hakuvirhe ' + r.status)
        const arr = await r.json()
        if (!Array.isArray(arr) || arr.length===0){ resultsEl.innerHTML = '<div class="muted small" style="padding:8px">Ei tuloksia</div>'; return }
        resultsEl.innerHTML = ''
        arr.forEach(p => {
          const btn = document.createElement('button')
          btn.setAttribute('data-id', String(p.id))
          btn.setAttribute('data-name', p.name)
          btn.className = 'result-item'
          const tag = document.createElement('span')
          tag.className = 'badge'
          tag.textContent = '#' + p.id
          const nameSpan = document.createElement('span')
          nameSpan.className = 'name'
          nameSpan.textContent = p.name
          btn.appendChild(tag)
          btn.appendChild(nameSpan)
          btn.addEventListener('click', async () => {
            const id = Number(btn.getAttribute('data-id'))
            const name = btn.getAttribute('data-name') || ''
            addPick(participant, { id, name })
            await refreshStats(participant, card)
            renderRanking()
          })
          resultsEl.appendChild(btn)
        })
      }catch(e){
        console.error('search fail', e)
        resultsEl.innerHTML = '<div class="muted small" style="padding:8px">Haku epäonnistui</div>'
      }
    }, 300)
  })

  renderRows(participant, card)
  return card
}

function addPick(participant, pick){
  if (participant.picks.find(pp => pp.id === pick.id)){ alert('Pelaaja on jo listalla.'); return }
  if (participant.picks.length >= 10){ alert('Maksimi 10 pelaajaa.'); return }
  participant.picks.push(pick)
  saveState()
}

async function refreshStats(participant, card){
  const season = state.season
  const tbody = card.querySelector('[data-role="tbody"]')
  tbody.querySelectorAll('tr').forEach(tr => tr.classList.add('muted'))
  const results = await Promise.all(participant.picks.map(p =>
    fetch(`/api/player/${p.id}?season=${encodeURIComponent(season)}`).then(r => r.ok ? r.json() : null).catch(()=>null)
  ))
  participant.picks = participant.picks.map((p, idx) => ({ ...p, _stats: results[idx] }))
  renderRows(participant, card)
  saveState()
}

function renderRows(participant, card){
  const tbody = card.querySelector('[data-role="tbody"]')
  tbody.innerHTML=''
  let total = 0
  participant.picks.forEach((p, idx)=>{
    const s = p._stats || {}
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td data-label="#"><span class="cell-label">#</span><span class="cell-val">${idx+1}</span></td>
      <td data-label="Pelaaja"><span class="cell-label">Pelaaja</span><span class="cell-val">${s.name || p.name}</span></td>
      <td data-label="Ottelut"><span class="cell-label">Ottelut</span><span class="cell-val">${s.games ?? '-'}</span></td>
      <td data-label="Maalit"><span class="cell-label">Maalit</span><span class="cell-val">${s.goals ?? '-'}</span></td>
      <td data-label="Syötöt"><span class="cell-label">Syötöt</span><span class="cell-val">${s.assists ?? '-'}</span></td>
      <td data-label="Pisteet"><span class="cell-label">Pisteet</span><span class="cell-val"><b>${s.points ?? '-'}</b></span></td>
      <td data-label=""><button class="btn" data-remove>Poista</button></td>
    `
    tr.querySelector('[data-remove]').addEventListener('click', ()=>{
      participant.picks = participant.picks.filter(pp => pp.id !== p.id)
      saveState(); render()
    })
    tbody.appendChild(tr)
    if (typeof s.points === 'number') total += s.points
  })
  const totalEl = card.querySelector('#total')
  if (totalEl) totalEl.textContent = total
}

async function refreshAllParticipants(){
  const cards = Array.from(document.querySelectorAll('#participants .card'))
  const participants = state.participants.slice()
  for (let i = 0; i < participants.length; i++){
    const p = participants[i]
    const card = cards[i]
    if (card) { await refreshStats(p, card) }
  }
  renderRanking()
}

// DOM ready
window.addEventListener('DOMContentLoaded', () => {
  participantsEl = document.getElementById('participants')
  newParticipantEl = document.getElementById('newParticipant')
  addParticipantBtn = document.getElementById('addParticipant')
  seasonLabel = document.getElementById('seasonLabel')
  rankingBody = document.getElementById('rankingBody')
  refreshAllBtn = document.getElementById('refreshAll')
  btnExport = document.getElementById('btnExport')
  btnImport = document.getElementById('btnImport')
  fileImport = document.getElementById('fileImport')

  addParticipantBtn.addEventListener('click', () => {
    const name = (newParticipantEl.value || '').trim()
    if (!name) return
    if (state.participants.some(p => p.name.toLowerCase() === name.toLowerCase())) { alert('Nimi on jo käytössä.'); return }
    state.participants.unshift({ id: crypto.randomUUID(), name, picks: [] })
    newParticipantEl.value = ''
    saveState(); render()
  })

  if (refreshAllBtn) refreshAllBtn.addEventListener('click', () => refreshAllParticipants())
  if (btnExport) btnExport.addEventListener('click', () => exportJSON())
  if (btnImport) btnImport.addEventListener('click', () => fileImport && fileImport.click())
  if (fileImport) fileImport.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]
    if (f) importJSONFile(f)
    e.target.value = ''
  })

  render()
})
