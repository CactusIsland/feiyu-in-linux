// 世界：日记 / 自我叙事 / 每日回顾 / 翻旧账
// 参考 dsh-world 的思路，做成 Aurabot 模块，复用现有会话与记忆，不引入第二套 QQ 通道。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const DIR = DSH + '/plugins-data/aurabot/modules-data/world'
const DIARY = DIR + '/diary'
const VERS = DIR + '/self-versions'
const SELF = DIR + '/self.md'
const SESSIONS = DSH + '/sessions'

function pad(n) { return String(n).padStart(2, '0') }
function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function ensure() { mkdirSync(DIARY, { recursive: true }); mkdirSync(VERS, { recursive: true }) }

function readSelf() {
  try { return readFileSync(SELF, 'utf8') } catch { return '' }
}
function writeSelf(text) {
  ensure()
  try { if (existsSync(SELF)) copyFileSync(SELF, join(VERS, `${Date.now()}.md`)) } catch {}
  writeFileSync(SELF, text)
}

function listDiary(limit = 14) {
  try {
    return readdirSync(DIARY).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, limit)
      .map((f) => ({ date: f.replace('.md', ''), bytes: (() => { try { return statSync(join(DIARY, f)).size } catch { return 0 } })() }))
  } catch { return [] }
}
function readDiary(date) {
  try { return readFileSync(join(DIARY, `${date}.md`), 'utf8') } catch { return '' }
}

// 扫今天的对话（所有会话、所有工作区）
function collectDay(startMs, limitChars = 14000, skipSessions = new Set()) {
  const out = []
  let dirs = []
  try { dirs = readdirSync(SESSIONS) } catch { return out }
  for (const proj of dirs) {
    let ids = []
    try { ids = readdirSync(join(SESSIONS, proj)) } catch { continue }
    for (const sid of ids) {
      if (skipSessions.has(sid)) continue
      const f = join(SESSIONS, proj, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      let text = ''
      try { text = zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line || (line.indexOf('user/message') < 0 && line.indexOf('assistant/message') < 0)) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        const t = Number(j.time) || 0
        if (t < startMs) continue
        const role = j.type === 'user/message' ? '用户' : '她'
        const d2 = j.data || {}
              const msg = d2.message || d2
        const parts = Array.isArray(msg.content) ? msg.content : []
        const body = parts.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ').trim()
        if (!body) continue
        out.push({ at: t, role, text: body.slice(0, 400), chat: proj.replace(/^--|--$/g, '').replace(/-/g, '/') })
      }
    }
  }
  out.sort((a, b) => a.at - b.at)
  // 从后往前取，控制总长度
  let total = 0
  const keep = []
  for (let i = out.length - 1; i >= 0; i--) {
    const len = out[i].text.length + 12
    if (total + len > limitChars) break
    total += len
    keep.unshift(out[i])
  }
  return keep
}

function fmtDay(list) {
  const d = new Date()
  return list.map((x) => {
    const t = new Date(x.at)
    return `${pad(t.getHours())}:${pad(t.getMinutes())} ${x.role}：${x.text.replace(/\s+/g, ' ').slice(0, 200)}`
  }).join('\n')
}

