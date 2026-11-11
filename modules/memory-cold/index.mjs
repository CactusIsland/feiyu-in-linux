// 冷记忆库 —— 用户模块（Aurabot 扩展接口 v1）
//
// 长期记忆里越来越淡的事，不要直接删：先冷存一份（原文 + 关于谁 + 来源 + 历史），
// 再从热记忆库移走。之后只有对方明确提到旧事时，才按线索去冷库找。
//
// 同时兜底：内置记忆每天整理时可能直接删掉旧条目；这里每隔 10 分钟对账，
// 发现热库里少了谁，就从上次快照里补写进冷库，保证“忘了”不等于“没了”。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86400_000

function whenText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const now = new Date()
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return md
  return `${d.getFullYear()}-${md}`
}

function termsOf(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase().trim()
  if (!s) return []
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.add(w); continue }
    if (w.length === 1) { out.add(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2))
  }
  return [...out]
}

const PLACES = [
  '北京', '上海', '广州', '深圳', '杭州', '西安', '成都', '重庆', '南京', '武汉', '苏州', '长沙',
  '郑州', '天津', '青岛', '大连', '厦门', '昆明', '合肥', '宁波', '无锡', '佛山', '东莞', '沈阳',
  '哈尔滨', '长春', '石家庄', '太原', '南昌', '福州', '南宁', '贵阳', '兰州', '乌鲁木齐', '拉萨',
  '银川', '西宁', '呼和浩特', '海口', '三亚', '香港', '澳门', '台北', '日本', '东京', '大阪',
]

function parseCues(text, people = []) {
  const q = String(text || '')
  const now = new Date()
  let year = null
  if (/前年/.test(q)) year = now.getFullYear() - 2
  else if (/去年/.test(q)) year = now.getFullYear() - 1
  else if (/今年/.test(q)) year = now.getFullYear()
  else {
    const m = q.match(/(\d{4})\s*年/)
    if (m) year = Number(m[1])
  }
  let month = null
  const mm = q.match(/(\d{1,2})\s*月/)
  if (mm) month = Number(mm[1])
  const place = PLACES.find((p) => q.includes(p))
    || ((q.match(/([\u4e00-\u9fa5]{2,6})(?:市|省|区|县|镇|村|街|路|店|馆|山|河|湖|公园|车站|机场)/) || [])[1] || '')
  const person = (people || []).map((x) => String(x)).filter((x) => x && q.includes(x))[0] || ''
  const terms = termsOf(q).filter((t) => !['去年', '今年', '前年', '以前', '上次', '那次', '记得'].includes(t))
  return { year, month, place: String(place), person, terms }
}

