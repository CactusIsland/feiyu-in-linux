// 热梗 / 时事知识库：定时抓百度实时热搜 + B站热门，存成可检索的本地知识库。
// 实测可用源：百度热搜（HTML 内嵌 JSON）、B站热门（公开 API）。
// 微博/知乎/抖音 对服务器 IP 有反爬，已放弃。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const DIR = DSH + '/plugins-data/aurabot/modules-data/hot-topics'
const FILE = DIR + '/hot.json'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const KEEP_DAYS = 7

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

function readDb() {
  try { const j = JSON.parse(readFileSync(FILE, 'utf8')); if (j && j.days) return j } catch {}
  return { days: {} }
}
function writeDb(db) {
  try {
    const keys = Object.keys(db.days).sort().slice(-KEEP_DAYS)
    const days = {}
    for (const k of keys) days[k] = db.days[k]
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify({ days }, null, 1))
  } catch {}
}

async function fetchBaidu() {
  const r = await fetch('https://top.baidu.com/board?tab=realtime', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) })
  const html = await r.text()
  const out = []
  const seen = new Set()
  const re = /"query":"([^"]{2,60})"/g
  let m
  while ((m = re.exec(html))) {
    const t = m[1]
    if (seen.has(t)) continue
    seen.add(t)
    out.push({ title: t, source: '百度热搜', url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(t) })
    if (out.length >= 30) break
  }
  return out
}

async function fetchBili() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(25000) })
  const j = await r.json()
  if (j.code !== 0) throw new Error('B站热门接口 ' + j.code)
  return (j.data.list || []).map((v) => ({
    title: String(v.title || ''),
    source: 'B站热门',
    url: 'https://www.bilibili.com/video/' + v.bvid,
    extra: '播放 ' + (v.stat && v.stat.view || 0) + ' · UP ' + ((v.owner && v.owner.name) || ''),
    bvid: v.bvid,
  }))
}


async function fetchDouyin() {
  const r = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) })
  const j = await r.json()
  const list = j.word_list || []
  return list.slice(0, 30).map((x) => ({
    title: String(x.word || ''),
    source: '抖音热榜',
    url: 'https://www.douyin.com/search/' + encodeURIComponent(String(x.word || '')),
    extra: x.hot_value ? ('热度 ' + Math.round(Number(x.hot_value) / 10000) + '万') : '',
  })).filter((x) => x.title)
}

export default {
  id: 'hot-topics',
  name: '热梗知识库',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '定时抓百度实时热搜和 B站热门，存成本地知识库，让她知道最近大家在聊什么、有什么梗。',
  defaults: { enabled: true, refreshMinutes: 30, topN: 12 },
  setup(api) {
    const stats = { runs: 0, lastRun: 0, lastError: '', baidu: 0, bili: 0, douyin: 0 }

    async function refresh() {
      const day = today()
      const db = readDb()
      const slot = db.days[day] || { baidu: [], bili: [] }
      try {
        const [b, l, d] = await Promise.all([
          fetchBaidu().catch((e) => { stats.lastError = '百度:' + e.message; return [] }),
          fetchBili().catch((e) => { stats.lastError = 'B站:' + e.message; return [] }),
          fetchDouyin().catch((e) => { stats.lastError = '抖音:' + e.message; return [] }),
        ])
        if (b.length) { slot.baidu = b; stats.baidu = b.length }
        if (l.length) { slot.bili = l; stats.bili = l.length }
        if (d.length) { slot.douyin = d; stats.douyin = d.length }
        slot.updatedAt = Date.now()
        db.days[day] = slot
        writeDb(db)
        stats.runs += 1; stats.lastRun = Date.now()
        api.log.info?.(`热榜已更新：抖音 ${(slot.douyin||[]).length} / 百度 ${slot.baidu.length} / B站 ${slot.bili.length} 条`)
      } catch (e) { stats.lastError = String(e.message || e) }
      return slot
    }

    function pick(n) {
      const db = readDb()
      const day = today()
      const slot = db.days[day] || {}
      const all = [...(slot.douyin || []), ...(slot.baidu || []), ...(slot.bili || [])]
      return { day, list: all.slice(0, n || api.settings().topN || 12), updatedAt: slot.updatedAt || 0 }
    }

    api.tool(() => api.defineTool({
      name: 'hot_now',
      description: '看最近大家都在聊什么：抖音热榜 + 百度实时热搜 + B站热门。抖音热榜最接近「热梗/流行语」。聊到时事、新闻、网络热梗、流行语时用它，别凭记忆瞎说。',
      properties: { limit: { type: 'number', description: '要几条，默认 12' } },
      required: [],
      execute: async ({ limit }) => {
        let { day, list } = pick(limit)
        if (!list.length) { await refresh(); ({ day, list } = pick(limit)) }
        if (!list.length) return { ok: false, message: '暂时没抓到热榜（网络问题）' }
        const text = list.map((x, i) => `${i + 1}. [${x.source}] ${x.title}${x.extra ? '（' + x.extra + '）' : ''}`).join('\n')
        return { ok: true, message: `${day} 现在的热榜：\n${text}` }
      },
    }))

    api.tool(() => api.defineTool({
      name: 'hot_search',
      description: '在最近几天的热榜里搜关键词，看看某个梗/事件有没有上过热搜。',
      properties: { keyword: { type: 'string', description: '关键词' } },
      required: ['keyword'],
      execute: async ({ keyword }) => {
        const kw = String(keyword || '').trim()
        if (!kw) return { ok: false, message: '要给个关键词' }
        const db = readDb()
        const hits = []
        for (const [day, slot] of Object.entries(db.days)) {
          for (const x of [...(slot.douyin || []), ...(slot.baidu || []), ...(slot.bili || [])]) {
            if (String(x.title).includes(kw)) hits.push({ day, ...x })
          }
        }
        if (!hits.length) return { ok: true, message: `最近几天的热榜里没有「${kw}」` }
        return { ok: true, message: hits.slice(0, 10).map((x) => `${x.day} [${x.source}] ${x.title}`).join('\n') }
      },
    }))

    api.command({ name: '热榜', desc: '/热榜 —— 看现在热搜', run: async () => {
      const { list } = pick(10)
      if (!list.length) { await refresh() }
      const r = pick(10)
      return r.list.length ? r.list.map((x, i) => `${i + 1}. [${x.source}] ${x.title}`).join('\n') : '没抓到'
    } })

    api.route('/state', async () => {
      const db = readDb()
      const day = today()
      const slot = db.days[day] || {}
      return { ok: true, ...stats, today: day, days: Object.keys(db.days).sort(), counts: { douyin: (slot.douyin || []).length, baidu: (slot.baidu || []).length, bili: (slot.bili || []).length }, updatedAt: slot.updatedAt || 0 }
    })
    api.route('/list', async (req) => {
      const n = Number(api.core.http.query(req).n) || 30
      const { day, list, updatedAt } = pick(n)
      return { ok: true, day, updatedAt, list }
    })
    api.route('/refresh', async () => { await refresh(); return { ok: true, ...stats } })

    api.rule('聊到最近的新闻、时事、网络热梗、流行语时，先调用 hot_now 看一眼热榜，再结合你自己的想法说；不要凭训练数据瞎编最近发生了什么。')
    refresh()
    api.every(Math.max(5, Number(api.settings().refreshMinutes) || 30) * 60000, refresh, '热榜刷新')
    api.log.info?.('热梗知识库已就绪')
  },
}
