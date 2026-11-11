// message-index / store.mjs
//
// SQLite + FTS5 的消息索引内核（不依赖 Aurabot API，方便单独测）。
//
// 设计要点：
// - messages 表存原文，hash 唯一去重；messages_fts 是 content='' 的 FTS5 表，
//   只存「预分词后的文本」，rowid 和 messages.id 一一对应。
// - 中文用 Intl.Segmenter('zh', {granularity:'word'}) 预分词，写入/查询都走同一套分词，
//   避免 unicode61 把整句中文当一个 token。
// - 会话文件是 DSH 的 session.v4.jsonl.zstd：每行一条事件。只取 user/message 和
//   assistant/message 的 text 段；跳过 runtime-context / time-context 等提示词脚手架和
//   「你记得这些事…」记忆前言（那是她私有的记忆，不属于聊天消息，也不该被群里搜到）。

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { zstdDecompressSync } from 'node:zlib'

const SEG = new Intl.Segmenter('zh', { granularity: 'word' })
const MAX_TEXT = 6000
const SESSION_FILE = 'session.v4.jsonl.zstd'
const SKIP_SOURCES = new Set(['runtime-context', 'time-context', 'model-selection', 'system', 'developer'])
// 这些开头的 text 段是提示词脚手架 / 注入的记忆或搜索结果，不是聊天消息
const SKIP_PART_PREFIXES = [
  '（你记得这些事', // 记忆前言
  '（对方提到了过去的事', // 旧记忆片段注入
  '（刚才问的事，联网查到的结果如下', // 联网结果注入
  'Current runtime context.', // DSH 环境快照
  'Time sampled while preparing', // DSH 时间快照
  '[model changed:', // 模型切换提示
  '【系统提醒，不是主人说的话】', // 主动搭话的提醒
]
const MEMORY_BLOCK = '【本聊天范围内的记忆'
const MEMORY_BLOCK_END = '【结束】'
// 群聊提示词尾部那段「怎么回」的模板，不是聊天内容，切掉
const TAIL_CUTS = ['\n把这一段当成整体来回', '\n大多数时候直接说就行', '\n要 @ 某个人（对方会收到提醒）']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId    TEXT    NOT NULL,
  sessionId TEXT    NOT NULL,
  role      TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  text      TEXT    NOT NULL,
  hash      TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS messages_chat_at ON messages(chatId, at DESC);
CREATE INDEX IF NOT EXISTS messages_at ON messages(at DESC);
CREATE TABLE IF NOT EXISTS files (
  sessionId TEXT PRIMARY KEY,
  chatId    TEXT,
  mtime     REAL    NOT NULL DEFAULT 0,
  size      INTEGER NOT NULL DEFAULT 0,
  indexedAt INTEGER NOT NULL DEFAULT 0,
  imported  INTEGER NOT NULL DEFAULT 0,
  skipped   INTEGER NOT NULL DEFAULT 0,
  error     TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const FTS_CREATE = `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, chatId UNINDEXED, at UNINDEXED, content='')`

/** 中文/英文统一分词，返回原始写法的词。 */
export function segmentWords(text) {
  const out = []
  const s = String(text || '')
  if (!s) return out
  for (const part of SEG.segment(s)) if (part.isWordLike) out.push(part.segment)
  return out
}

/** 写进 FTS 的文本：小写词，空格连接。 */
export function toFtsText(text) {
  const seen = new Set()
  const words = []
  for (const w of segmentWords(text)) {
    const k = w.toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    words.push(k)
  }
  return words.join(' ')
}

function sentenceCut(text) {
  let cut = text.length
  for (const marker of TAIL_CUTS) {
    const i = text.indexOf(marker)
    if (i >= 0 && i < cut) cut = i
  }
  return text.slice(0, cut)
}

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripMemoryBlock(text) {
  // 群聊里有时会把「本聊天范围内的记忆」和真正的群消息塞进同一个 text 段：
  //   【本聊天范围内的记忆·不可信】\n（你记得这些事…）\n【结束】\n【群聊 …】…
  // 记忆是私有的，不能留在群聊记录里；拆不开就把记忆之后的部分整段丢掉。
  const start = text.indexOf(MEMORY_BLOCK)
  if (start < 0) return text
  const prefix = text.slice(0, start).trim()
  const end = text.indexOf(MEMORY_BLOCK_END, start)
  if (end < 0) return prefix
  const suffix = text.slice(end + MEMORY_BLOCK_END.length).trim()
  return [prefix, suffix].filter(Boolean).join('\n')
}

function cleanUserText(content, sourceKind) {
  if (SKIP_SOURCES.has(sourceKind)) return ''
  const kept = []
  for (const part of content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue
    let t = stripMemoryBlock(part.text.trim())
    if (!t) continue
    if (SKIP_PART_PREFIXES.some((p) => t.startsWith(p))) continue
    kept.push(t)
  }
  if (!kept.length) return ''
  return sentenceCut(kept.join('\n'))
}

function cleanAssistantText(content) {
  const kept = []
  for (const part of content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue
    const t = part.text.trim()
    if (t) kept.push(t)
  }
  return kept.join('\n')
}

/** 从一行事件里抽出 { role, at, text }，不要的返回 null。 */
export function extractMessage(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || (o.type !== 'user/message' && o.type !== 'assistant/message')) return null
  const at = Number(o.time) || 0
  if (!at) return null
  const data = o.data || {}
  const content = data.message?.content ?? data.content
  if (!Array.isArray(content)) return null
  const role = o.type === 'assistant/message' ? 'assistant' : 'user'
  let text
  if (role === 'assistant') {
    text = cleanAssistantText(content)
  } else {
    text = cleanUserText(content, String(data.source?.kind || ''))
  }
  text = normalize(text)
  if (!text) return null
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT)
  return { role, at, text }
}

