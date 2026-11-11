// 梗百科：6792 条本地词库（来自 MIT 许可的 astrbot_plugin_memewiki / cnmeme.wiki）。
// 她遇到不认识的缩写、网络梗、黑话时查这里，不硬猜。

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const DB = DSH + '/plugins-data/aurabot/modules-data/memewiki/memes.db'

let db = null
function open() {
  if (db) return db
  if (!existsSync(DB)) throw new Error('词库文件不在：' + DB)
  db = new DatabaseSync(DB, { readOnly: true })
  return db
}

function fmt(r) {
  const parts = [`【${r.title}】`]
  if (r.aliases) parts.push(`别名：${r.aliases}`)
  if (r.summary) parts.push(String(r.summary).replace(/^来源\s*/, '来源：').slice(0, 600))
  if (r.usage) parts.push(`用法：${String(r.usage).slice(0, 200)}`)
  if (r.tags) parts.push(`标签：${r.tags}`)
  return parts.join('\n')
}

function lookup(word) {
  const d = open()
  const w = String(word || '').trim()
  if (!w) return null
  const exact = d.prepare('select * from memes where title = ? limit 1').get(w)
  if (exact) return exact
  const byAlias = d.prepare("select * from memes where aliases like ? limit 1").get('%' + w + '%')
  if (byAlias) return byAlias
  const fuzzy = d.prepare('select * from memes where title like ? order by length(title) limit 1').get('%' + w + '%')
  return fuzzy || null
}

function search(kw, limit = 8) {
  const d = open()
  const k = '%' + String(kw || '').trim() + '%'
  return d.prepare('select title,tags,substr(summary,1,80) as s from memes where title like ? or aliases like ? or summary like ? limit ?').all(k, k, k, limit)
}


// ---------- 群内自定义黑话 ----------
function openRW() {
  const d = new DatabaseSync(DB)
  d.exec('create table if not exists slang (gid text, word text, meaning text, by text, at integer, primary key (gid, word))')
  return d
}
function slangGet(gid, word) {
  try {
    const d = open()
    d.exec('create table if not exists slang (gid text, word text, meaning text, by text, at integer, primary key (gid, word))')
    return d.prepare('select * from slang where gid = ? and word = ?').get(String(gid), String(word)) || null
  } catch { return null }
}
function slangList(gid) {
  try {
    const d = open()
    d.exec('create table if not exists slang (gid text, word text, meaning text, by text, at integer, primary key (gid, word))')
    return d.prepare('select * from slang where gid = ? order by at desc').all(String(gid))
  } catch { return [] }
}
function slangPut(gid, word, meaning, by) {
  const d = openRW()
  try {
    d.prepare('insert into slang (gid,word,meaning,by,at) values (?,?,?,?,?) on conflict(gid,word) do update set meaning=excluded.meaning, by=excluded.by, at=excluded.at').run(String(gid), String(word), String(meaning), String(by || ''), Date.now())
    return true
  } finally { d.close() }
}
function slangDel(gid, word) {
  const d = openRW()
  try { const r = d.prepare('delete from slang where gid = ? and word = ?').run(String(gid), String(word)); return r.changes > 0 } finally { d.close() }
}