function charVector(text) {
  const m = new Map()
  const s = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  if (!s) return m
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    m.set(c, (m.get(c) || 0) + 1)
    if (i < s.length - 1) {
      const bg = s.slice(i, i + 2)
      m.set(bg, (m.get(bg) || 0) + 1)
    }
  }
  return m
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k)
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-cold',
  name: '冷记忆库',
  version: '1.0.0',
  api: 1,
  description: '淡出热记忆的事先冷存一份，不再直接删；对方给线索时才按关键词找回',

  defaults: {
    enabled: true,
    scanMinutes: 10,
    coldBelow: 0.18,
    coldAfterDays: 30,
    sources: 'auto,tool',
    maxMovesPerRun: 5,
    maxSearchResults: 5,
    warnRows: 5000,
    warnBytesMB: 20,
  },

  settings: [
    { key: 'enabled', label: '开启冷记忆库', type: 'switch' },
    { key: 'scanMinutes', label: '每隔几分钟对账', type: 'number', min: 5, max: 120, step: 5 },
    { key: 'coldBelow', label: '清晰度低于多少移入冷库', type: 'number', min: 0.05, max: 0.5, step: 0.01 },
    { key: 'coldAfterDays', label: '至少放多少天才移入冷库', type: 'number', min: 1, max: 180, step: 1 },
    { key: 'sources', label: '哪些来源参与冷存（逗号分隔）', type: 'text', hint: 'auto=每天整理出来的，tool=她自己记的；panel/import 默认不动' },
    { key: 'maxMovesPerRun', label: '每轮最多移几条', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'maxSearchResults', label: '冷库一次最多返回几条', type: 'number', min: 1, max: 15, step: 1 },
    { key: 'warnRows', label: '冷库超过多少条告警', type: 'number', min: 500, max: 100000, step: 500 },
    { key: 'warnBytesMB', label: '冷库超过多少 MB 告警', type: 'number', min: 1, max: 200, step: 1 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const stateFile = () => join(dir, 'cold-state.json')
    const coldFile = () => join(dir, 'cold-memories.jsonl')

    let state = { version: 1, items: {}, archived: {}, lastScan: 0 }
    try { state = { ...state, ...(JSON.parse(readFileSync(stateFile(), 'utf8')) || {}) } } catch (error) {}
    state.items = state.items || {}
    state.archived = state.archived || {}

    const save = () => {
      try { writeFileSync(stateFile(), JSON.stringify(state)) } catch (error) { api.log.warn('冷记忆状态写入失败：' + error.message) }
    }

    const memory = () => api.use('memory')
    const protectedByMap = (id) => {
      {
      const mm = api.use('memory-map')
      if (!mm || typeof mm.isProtected !== 'function') return true   // 模块没开/没注册 → 全保护
      try { return Boolean(mm.isProtected(id)) } catch (error) { return true }
    }
    }

    function retention(m, now) {
      const cfg = api.config().ext?.['memory-compact'] || {}
      const halfLife = Number(cfg.halfLifeDays) || 21
      const last = Math.max(Number(m.at) || 0, Number(m.lastHit) || 0)
      const days = Math.max(0, (now - last) / DAY)
      const strength = 1 + Math.min(10, Number(m.hitDays) || 0)
      const importance = Math.max(0.05, Math.min(1, Number(m.importance) || 0.5))
      const tau = halfLife * strength * (0.5 + importance)
      return Math.exp(-days / tau)
    }

    function snapshot(m) {
      return {
        id: m.id,
        text: String(m.text || ''),
        about: String(m.about || ''),
        aboutName: String(m.aboutName || ''),
        tags: (m.tags || []).slice(0, 6),
        importance: Number(m.importance) || 0.5,
        source: String(m.source || ''),
        chatId: String(m.chatId || ''),
        at: Number(m.at) || 0,
        lastHit: Number(m.lastHit) || 0,
        hitDays: Number(m.hitDays) || 0,
        history: (m.history || []).slice(-3),
      }
    }

    function stageOf(m, now) {
      const age = now - (Number(m.at) || 0)
      if ((m.tags || []).includes('压缩')) return 'summary'
      if (age > 30 * DAY) return 'cold'
      return 'detail'
    }

    function archiveMemory(m, reason = 'manual') {
      if (!m || !m.id) return false
      const id = String(m.id)
      if (state.archived[id]) return false
      const now = Date.now()
      const item = snapshot(m)
      const row = {
        v: 1,
        id,
        reason: String(reason),
        at: now,
        stage: reason === 'cold' ? 'cold' : stageOf(m, now),
        retention: Number(retention(m, now).toFixed(4)),
        item,
      }
      try {
        appendFileSync(coldFile(), JSON.stringify(row) + '\n')
      } catch (error) {
        api.log.warn('写冷记忆失败：' + error.message)
        return false
      }
      state.archived[id] = now
      delete state.items[id]
      return true
    }

    function scan() {
      if (!api.settings().enabled) return { ok: false, message: '没开' }
      const store = memory()
      if (!store || typeof store.list !== 'function') return { ok: false, message: '记忆模块没在跑' }
      const items = store.list('') || []
      const live = items.filter((m) => !m.invalidAt)
      const byId = new Map(live.map((m) => [String(m.id), m]))
      const now = Date.now()
      let removed = 0
      let moved = 0

      // 1) 先记住现在还在热库里的原文
      for (const m of live) state.items[String(m.id)] = snapshot(m)

      // 2) 上次还在、这次不见了：补写冷库（内置整理直接删也能兜住）
      for (const [id, snap] of Object.entries(state.items)) {
        if (byId.has(id)) continue
        if (!state.archived[id] && archiveMemory(snap, 'removed')) removed++
        delete state.items[id]
      }

      // 3) 已经很淡的：冷存后从热库移走
      const cfg = api.settings()
      const srcOk = new Set(String(cfg.sources || 'auto,tool').split(',').map((s) => s.trim()).filter(Boolean))
      const coldBelow = Math.max(0.03, Math.min(0.6, Number(cfg.coldBelow) || 0.18))
      const minAge = Math.max(1, Number(cfg.coldAfterDays) || 30) * DAY
      const maxMoves = Math.max(1, Number(cfg.maxMovesPerRun) || 5)
      const mapReady = Boolean(api.use('memory-map'))
      const candidates = !mapReady ? [] : live
        .filter((m) => !protectedByMap(m.id))
        .filter((m) => srcOk.has(String(m.source || '')))
        .filter((m) => now - (Number(m.at) || 0) >= minAge)
        .filter((m) => retention(m, now) < coldBelow)
        .sort((a, b) => retention(a, now) - retention(b, now))
        .slice(0, maxMoves)
      for (const m of candidates) {
        if (archiveMemory(m, 'cold')) {
          try { store.remove(m.id) } catch (error) { api.log.warn('移入冷库时删热记忆失败：' + error.message) }
          moved++
        }
      }

      state.lastScan = now
      save()
      const st = stats()
      if (st.warning && st.warning.length) {
        const lastWarn = Number(state.lastWarn) || 0
        if (now - lastWarn > 3600_000) {
          state.lastWarn = now
          save()
          api.log.warn('冷记忆库容量告警：' + st.warning.join('；'))
        }
      }
      if (removed || moved) api.log.info(`冷记忆对账：补存 ${removed} 条，移入冷库 ${moved} 条`)
      return { ok: true, removed, moved, tracked: Object.keys(state.items).length, archived: Object.keys(state.archived).length }
    }

    function readCold() {
      if (!existsSync(coldFile())) return []
      try { return readFileSync(coldFile(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch (error) { return null } }).filter(Boolean) } catch (error) { return [] }
    }

    function peopleNames() {
      try {
        const map = api.use('memory-map')?.map?.()
        return (map?.people || []).map((p) => String(p.name || '')).filter(Boolean)
      } catch (error) { return [] }
    }

    function searchStructured(query, o = {}) {
      const q = String(query || '').trim()
      if (!q) return { items: [], needConfirm: false, candidates: [], cues: {} }
      const cues = parseCues(q, peopleNames())
      const terms = cues.terms
      if (!terms.length) return { items: [], needConfirm: false, candidates: [], cues }
      const limit = Math.max(1, Math.min(15, Number(o.limit) || api.settings().maxSearchResults || 5))
      const qVec = charVector(q)
      const qLower = q.toLowerCase()
      const hits = []
      for (const row of readCold()) {
        const item = row.item || {}
        const text = String(item.text || '')
        if (!text) continue
        const at = Number(item.at || row.at) || 0
        const d = new Date(at)
        const lower = text.toLowerCase()
        let score = 0
        const matched = { time: false, place: false, person: false, item: false }
        if (lower.includes(qLower)) score += 8
        for (const t of terms) {
          if (lower.includes(t)) score += 1
          if (String(item.aboutName || '').toLowerCase().includes(t)) score += 2
        }
        if (cues.year && d.getFullYear() === cues.year) { score += 5; matched.time = true }
        if (cues.month && d.getMonth() + 1 === cues.month) { score += 3; matched.time = true }
        if (cues.place && text.includes(cues.place)) { score += 5; matched.place = true }
        if (cues.person && (String(item.aboutName || '').includes(cues.person) || text.includes(cues.person))) { score += 4; matched.person = true }
        if (terms.some((t) => lower.includes(t))) matched.item = true
        score += cosine(qVec, charVector(text + ' ' + String(item.aboutName || ''))) * 6
        if (score <= 0) continue
        hits.push({
          id: row.id,
          text,
          about: item.aboutName || item.about || '',
          chatId: String(item.chatId || ''),
          at,
          when: whenText(at),
          stage: row.stage || 'cold',
          reason: row.reason || '',
          score: Number(score.toFixed(2)),
          matched,
        })
      }
      hits.sort((a, b) => b.score - a.score || b.at - a.at)
      const seen = new Set()
      const picked = []
      for (const h of hits) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        picked.push(h)
      }
      const items = picked.slice(0, limit)
      const top = picked.slice(0, 2)
      const needConfirm = top.length === 2
        && Math.abs(top[0].score - top[1].score) <= 1.5
        && top[0].score >= 5
        && Math.abs(top[0].at - top[1].at) > DAY
        && String(top[0].text) !== String(top[1].text)
      const candidates = needConfirm
        ? top.map((h) => ({ id: h.id, when: h.when, about: h.about, chatId: String(h.chatId || ''), text: String(h.text).slice(0, 70) }))
        : []
      return { items, needConfirm, candidates, cues }
    }

    function search(query, o = {}) {
      return searchStructured(query, o).items
    }

    function stats() {
      let rows = 0
      let bytes = 0
      if (existsSync(coldFile())) {
        try { bytes = statSync(coldFile()).size; rows = readFileSync(coldFile(), 'utf8').split('\n').filter(Boolean).length } catch (error) {}
      }
      const cfg = api.settings()
      const warning = []
      const warnRows = Math.max(500, Number(cfg.warnRows) || 5000)
      const warnBytes = Math.max(1, Number(cfg.warnBytesMB) || 20) * 1024 * 1024
      if (rows > warnRows) warning.push(`条数 ${rows} 超过 ${warnRows}`)
      if (bytes > warnBytes) warning.push(`体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${Number(cfg.warnBytesMB) || 20}MB`)
      return {
        ok: true,
        rows,
        bytes,
        warning,
        tracked: Object.keys(state.items).length,
        archived: Object.keys(state.archived).length,
        lastScan: state.lastScan,
      }
    }

    api.route('/state', async () => ({ ...stats(), settings: api.settings() }))
    api.route('/scan', async () => scan())
    api.route('/search', async (req) => ({ ok: true, items: search(String(api.core.http.query(req).q || ''), { limit: Number(api.core.http.query(req).limit) || undefined }) }))
    api.route('/structured', async (req) => {
      const q = api.core.http.query(req)
      return { ok: true, ...searchStructured(String(q.q || ''), { limit: Number(q.limit) || undefined }) }
    })
    api.route('/cold', async (req) => {
      const limit = Math.max(1, Math.min(50, Number(api.core.http.query(req).limit) || 10))
      const rows = readCold().slice(-limit).reverse().map((r) => ({ id: r.id, reason: r.reason, at: r.at, text: r.item?.text || '', about: r.item?.aboutName || '', stage: r.stage }))
      return { ok: true, items: rows }
    })

    api.tool((where) => {
      if (where.level !== 'full') return []
      return api.defineTool({
        name: 'cold_recall',
        description: '翻冷记忆库：很久以前、已经不常提的事。对方明确提到旧人、旧地、旧事而你想不起细节时用；没找到就说记不清，不要编。',
        properties: {
          query: { type: 'string', description: '线索：人名、地点、物品、事件关键词' },
        },
        required: ['query'],
        execute: async ({ query }) => {
          const hits = search(String(query || ''), { limit: 5 })
          if (!hits.length) return { ok: true, message: '冷库里没找到相关的事。' }
          return { ok: true, message: hits.map((h) => `[${h.when}] ${h.about ? '[' + h.about + '] ' : ''}${h.text}`).join('\n') }
        },
      })
    })

    api.rule((kind) => (kind === 'private'
      ? '很久以前、已经不常提的事放在你的冷记忆库里。对方提到旧事时可以用 cold_recall 找；找不到就直说记不清，不要编。'
      : ''))

    api.every(Math.max(5, Number(api.settings().scanMinutes) || 10) * 60_000, scan, '冷记忆对账')
    api.later(60_000, scan)
    api.on('module/start', (id) => { if (String(id) === 'memory') { try { scan() } catch (error) {} } })
    scan()
    api.log.info('冷记忆库已挂上（淡出先冷存，内置删除也会对账兜底）')

    return { archiveMemory, scan, search, searchStructured, stats }
  },
}