// 在所有会话里按关键词找原话
function findInSessions(query, days = 14, limit = 8, skipSessions = new Set()) {
  const since = Date.now() - days * 86400000
  const q = String(query || '').trim()
  if (!q) return []
  const out = []
  let dirs = []
  try { dirs = readdirSync(SESSIONS) } catch { return out }
  for (const proj of dirs) {
    let ids = []
    try { ids = readdirSync(join(SESSIONS, proj)) } catch { continue }
    for (const sid of ids) {
      if (skipSessions.has(sid)) continue
      const f = join(SESSIONS, proj, sid, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      let text = ''
      try { text = zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (line.indexOf('"message"') < 0) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        const t = Number(j.time) || 0
        if (t < since) continue
        const d2 = j.data || {}
              const msg = d2.message || d2
        const parts = Array.isArray(msg.content) ? msg.content : []
        const body = parts.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ').trim()
        if (!body || body.indexOf(q) < 0) continue
        out.push({ at: t, role: msg.role || '?', text: body.slice(0, 300), chat: proj.replace(/^--|--$/g, '').replace(/-/g, '/') })
        if (out.length >= limit * 4) break
      }
    }
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, limit)
}


// 会话 → chatId 映射（会话文件本身不带 chatId，只能问 self-inspect）
async function sessionChatMap() {
  const map = new Map()
  try {
    const r = await fetch('http://127.0.0.1:5043/aurabot/api/ext/self-inspect/sessions', { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    for (const x of (j.list || [])) if (x.sessionId && x.chatId) map.set(String(x.sessionId), String(x.chatId))
  } catch {}
  return map
}
function isOwnerPrivate(chatId, owner) { return String(chatId) === 'private:' + String(owner) }
function isOtherPrivate(chatId, owner) {
  const c = String(chatId || '')
  return c.startsWith('private:') && !isOwnerPrivate(c, owner)
}

export default {
  id: 'world',
  name: '世界',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '她的日子：每天 23 点回顾写日记、改写自我叙事，能按原话翻旧账。',
  defaults: { enabled: true, reviewHour: 23, injectSelf: true, keepDiaryDays: 365 },
  setup(api) {
    ensure()
    const stats = { lastReviewAt: 0, lastReviewDay: '', reviews: 0, lastError: '', running: false }

    async function review(force = false) {
      if (stats.running) return { ok: false, message: '上一轮回顾还没结束' }
      stats.running = true
      try {
        const today = dayKey()
        const startMs = new Date(`${today}T00:00:00`).getTime()
        const owner = String(api.config().ownerQQ || '')
        const chatMap = await sessionChatMap()
        // fail-closed：拿不到映射就跳过，绝不把别人的私聊混进日记
        if (!chatMap.size) { stats.lastError = '拿不到会话映射，本次回顾跳过'; return { ok: false, message: '拿不到会话映射，本次回顾跳过' } }
        const skip = new Set()
        for (const [sid, chatId] of chatMap) if (isOtherPrivate(chatId, owner)) skip.add(sid)
        const list = collectDay(startMs, 14000, skip)
        if (!list.length && !force) { stats.lastError = '今天没有说话，跳过'; return { ok: false, message: '今天没有聊天，不用回顾' } }
        const day = fmtDay(list)
        const old = readSelf()
        const prev = listDiary(2).filter((x) => x.date !== today).map((x) => {
          const t = readDiary(x.date); return t ? `${x.date}：${t.slice(0, 300)}` : ''
        }).filter(Boolean).join('\n')

        const diaryPrompt = `现在是夜里。用你自己的身份，写今天的日记。
要求：第一人称，200-400 字，写具体发生过的事、你自己的心情和想法；不要罗列，不要写成汇报，不要提"作为AI"。
只输出日记正文，不要标题。

今天你们的对话（按时间）：
${day.slice(0, 12000)}
${prev ? `\n前几天的日记（参考语气，别重复内容）：\n${prev}` : ''}`

        let diary = ''
        try {
          diary = String(await api.core.hub.runSystemTurn('world-diary', '写今天的日记', diaryPrompt, { noTools: true, timeoutMs: 180000 }) || '').trim()
        } catch (e) {
          stats.lastError = '日记失败：' + String(e.message || e)
          return { ok: false, message: stats.lastError }
        }
        if (!diary) return { ok: false, message: '没写出来' }
        writeFileSync(join(DIARY, `${today}.md`), diary)
        stats.lastReviewAt = Date.now()
        stats.lastReviewDay = today
        stats.reviews += 1

        // 更新自我叙事
        try {
          const selfPrompt = `基于今天和最近的生活，改写一段"我是谁"。第一人称，150-300 字，写你的性格、在意什么、最近的变化；不要写具体日程。
只输出正文。
${old ? `\n你现在的自述：\n${old.slice(0, 1200)}` : ''}
\n今天的日记：\n${diary.slice(0, 1200)}`
          const next = String(await api.core.hub.runSystemTurn('world-self', '更新自我叙事', selfPrompt, { noTools: true, timeoutMs: 120000 }) || '').trim()
          if (next && next.length > 40) writeSelf(next)
        } catch (e) { stats.lastError = '自述失败：' + String(e.message || e) }

        api.log.info?.(`世界：${today} 的日记写好了（${diary.length} 字）`)
        return { ok: true, date: today, chars: diary.length, diary }
      } finally {
        stats.running = false
      }
    }

    // 到点自动回顾
    api.every(300000, () => {
      try {
        const hour = Number(api.settings().reviewHour)
        const now = new Date()
        const today = dayKey(now)
        if (now.getHours() < hour) return
        if (stats.lastReviewDay === today) return
        if (existsSync(join(DIARY, `${today}.md`))) { stats.lastReviewDay = today; return }
        review().catch(() => {})
      } catch {}
    }, '每日回顾')

    // 工具：翻旧账
    api.tool((where) => {
      if (!where || where.level !== 'full') return []
      return api.defineTool({
      name: 'memory_find',
      description: '在过去的聊天原文里按关键词找原话。想不起谁说过什么、想引用原话时用。',
      properties: { query: { type: 'string', description: '要找的词或短语' }, days: { type: 'number', description: '往前找多少天，默认 14' } },
      required: ['query'],
      execute: async ({ query, days }) => {
        const owner = String(api.config().ownerQQ || '')
        const chatMap = await sessionChatMap()
        if (!chatMap.size) return { ok: false, message: '拿不到会话映射，先不翻了（避免翻到别人的私聊）' }
        const skip = new Set()
        for (const [sid, chatId] of chatMap) if (isOtherPrivate(chatId, owner)) skip.add(sid)
        const list = findInSessions(query, Number(days) || 14, 8, skip)
        if (!list.length) return { ok: true, message: `最近没找到「${query}」` }
        return {
          ok: true,
          message: list.map((x) => `${new Date(x.at).toLocaleString('zh-CN')} ${x.role === 'user' ? '对方' : '我'}：${x.text.slice(0, 120)}`).join('\n'),
        }
      },
      })
    })

    api.tool((where) => {
      if (!where || where.level !== 'full') return []
      return api.defineTool({
      name: 'memory_read',
      description: '读某天的日记（自己写的）。想知道以前的日子发生过什么时用。不给日期就看最近一篇。',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD，可省略' } },
      required: [],
      execute: async ({ date }) => {
        const list = listDiary(30)
        const want = String(date || '').trim() || (list[0] && list[0].date)
        if (!want) return { ok: true, message: '还没写过日记' }
        const text = readDiary(want)
        if (!text) return { ok: false, message: `${want} 没有日记，写过的是：${list.slice(0, 5).map((x) => x.date).join('、')}` }
        return { ok: true, message: `${want} 的日记：\n${text.slice(0, 1200)}` }
      },
      })
    })

    // 上下文：自述 + 最近日记（都很短，避免撑爆）
    api.context(({ chat } = {}) => {
      try {
        if (!api.settings().injectSelf) return ''
        const ownerQQ = String(api.config().ownerQQ || '')
        if (!chat || chat.kind !== 'private' || String(chat.userId || '') !== ownerQQ) return ''
        const self = readSelf()
        const last = listDiary(1)[0]
        const diary = last ? readDiary(last.date) : ''
        const parts = []
        if (self) parts.push(`（你对自己的认识：${self.replace(/\s+/g, ' ').slice(0, 320)}）`)
        if (diary) parts.push(`（${last.date} 你写的日记：${diary.replace(/\s+/g, ' ').slice(0, 320)}）`)
        return parts.join('\n')
      } catch { return '' }
    })

    api.route('/state', async () => ({
      ok: true, ...stats, self: readSelf().slice(0, 2000), diaries: listDiary(14),
      today: dayKey(), settings: api.settings(),
    }))
    api.route('/diary', async (req) => {
      const date = String(api.core.http.query(req).date || '').trim() || (listDiary(1)[0] || {}).date || ''
      return { ok: true, date, text: date ? readDiary(date) : '' }
    })
    api.route('/run', async () => await review(true))
    api.route('/find', async (req) => {
      const q = String(api.core.http.query(req).q || '')
      return { ok: true, list: findInSessions(q, Number(api.core.http.query(req).days) || 14, 10) }
    })
    api.route('/self', async () => ({ ok: true, text: readSelf(), versions: (() => {
      try { return readdirSync(VERS).length } catch { return 0 }
    })() }))

    api.command({ name: '日记', desc: '/日记 —— 看她最近写的日记', run: async () => {
      const last = listDiary(1)[0]
      if (!last) return '还没写过日记'
      return `${last.date}：\n${readDiary(last.date).slice(0, 500)}`
    } })

    api.rule('你有自己的日子：每天夜里你会写日记，日记里的事是真实的（来自你们的聊天）。聊到以前的事时，可以调 memory_find 翻原话、memory_read 看日记；别编造日记里没有的事。')
    api.log.info?.('世界已就绪（日记 + 自我叙事 + 每日回顾）')
  },
}