export default {
  id: 'memewiki',
  name: '梗百科',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '6792 条本地网络梗词库（MIT）。她不认识的缩写、梗、黑话查这里，别硬猜。',
  setup(api) {
    const stats = { lookups: 0, hits: 0, misses: 0, lastWord: '', lastAt: 0 }


    // ---------- 自动预查：消息里出现"梗"就提前查好，塞进上下文 ----------
    const pendingPick = new Map()   // chatId -> { line, at, word }
    const prefetchStats = { checked: 0, hit: 0, miss: 0, lastWord: '' }

    function extractTerm(text) {
      const t = String(text || '').trim()
      if (!t || t.length > 60) return null
      const pats = [
        /([^\s，。？！、,.?!：:]{2,10}?)\s*(?:是什么梗|什么梗|是啥梗|啥梗|是什么来头)/,
        /([^\s，。？！、,.?!：:]{2,10}?)\s*(?:是什么意思|啥意思|什么意思)/,
        /梗\s*[:：]\s*([^\s，。？！]{2,10})/,
        /“([^”]{2,10})”\s*(?:是|什么|意思)/,
      ]
      for (const p of pats) {
        const m = t.match(p)
        if (m && m[1]) return { term: m[1].replace(/[的了呢啊吧呀]+$/, ''), asked: true }
      }
      if (/^[^\s，。？！、,.?!]{2,6}$/.test(t) && !/^(哈哈+|嗯+|好+|在吗|你好|晚安|早安|行|对|是)/.test(t)) return { term: t, asked: false }
      return null
    }

    api.on('message', (msg) => {
      try {
        if (!msg || !msg.text || !msg.chatId) return
        const picked = extractTerm(msg.text)
        if (!picked) return
        const { term, asked } = picked
        prefetchStats.checked += 1
        prefetchStats.lastWord = term
        const gid = msg.groupId ? String(msg.groupId) : ''
        let body = ''
        let src = ''
        if (gid) {
          const row = slangGet(gid, term)
          if (row && row.meaning) { body = String(row.meaning); src = '本群黑话' }
        }
        if (!body) {
          const r = lookup(term)
          if (r && r.summary) { body = String(r.summary); src = '梗百科' }
        }
        if (!body) {
          prefetchStats.miss += 1
          // 明确在问梗却没收录：提示她别硬编（短词不提示，免得太吵）
          if (asked) pendingPick.set(msg.chatId, { word: term, line: `【${term}】词库里没收录，别硬编含义，可以说你不认识或者反问对方`, at: Date.now() })
          return
        }
        prefetchStats.hit += 1
        const short = body.replace(/^来源\s*/, '').replace(/\s+/g, ' ').slice(0, 260)
        pendingPick.set(msg.chatId, { word: term, line: `【${term}】（${src}）${short}`, at: Date.now() })
      } catch {}
    })

    api.context(({ chat }) => {
      try {
        const p = pendingPick.get(chat.chatId)
        if (!p) return ''
        if (Date.now() - p.at > 120000) { pendingPick.delete(chat.chatId); return '' }
        pendingPick.delete(chat.chatId)   // 只用一次
        return `（梗百科预查，参考用，别照念、更别说"我查了词库"：\n${p.line}）`
      } catch { return '' }
    })

    api.tool(({ chat }) => api.defineTool({
      name: 'meme_lookup',
      description: '查网络梗/缩写/黑话是什么意思。看到不认识的词、缩略语、流行语时先查这里，别猜。',
      properties: { word: { type: 'string', description: '要查的词' }, gid: { type: 'string', description: '群号（可选），有的话先查这个群的黑话' } },
      required: ['word'],
      execute: async ({ word }) => {
        const gid = (chat && chat.groupId) ? String(chat.groupId) : ''
        stats.lookups += 1; stats.lastWord = String(word || ''); stats.lastAt = Date.now()
        try {
          if (gid) { const sl = slangGet(gid, word); if (sl) { stats.hits += 1; return { ok: true, message: `【${sl.word}】（本群黑话）\n${sl.meaning}` } } }
          const r = lookup(word)
          if (!r) { stats.misses += 1; return { ok: false, message: `词库里没有「${word}」，可以照实说不认识` } }
          stats.hits += 1
          return { ok: true, message: fmt(r) }
        } catch (e) { return { ok: false, message: '查词失败：' + String(e.message || e).slice(0, 100) } }
      },
    }))

    api.tool(() => api.defineTool({
      name: 'meme_search',
      description: '按关键词在梗词库里搜一批相关词条（不知道确切写法时用）。',
      properties: { keyword: { type: 'string', description: '关键词' }, limit: { type: 'number', description: '默认 8' } },
      required: ['keyword'],
      execute: async ({ keyword, limit }) => {
        try {
          const list = search(keyword, limit || 8)
          if (!list.length) return { ok: false, message: `没搜到「${keyword}」相关的词条` }
          return { ok: true, message: list.map((x) => `• ${x.title}：${x.s}`).join('\n') }
        } catch (e) { return { ok: false, message: '搜索失败：' + String(e.message || e).slice(0, 100) } }
      },
    }))

    api.command({ name: '梗', desc: '/梗 <词> —— 查梗百科', run: async (arg) => {
      const r = lookup(arg)
      if (!r) return `词库里没有「${arg}」`
      return fmt(r).slice(0, 800)
    } })


    api.command({ name: '黑话', desc: '/黑话 词 释义 | /黑话 列表 | /黑话 删除 词', run: async (arg, msg) => {
      const gid = msg && msg.groupId ? String(msg.groupId) : ''
      const t = String(arg || '').trim()
      if (!gid) return '黑话只在群里用'
      if (!t || t === '列表') {
        const list = slangList(gid)
        if (!list.length) return '这个群还没有自定义黑话'
        return list.map((x) => `${x.word}：${String(x.meaning).slice(0, 60)}`).join('\n').slice(0, 1200)
      }
      if (t.startsWith('删除 ')) {
        const w = t.slice(3).trim()
        return slangDel(gid, w) ? `删掉了「${w}」` : `没有「${w}」`
      }
      const m = t.match(/^(\S+)\s+([\s\S]+)$/)
      if (!m) return '用法：/黑话 词 释义'
      slangPut(gid, m[1], m[2], msg && msg.userId)
      return `记下了本群黑话「${m[1]}」`
    } })

    api.route('/prefetch', async () => ({
      ok: true,
      ...prefetchStats,
      pending: [...pendingPick.entries()].map(([k, v]) => ({ chatId: k, word: v.word, line: String(v.line).slice(0, 160), at: v.at })),
    }))

    api.route('/state', async () => {
      let total = 0
      try { total = open().prepare('select count(*) c from memes').get().c } catch {}
      return { ok: true, total, ...stats }
    })
    api.route('/lookup', async (req) => {
      const ip = String((req.socket && req.socket.remoteAddress) || '')
      if (!/(127\.0\.0\.1|::1|10\.6\.0\.11)/.test(ip)) return { ok: false, message: '只能本机调用' }

      const q = api.core.http.query(req)
      const w = String(q.w || '')
      if (q.gid) { const sl = slangGet(q.gid, w); if (sl) return { ok: true, entry: sl, slang: true } }
      const r = lookup(w)
      return r ? { ok: true, entry: r } : { ok: false, message: '没有这个词' }
    })
    api.route('/slang', async (req) => {
      const ip = String((req.socket && req.socket.remoteAddress) || '')
      if (!/(127\.0\.0\.1|::1|10\.6\.0\.11)/.test(ip)) return { ok: false, message: '只能本机调用' }

      const q = api.core.http.query(req)
      if (q.gid && q.w) { const s2 = slangGet(q.gid, q.w); return s2 ? { ok: true, entry: s2 } : { ok: false } }
      if (q.gid) return { ok: true, list: slangList(q.gid) }
      return { ok: false, message: '要给 gid' }
    })
    api.route('/search', async (req) => {
      const ip = String((req.socket && req.socket.remoteAddress) || '')
      if (!/(127\.0\.0\.1|::1|10\.6\.0\.11)/.test(ip)) return { ok: false, message: '只能本机调用' }

      const k = String(api.core.http.query(req).q || '')
      return { ok: true, list: search(k, Number(api.core.http.query(req).limit) || 10) }
    })

    api.rule('群里有人说你不认识的词时，可以先用 meme_lookup 带上群号 gid 查本群黑话，再查通用词库。遇到不认识的网络梗、缩写、黑话（比如 yyds、绝绝子、city不city 这类）时，先用 meme_lookup 查一下再回应；查不到就照实说不认识，别硬编含义。')
    api.log.info?.('梗百科已就绪（6792 条）')
  },
}