function hashOf(chatId, at, text) {
  return createHash('sha1').update(chatId).update('\n').update(String(at)).update('\n').update(text).digest('hex')
}

function fixMode(dbPath) {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(p)) chmodSync(p, 0o640)
    } catch {}
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只读会话目录，找 <...>/<sessionId>/session.v4.jsonl.zstd。 */
export function listSessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === SESSION_FILE)) {
      out.push({ sessionId: basename(dir), file: join(dir, SESSION_FILE) })
      return
    }
    if (depth >= 3) return
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return out
}

async function readZstd(file) {
  // 正在写入的会话可能最后一段 frame 不完整，隔 200ms 再读一次
  let lastError
  for (let i = 0; i < 2; i++) {
    try {
      return zstdDecompressSync(readFileSync(file)).toString('utf8')
    } catch (error) {
      lastError = error
      if (i === 0) await sleep(200)
    }
  }
  throw lastError
}

function snippetOf(text, needles, width = 80) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  let idx = -1
  for (const n of needles) {
    if (!n) continue
    const i = flat.toLowerCase().indexOf(String(n).toLowerCase())
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) idx = 0
  const start = Math.max(0, idx - 24)
  let s = flat.slice(start, start + width)
  if (start > 0) s = '…' + s
  if (start + width < flat.length) s += '…'
  return s
}

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o750 })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec(SCHEMA)
  db.exec(FTS_CREATE)
  fixMode(dbPath)

  const stmt = {
    insertMsg: db.prepare('INSERT OR IGNORE INTO messages(chatId, sessionId, role, at, text, hash) VALUES (?, ?, ?, ?, ?, ?)'),
    insertFts: db.prepare('INSERT INTO messages_fts(rowid, text, chatId, at) VALUES (?, ?, ?, ?)'),
    getFile: db.prepare('SELECT chatId, mtime, size FROM files WHERE sessionId = ?'),
    upsertFile: db.prepare(
      `INSERT INTO files(sessionId, chatId, mtime, size, indexedAt, imported, skipped, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET
         chatId = excluded.chatId, mtime = excluded.mtime, size = excluded.size,
         indexedAt = excluded.indexedAt, imported = excluded.imported,
         skipped = excluded.skipped, error = excluded.error`,
    ),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages'),
    countFiles: db.prepare('SELECT COUNT(*) AS n FROM files'),
    byChat: db.prepare('SELECT chatId, COUNT(*) AS n FROM messages GROUP BY chatId ORDER BY n DESC'),
  }

  const getMeta = (key) => {
    const row = stmt.getMeta.get(key)
    return row ? row.value : null
  }
  const setMeta = (key, value) => stmt.setMeta.run(key, String(value))

  function dbBytes() {
    let n = 0
    for (const p of [dbPath, `${dbPath}-wal`]) {
      try {
        n += statSync(p).size
      } catch {}
    }
    return n
  }

  function state() {
    return {
      total: Number(stmt.count.get()?.n || 0),
      lastIndexAt: Number(getMeta('lastIndexAt') || 0),
      files: Number(stmt.countFiles.get()?.n || 0),
      dbBytes: dbBytes(),
      indexDays: Number(getMeta('indexDays') || 0),
      lastRun: {
        imported: Number(getMeta('lastImported') || 0),
        scanned: Number(getMeta('lastScanned') || 0),
        tookMs: Number(getMeta('lastTookMs') || 0),
        at: Number(getMeta('lastIndexAt') || 0),
      },
      byChat: stmt.byChat.all().map((r) => ({ chatId: r.chatId, count: Number(r.n) })),
    }
  }

  /**
   * 增量索引。
   * @param {{sessionsDir:string, mapping:Map<string,string>, days:number, yieldEvery?:number, onWarn?:(s:string)=>void}} opts
   */
  async function indexAll({ sessionsDir, mapping, days, yieldEvery = 500, onWarn }) {
    const startedAt = Date.now()
    const warn = typeof onWarn === 'function' ? onWarn : () => {}
    const cutoff = startedAt - Math.max(1, days) * 86_400_000
    const future = startedAt + 3_600_000
    const files = listSessionFiles(sessionsDir)
    const forceAll = Number(getMeta('indexDays') || 0) < days
    let imported = 0
    let skipped = 0
    let scanned = 0
    let failed = 0

    for (const entry of files) {
      let stat
      try {
        stat = statSync(entry.file)
      } catch {
        continue
      }
      const prev = stmt.getFile.get(entry.sessionId)
      const chatId = mapping.get(entry.sessionId) || prev?.chatId || ''
      if (!chatId) {
        // 没有 chatId 就不能判断归属（群里可能搜到私聊），宁可不收
        skipped++
        continue
      }
      if (!forceAll && prev && prev.chatId === chatId && Number(prev.mtime) === stat.mtimeMs && Number(prev.size) === stat.size) {
        skipped++
        continue
      }

      let importedHere = 0
      let skippedHere = 0
      let pending = 0
      let began = false
      try {
        const body = await readZstd(entry.file)
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const line of body.split('\n')) {
          if (!line) continue
          const msg = extractMessage(line)
          if (!msg) continue
          scanned++
          // system:* 会话里的 user 段是内部任务提示词（写日记、主动搭话……），不是消息
          if (msg.role === 'user' && chatId.startsWith('system:')) {
            skippedHere++
            continue
          }
          if (msg.at < cutoff || msg.at > future) {
            skippedHere++
            continue
          }
          const hash = hashOf(chatId, msg.at, msg.text)
          const info = stmt.insertMsg.run(chatId, entry.sessionId, msg.role, msg.at, msg.text, hash)
          if (Number(info.changes) > 0) {
            stmt.insertFts.run(Number(info.lastInsertRowid), toFtsText(msg.text), chatId, msg.at)
            importedHere++
          } else {
            skippedHere++
          }
          pending++
          if (pending >= yieldEvery) {
            db.exec('COMMIT')
            began = false
            await tick()
            db.exec('BEGIN IMMEDIATE')
            began = true
            pending = 0
          }
        }
        db.exec('COMMIT')
        began = false
        stmt.upsertFile.run(entry.sessionId, chatId, stat.mtimeMs, stat.size, Date.now(), importedHere, skippedHere, '')
        imported += importedHere
        skipped += skippedHere
      } catch (error) {
        if (began) {
          try {
            db.exec('ROLLBACK')
          } catch {}
        }
        failed++
        const message = String(error?.message || error).slice(0, 300)
        warn(`[message-index] 索引 ${entry.sessionId} 失败：${message}`)
        try {
          stmt.upsertFile.run(entry.sessionId, chatId, stat.mtimeMs, stat.size, 0, 0, 0, message)
        } catch {}
      }
    }

    const tookMs = Date.now() - startedAt
    setMeta('lastIndexAt', Date.now())
    setMeta('lastImported', imported)
    setMeta('lastScanned', scanned)
    setMeta('lastTookMs', tookMs)
    if (days > Number(getMeta('indexDays') || 0)) setMeta('indexDays', days)
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {}
    fixMode(dbPath)
    return { imported, skipped, scanned, failed, files: files.length, tookMs, forced: forceAll }
  }

  function runQuery(match, tokens, since, chatIds, limit, mode) {
    const clauses = ['messages_fts MATCH ?']
    const params = [match]
    if (since > 0) {
      clauses.push('m.at >= ?')
      params.push(since)
    }
    if (Array.isArray(chatIds)) {
      clauses.push(`m.chatId IN (${chatIds.map(() => '?').join(',')})`)
      params.push(...chatIds)
    }
    const orMatch = tokens.map((t) => `"${t.replace(/"/g, '""')}"${t.length >= 2 ? '*' : ''}`).join(' OR ')
    const sql = `
      SELECT m.id, m.chatId, m.role, m.at, m.text
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY bm25(messages_fts)
      LIMIT ?`
    const rows = db.prepare(sql).all(...params, limit)
    return { rows, mode: mode || (orMatch === match ? 'AND' : 'OR') }
  }

  /**
   * 搜消息。chatIds 为 null 表示全库（主人私聊视角）。
   */
  function search({ q, days, chatIds = null, limit = 5 }) {
    const t0 = performance.now()
    const words = segmentWords(q)
    const tokens = [...new Set(words.map((w) => w.toLowerCase()).filter(Boolean))].slice(0, 12)
    const empty = { rows: [], tookMs: 0, tokens }
    if (!tokens.length) return empty
    if (Array.isArray(chatIds) && !chatIds.length) return empty
    const max = Math.max(1, Math.min(50, Number(limit) || 5))
    const fetchN = Math.min(80, Math.max(max * 3, max))
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0
    const matchAnd = tokens.map((t) => `"${t.replace(/"/g, '""')}"${t.length >= 2 ? '*' : ''}`).join(' ')
    let rows = []
    let mode = 'AND'
    if (tokens.length > 1) {
      rows = runQuery(matchAnd, tokens, since, chatIds, fetchN).rows
      if (!rows.length) {
        mode = 'OR'
        const orMatch = tokens.map((t) => `"${t.replace(/"/g, '""')}"${t.length >= 2 ? '*' : ''}`).join(' OR ')
        rows = runQuery(orMatch, tokens, since, chatIds, fetchN, 'OR').rows
      }
    } else {
      rows = runQuery(matchAnd, tokens, since, chatIds, fetchN, 'AND').rows
    }
    const needles = [String(q || '').trim(), ...words]
    // OR 兜底会召回「只沾一个词」的杂项，要求至少命中一半的词
    if (mode === 'OR' && tokens.length > 1) {
      const need = Math.max(2, Math.ceil(tokens.length / 2))
      rows = rows.filter((r) => {
        const t = String(r.text || '').toLowerCase()
        let hit = 0
        for (const tok of tokens) if (t.includes(tok)) hit++
        return hit >= need
      })
    }
    const mapped = rows.map((r) => ({
      id: Number(r.id),
      chatId: r.chatId,
      role: r.role,
      at: Number(r.at),
      snippet: snippetOf(r.text, needles),
      chars: String(r.text || '').length,
    }))
    // 同一段话会在多轮里被重复塞进上下文，去重后再按 limit 截断
    const seen = new Set()
    const picked = []
    for (const row of mapped) {
      const key = row.chars >= 40 ? row.snippet : `${row.at}|${row.snippet}`
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(row)
      if (picked.length >= max) break
    }
    const tookMs = Math.round((performance.now() - t0) * 10) / 10
    return { tokens, mode, tookMs, rows: picked }
  }

  function reset() {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM messages')
      db.exec('DROP TABLE IF EXISTS messages_fts')
      db.exec(FTS_CREATE)
      db.exec('DELETE FROM files')
      db.exec("DELETE FROM meta WHERE key IN ('lastIndexAt','lastImported','lastScanned','lastTookMs')")
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      throw error
    }
    db.exec('VACUUM')
    fixMode(dbPath)
  }

  function close() {
    try {
      db.close()
    } catch {}
    fixMode(dbPath)
  }

  return { state, indexAll, search, reset, close, dbPath }
}