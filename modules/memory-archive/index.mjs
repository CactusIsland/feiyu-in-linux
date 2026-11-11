// 全量存档 —— 用户模块（Aurabot 扩展接口 v1）
//
// 目的：聊天流水会在 04:00 / 16:00 整理后被删，长期记忆遗忘时也只留摘要。
// 这里在插件外面再留一份 append-only 的原文档案：
//  - 收到 / 发出的每条消息都写进 modules-data/memory-archive/YYYY-MM.jsonl；
//  - 永远不删、不改，按月分片；
//  - 支持按关键词、聊天、时间范围回查；
//  - 主人私聊里给她一个 memory_archive_search 工具，想不起旧事时自己查。
//
// 存什么由她自己决定：这里只负责「原话留底」，不替她判断哪句重要。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/

function monthKey(at) {
  const d = new Date(Number(at) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function whenText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return `${md} ${hh}:${mm}`
  return `${d.getFullYear()}-${md} ${hh}:${mm}`
}

function hash(...parts) {
  return createHash('sha1').update(parts.map((x) => String(x ?? '')).join('\u0001')).digest('hex').slice(0, 20)
}

function chatLabel(chatId) {
  const s = String(chatId || '')
  if (s.startsWith('private:')) return '私聊'
  if (s.startsWith('group:')) return '群'
  if (s.startsWith('legacy:')) return '旧会话'
  return '聊天'
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

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-archive',
  name: '全量存档',
  version: '1.0.0',
  api: 1,
  description: '每条聊天原文都留底，按月分片，永不删除；可按关键词回查',

  defaults: {
    enabled: true,
    archiveSystemChats: false,
    searchMonths: 12,
    maxSearchResults: 8,
  },

  settings: [
    { key: 'enabled', label: '开启全量存档', type: 'switch' },
    { key: 'archiveSystemChats', label: '也存系统回合', type: 'switch', hint: 'system: 开头的内部回合（主动搭话、日记等），默认不存' },
    { key: 'searchMonths', label: '默认回查几个月', type: 'number', min: 1, max: 60, step: 1 },
    { key: 'maxSearchResults', label: '一次最多返回几条', type: 'number', min: 1, max: 30, step: 1 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const metaFile = () => join(dir, 'meta.json')
    const monthFile = (at) => join(dir, monthKey(at) + '.jsonl')

    const readMeta = () => {
      try { return JSON.parse(readFileSync(metaFile(), 'utf8')) || {} } catch (error) { return {} }
    }
    let meta = { version: 1, startedAt: Date.now(), lastAt: 0, totalEvents: 0, months: {}, ...readMeta() }
    let dirty = false
    const flushMeta = () => {
      if (!dirty) return
      try { writeFileSync(metaFile(), JSON.stringify(meta, null, 2)) } catch (error) { api.log.warn('存档 meta 写入失败：' + error.message) }
      dirty = false
    }

    const recentIds = new Set()

    function append(event = {}) {
      if (!api.settings().enabled) return null
      const chatId = String(event.chatId || '')
      if (!chatId) return null
      if (chatId.startsWith('system:') && !api.settings().archiveSystemChats) return null
      const kind = event.kind === 'out' ? 'out' : 'in'
      const text = String((kind === 'out' ? event.reply ?? event.text : event.text) ?? '').trim()
      if (!text) return null

      const at = Number(event.at) || Date.now()
      const userId = String(event.userId ?? event.uid ?? '')
      const groupId = String(event.groupId ?? (chatId.startsWith('group:') ? chatId.slice(6) : ''))
      const nickname = String(event.nickname ?? (kind === 'out' ? '她' : ''))
      const id = event.id
        ? String(event.id)
        : event.messageId
          ? 'm:' + hash(event.messageId)
          : 'h:' + hash(at, chatId, kind, userId, text)
      if (recentIds.has(id)) return null

      const row = {
        v: 1,
        id,
        at,
        chatId,
        channel: String(event.channel || 'qq'),
        kind,
        userId,
        nickname,
        groupId,
        owner: Boolean(event.owner),
        direct: Boolean(event.direct),
        text,
        messageId: String(event.messageId || ''),
        userText: String(event.userText || ''),
      }
      try {
        appendFileSync(monthFile(at), JSON.stringify(row) + '\n')
      } catch (error) {
        api.log.warn('写全量存档失败：' + error.message)
        return null
      }
      recentIds.add(id)
      if (recentIds.size > 5000) {
        // 只需要挡住短时间内的重复事件，清掉最老的一半
        const keep = [...recentIds].slice(-2500)
        recentIds.clear()
        for (const x of keep) recentIds.add(x)
      }
      meta.lastAt = Math.max(Number(meta.lastAt) || 0, at)
      meta.totalEvents = (Number(meta.totalEvents) || 0) + 1
      const mk = monthKey(at)
      meta.months = meta.months || {}
      meta.months[mk] = (Number(meta.months[mk]) || 0) + 1
      dirty = true
      if ((meta.totalEvents + 0) % 50 === 0) flushMeta()
      return row
    }

    // 收到的消息 / 她发出去的话，都经过 activity
    api.on('activity', (a) => {
      try { append(a) } catch (error) { api.log.warn('activity 存档失败：' + error.message) }
    })

    // 微信桥接（wechat-link）用这个事件把微信原话也写进来
    api.on('memory-archive/ingest', (e) => {
      try { append({ ...e, channel: e?.channel || 'wechat' }) } catch (error) { api.log.warn('微信存档失败：' + error.message) }
    })

    const monthFiles = () => {
      try {
        return readdirSync(dir).filter((f) => MONTH_FILE.test(f)).sort()
      } catch (error) { return [] }
    }

    /** 最近 n 个月的月份文件名；n=0 表示全部。 */
    function filesForMonths(n) {
      const files = monthFiles()
      const count = Math.max(0, Math.min(60, Number(n) || 0))
      if (!count) return files
      const keep = []
      const now = new Date()
      for (let i = 0; i < count; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        keep.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`)
      }
      return keep.filter((f) => files.includes(f)).sort()
    }

    function readRows(files, onRow) {
      for (const f of files) {
        let text = ''
        try { text = readFileSync(join(dir, f), 'utf8') } catch (error) { continue }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line)
            if (row && row.text) onRow(row)
          } catch (error) {}
        }
      }
    }

    function search(query, o = {}) {
      const q = String(query || '').trim()
      const limit = Math.max(1, Math.min(30, Number(o.limit) || api.settings().maxSearchResults || 8))
      const months = Math.max(1, Math.min(60, Number(o.months) || api.settings().searchMonths || 12))
      const chat = String(o.chat || '')
      const kind = String(o.kind || '')
      const files = filesForMonths(months)
      const qLower = q.toLowerCase()
      const qTerms = termsOf(q)
      if (!qTerms.length) return []
      const hits = []
      readRows(files, (row) => {
        if (chat && row.chatId !== chat) return
        if (kind && row.kind !== kind) return
        const text = String(row.text || '')
        const lower = text.toLowerCase()
        let score = 0
        if (qLower && lower.includes(qLower)) score += 8
        for (const t of qTerms) {
          if (lower.includes(t)) score += 1
          const who = String(row.nickname || '').toLowerCase()
          if (who.includes(t)) score += 2
        }
        if (score <= 0) return
        hits.push({ ...row, score, when: whenText(row.at) })
      })
      hits.sort((a, b) => b.score - a.score || b.at - a.at)
      // 同一条消息可能在 chatlog 和旧会话里各出现一次；短句只差截断长度时合并成一条
      const norm = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
      const kept = []
      for (const h of hits) {
        const hText = norm(h.text)
        const dup = kept.find((k) => {
          const kText = norm(k.text)
          return k.chatId === h.chatId && k.nickname === h.nickname
            && (kText === hText
              || (hText.length >= 6 && kText.startsWith(hText))
              || (kText.length >= 6 && hText.startsWith(kText)))
        })
        if (dup) {
          if (String(h.text).length > String(dup.text).length) Object.assign(dup, h)
          continue
        }
        kept.push(h)
        if (kept.length >= limit) break
      }
      return kept
    }

    function recent(limit = 10) {
      const files = filesForMonths(2)
      const hits = []
      readRows(files, (row) => hits.push({ ...row, when: whenText(row.at) }))
      hits.sort((a, b) => b.at - a.at)
      return hits.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
    }

    /** 最早一条满足条件的原始记录（用于初次相遇）。 */
    function earliest(predicate) {
      let best = null
      readRows(monthFiles(), (row) => {
        if (typeof predicate === 'function' && !predicate(row)) return
        if (!best || Number(row.at) < Number(best.at)) best = row
      })
      return best
    }

    /** 某个时间段里的原始记录，按时间正序（用于最初 30 天）。 */
    function rowsBetween(from, to, predicate) {
      const out = []
      readRows(monthFiles(), (row) => {
        const at = Number(row.at) || 0
        if (at < Number(from) || at > Number(to)) return
        if (typeof predicate === 'function' && !predicate(row)) return
        out.push(row)
      })
      out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
      return out
    }

    function stats() {
      const months = []
      let totalBytes = 0
      let totalRows = 0
      for (const f of monthFiles()) {
        let size = 0
        let rows = 0
        try {
          size = statSync(join(dir, f)).size
          rows = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length
        } catch (error) {}
        totalBytes += size
        totalRows += rows
        months.push({ month: f.replace(/\.jsonl$/, ''), rows, bytes: size })
      }
      return {
        ok: true,
        dir,
        totalRows,
        totalBytes,
        months,
        meta: { startedAt: meta.startedAt, lastAt: meta.lastAt, totalEvents: meta.totalEvents },
      }
    }

    /** 把旧 chatlog/*.jsonl 导进存档；按 id 去重，可重复执行。 */
    function importChatlog() {
      const base = join(dir, '..', '..')
      const chatlogDir = join(base, 'chatlog')
      if (!existsSync(chatlogDir)) return { ok: false, message: '没有 chatlog 目录' }
      const seen = new Set()
      readRows(monthFiles(), (row) => { if (row.id) seen.add(row.id) })
      let added = 0
      let skipped = 0
      for (const f of readdirSync(chatlogDir).filter((x) => x.endsWith('.jsonl'))) {
        let text = ''
        try { text = readFileSync(join(chatlogDir, f), 'utf8') } catch (error) { continue }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          let x = null
          try { x = JSON.parse(line) } catch (error) { continue }
          if (!x || !x.text || !x.chatId) continue
          const kind = (x.who === 'bot' || x.who === '她') ? 'out' : 'in'
          const id = 'h:' + hash(x.t, x.chatId, kind, x.uid || '', x.text)
          if (seen.has(id)) { skipped++; continue }
          const row = append({
            id,
            at: Number(x.t) || Date.now(),
            chatId: x.chatId,
            channel: 'qq',
            kind,
            userId: x.uid || '',
            nickname: kind === 'out' ? '她' : (x.who || ''),
            text: x.text,
            owner: String(x.uid || '') === String(api.config().ownerQQ || ''),
            direct: x.chatId === `private:${api.config().ownerQQ}`,
          })
          if (row) { seen.add(id); added++ } else skipped++
        }
      }
      flushMeta()
      api.log.info(`全量存档导入 chatlog：新增 ${added} 条，跳过 ${skipped} 条`)
      return { ok: true, added, skipped, ...stats() }
    }

    api.route('/stats', async () => stats())
    api.route('/recent', async (req) => ({ ok: true, items: recent(Number(api.core.http.query(req).limit) || 10) }))
    api.route('/search', async (req) => {
      const q = api.core.http.query(req)
      return {
        ok: true,
        query: String(q.q || ''),
        items: search(String(q.q || ''), {
          limit: Number(q.limit) || undefined,
          months: Number(q.months) || undefined,
          chat: String(q.chat || ''),
          kind: String(q.kind || ''),
        }),
      }
    })
    api.route('/import/chatlog', async () => importChatlog())
    api.route('/import/rows', async (req) => {
      const b = await api.core.http.body(req)
      const rows = Array.isArray(b?.rows) ? b.rows : []
      let added = 0
      let skipped = 0
      for (const r of rows.slice(0, 3000)) {
        if (!r || !r.text || !r.chatId) { skipped++; continue }
        const row = append({
          ...r,
          channel: r.channel || 'legacy',
          kind: r.kind === 'out' ? 'out' : 'in',
        })
        if (row) added++
        else skipped++
      }
      flushMeta()
      api.log.info(`导入存档：新增 ${added} 条，跳过 ${skipped} 条`)
      return { ok: true, added, skipped, totalRows: stats().totalRows }
    })

    api.command({
      name: '存档',
      desc: '看全量存档有多少条、占多大；/存档 导入 把旧聊天流水补进来',
      run: async (arg) => {
        if (String(arg || '').trim() === '导入') {
          const r = importChatlog()
          return r.ok ? `导入完成：新增 ${r.added} 条，跳过 ${r.skipped} 条，现在共 ${r.totalRows} 条` : r.message
        }
        const s = stats()
        return `全量存档：${s.totalRows} 条，${(s.totalBytes / 1024).toFixed(1)} KB，${s.months.length} 个月`
      },
    })

    api.tool((where) => {
      if (where.level !== 'full') return []
      return api.defineTool({
        name: 'memory_archive_search',
        description: '翻很久以前的原始聊天存档。对方明确提到过去的人、地点、物品、事件，而你想不起细节时用；不要没事翻旧账，也不要说“我查一下记录”。',
        properties: {
          query: { type: 'string', description: '要找的线索：人名、地点、物品、事件关键词' },
          months: { type: 'number', description: '往回查几个月，默认 12' },
        },
        required: ['query'],
        execute: async ({ query, months }) => {
          const hits = search(String(query || ''), { limit: 8, months: Number(months) || undefined })
          api.log.info(`存档工具查询「${String(query || '')}」：${hits.length} 条`)
          if (!hits.length) return { ok: true, message: '没找到相关的旧记录。' }
          return {
            ok: true,
            message: hits.map((h) => `[${h.when}] ${chatLabel(h.chatId)} ${h.nickname || '她'}：${String(h.text).slice(0, 220)}`).join('\n'),
          }
        },
      })
    })

    api.rule((kind) => (kind === 'private'
      ? '你有一份自己的原始聊天存档。想不起很久以前的事、对方明确提到过去的人/地点/物品时，可以用 memory_archive_search 查；不要没事翻旧账，也不要说“我查一下记录”。'
      : ''))

    api.onDispose(() => flushMeta())
    api.log.info('全量存档已挂上（append-only，按月分片；旧 chatlog 可以用 /存档 导入 补进来）')

    return { append, search, recent, earliest, rowsBetween, stats, importChatlog }
  },
}
