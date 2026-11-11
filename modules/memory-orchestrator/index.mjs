// 记忆编排器 —— 用户模块（Aurabot 扩展接口 v1）
//
// 只读/补齐 plugins-data/aurabot/memories.json，不改内置记忆模块、不注入 context
// （避免和内置记忆重复占上下文）。
//
// 主人私聊（level === 'full'）才挂 memory_recall / memory_audit 两个工具；
// 群聊和别人私聊一律返回 []，人问不出来。
//
// 字段补齐：内置记忆模块新写的条目不会带 type/confidence 等字段，
// 这里每 30 分钟补一次（只动缺字段的条目，没缺就不写盘），另外 POST /backfill 可手动触发。
//
// 兼容两种文件形态：顶层数组，或 { items: [...] }。

import {
  chmodSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONFIDENCE, TYPES, hasTimestamp, inferConfidence, inferProtected, inferScope, inferType,
  isStrong, isValidConfidence, isValidScope, isValidType, patchItem,
} from './scripts/fields.mjs'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const MEM_FILE = join(DSH, 'plugins-data', 'aurabot', 'memories.json')

const TYPE_WEIGHT = { promise: 1.2, preference: 1.0, fact: 0.9, event: 0.55, conjecture: 0.3 }
const DUP_HEAD = 20
const RECALL_DEFAULT = 6
const RECALL_MAX = 20
const BACKFILL_INTERVAL = 30 * 60 * 1000

// setup 里填上，normalize 补 scope 时要用（模块没跑迁移也要能显示对）
let ownerQQOf = () => ''

const clip = (text, n) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

const day = (ts) => {
  if (!ts || !Number.isFinite(Number(ts))) return '未知时间'
  const d = new Date(Number(ts))
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dedupeKey = (text) => String(text || '').replace(/\s+/g, '').slice(0, DUP_HEAD)

/** 把一条原始记忆规整成编排器视图（迁移没跑过 / 内置模块新加的都兜得住）。 */
function normalize(it) {
  const text = String(it.text || '').trim()
  const tags = Array.isArray(it.tags) ? it.tags.map(String) : []
  let confidence = Number(it.confidence)
  if (!isValidConfidence(it.confidence)) confidence = inferConfidence(text, tags)
  let updatedAt = Number(it.updatedAt)
  if (!hasTimestamp(it.updatedAt)) updatedAt = Number(it.at) || Number(it.lastHit) || 0
  const importance = Number(it.importance)
  return {
    id: String(it.id || ''),
    text,
    type: isValidType(it.type) ? it.type : inferType(text, tags, it.about, it.source),
    confidence: Number.isFinite(confidence) ? confidence : DEFAULT_CONFIDENCE,
    scope: isValidScope(it.scope) ? it.scope : inferScope(it.chatId, ownerQQOf()),
    protected: typeof it.protected === 'boolean' ? it.protected : inferProtected(it),
    importance: Number.isFinite(importance) ? importance : 0.5,
    tags,
    about: String(it.about || ''),
    aboutName: String(it.aboutName || ''),
    source: String(it.source || ''),
    chatId: String(it.chatId || ''),
    updatedAt,
  }
}

function readAll() {
  let st
  try {
    st = statSync(MEM_FILE)
  } catch (error) {
    return []
  }
  const key = `${st.mtimeMs}:${st.size}`
  if (readAll.cache && readAll.cache.key === key) return readAll.cache.items
  let items = []
  try {
    const parsed = JSON.parse(readFileSync(MEM_FILE, 'utf8'))
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.memories)
          ? parsed.memories
          : []
    items = list
      .filter((it) => it && typeof it === 'object' && String(it.text || '').trim())
      .map(normalize)
  } catch (error) {
    items = []
  }
  readAll.cache = { key, items }
  return items
}

/** 查询切词：空白/标点分段，中文长词再切二字组合，短查询靠原文包含兜底。 */
function terms(q) {
  const out = new Set()
  for (const w of String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    out.add(w)
    if (/^[\u4e00-\u9fff]+$/.test(w) && w.length > 2) {
      for (let i = 0; i < w.length - 1; i += 1) out.add(w.slice(i, i + 2))
    }
  }
  return [...out]
}

function keywordScore(it, q, ts) {
  const text = it.text.toLowerCase()
  const tags = it.tags.join(' ').toLowerCase()
  const about = `${it.about} ${it.aboutName}`.toLowerCase()
  let score = 0
  if (q) {
    if (text.includes(q)) score += 6
    if (tags.includes(q)) score += 4
  }
  for (const t of ts) {
    if (t.length < 2) continue
    const hit = t.length >= 3 ? 2.5 : 2
    if (text.includes(t)) score += hit
    if (tags.includes(t)) score += 2
    if (about.includes(t)) score += 1.5
  }
  return score
}

function recall(query, limit) {
  const all = readAll()
  const q = String(query || '').trim().toLowerCase()
  const ts = terms(q)
  const scored = []
  for (const it of all) {
    const kw = q ? keywordScore(it, q, ts) : 0
    if (q && kw <= 0) continue
    scored.push({ it, kw })
  }
  scored.sort((a, b) =>
    b.kw - a.kw ||
    TYPE_WEIGHT[b.it.type] - TYPE_WEIGHT[a.it.type] ||
    b.it.confidence - a.it.confidence ||
    b.it.updatedAt - a.it.updatedAt)
  const seen = new Set()
  const picked = []
  for (const row of scored) {
    const key = dedupeKey(row.it.text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    picked.push({ ...row.it, score: Number(row.kw.toFixed(2)) })
    if (picked.length >= limit) break
  }
  return picked
}

function clampLimit(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return RECALL_DEFAULT
  return Math.min(RECALL_MAX, Math.max(1, n))
}

function line(r) {
  return `[${r.type}|${r.confidence.toFixed(2)}|${day(r.updatedAt)}] ${clip(r.text, 160)}`
}

function audit() {
  const all = readAll()
  const byType = {}
  for (const t of TYPES) byType[t] = 0
  let protectedCount = 0
  const low = []
  const protectedItems = []
  const dup = new Map()
  const scope = { owner: 0, global: 0, group: 0 }
  for (const it of all) {
    byType[it.type] = (byType[it.type] || 0) + 1
    if (it.protected) {
      protectedCount += 1
      if (protectedItems.length < 20) protectedItems.push({ id: it.id, type: it.type, text: clip(it.text, 60) })
    }
    if (it.confidence <= 0.5 && low.length < 20) {
      low.push({ id: it.id, type: it.type, confidence: Number(it.confidence.toFixed(2)), text: clip(it.text, 60) })
    }
    const key = dedupeKey(it.text)
    dup.set(key, (dup.get(key) || 0) + 1)
    if (it.scope === 'owner') scope.owner += 1
    else if (it.scope.startsWith('group:')) scope.group += 1
    else scope.global += 1
  }
  const groups = [...dup.values()].filter((n) => n > 1)
  let mtime = 0
  try { mtime = statSync(MEM_FILE).mtimeMs } catch (error) { mtime = 0 }
  return {
    total: all.length,
    byType,
    protectedCount,
    low,
    protectedItems,
    duplicates: { groups: groups.length, items: groups.reduce((sum, n) => sum + n, 0) },
    scope,
    mtime,
    file: MEM_FILE,
  }
}

function auditMessage(a) {
  const parts = [`记忆库共 ${a.total} 条：`]
  parts.push(TYPES.map((t) => `${t} ${a.byType[t] || 0}`).join('，'))
  parts.push(`受保护 ${a.protectedCount} 条；低置信度（≤0.5）${a.low.length} 条（最多列 20 条）。`)
  if (a.low.length) parts.push('低置信度：' + a.low.map((i) => `${i.id}(${i.confidence}) ${i.text}`).join('；'))
  if (a.duplicates.groups) parts.push(`疑似重复 ${a.duplicates.groups} 组 ${a.duplicates.items} 条。`)
  return parts.join('\n')
}

function writeAtomic(file, text, mode = 0o640) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

/**
 * 补齐 memories.json 里缺字段的条目（幂等）。不写备份；没缺就不写盘。
 * 写之前再看一眼文件有没有被别人改过；改过就重读重补，最多 3 次。
 */
function patchFile() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snap
    try {
      const st = statSync(MEM_FILE)
      snap = { key: `${st.mtimeMs}:${st.size}`, raw: readFileSync(MEM_FILE, 'utf8') }
    } catch (error) {
      return { ok: false, patched: 0, total: 0, message: '读不到 memories.json：' + (error?.message || error) }
    }
    let parsed
    try {
      parsed = JSON.parse(snap.raw)
    } catch (error) {
      return { ok: false, patched: 0, total: 0, message: 'memories.json 不是合法 JSON' }
    }
    const isArray = Array.isArray(parsed)
    const list = isArray ? parsed : parsed?.items
    if (!Array.isArray(list)) return { ok: false, patched: 0, total: 0, message: 'memories.json 结构不认识（既不是数组也没有 items）' }

    const at = Date.now()
    const ownerQQ = ownerQQOf()
    let patched = 0
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      if (patchItem(it, { at, ownerQQ }).length) patched += 1
    }
    if (!patched) return { ok: true, patched: 0, total: list.length }

    let nowKey = ''
    try {
      const st = statSync(MEM_FILE)
      nowKey = `${st.mtimeMs}:${st.size}`
    } catch (error) {
      nowKey = ''
    }
    if (nowKey !== snap.key) continue // 读完之后别人写过，重读重补

    const text = JSON.stringify(isArray ? list : parsed, null, 2) + (snap.raw.endsWith('\n') ? '\n' : '')
    try {
      writeAtomic(MEM_FILE, text, 0o640)
    } catch (error) {
      return { ok: false, patched: 0, total: list.length, message: '写回失败：' + (error?.message || error) }
    }
    readAll.cache = null
    return { ok: true, patched, total: list.length }
  }
  return { ok: false, patched: 0, total: 0, message: '文件一直在变，这次跳过（下次再来）' }
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-orchestrator',
  name: '记忆编排器',
  version: '1.1.0',
  api: 1,
  description: '给记忆加类型/置信度/作用域，主人私聊可召回与审计；每 30 分钟自动补齐新记忆字段（只读 memories.json）',

  defaults: {
    recallLimit: RECALL_DEFAULT,
  },

  setup(api) {
    ownerQQOf = () => {
      try { return String(api.config()?.ownerQQ || '') } catch (error) { return '' }
    }

    api.tool((where) => {
      // 只在主人私聊挂工具；群聊、别人私聊、system 一律不给
      if (!where || where.level !== 'full') return []
      const limitDefault = clampLimit(api.settings().recallLimit)

      const recallTool = api.defineTool({
        name: 'memory_recall',
        description: '按关键词从记忆库找回相关记忆，按相关度、类型、置信度排序，带类型/置信度/时间。主人问「你还记得……吗」时用。',
        properties: {
          query: { type: 'string', description: '要找什么：关键词、人名、事件都行' },
          limit: { type: 'integer', description: `最多几条，默认 ${limitDefault}，最多 ${RECALL_MAX}` },
        },
        required: ['query'],
        execute: async ({ query, limit }) => {
          const q = String(query || '').trim()
          const n = clampLimit(limit || limitDefault)
          const hits = recall(q, n)
          if (!hits.length) {
            return { ok: true, count: 0, items: [], message: q ? `没找到和「${q}」有关的记忆。` : '记忆库是空的。' }
          }
          return {
            ok: true,
            count: hits.length,
            items: hits.map((r) => ({
              id: r.id, type: r.type, confidence: r.confidence, scope: r.scope,
              protected: r.protected, updatedAt: r.updatedAt, text: clip(r.text, 240),
            })),
            message: `找到 ${hits.length} 条记忆（按相关度排，方括号是 类型|置信度|日期）：\n` + hits.map(line).join('\n'),
          }
        },
      })

      const auditTool = api.defineTool({
        name: 'memory_audit',
        description: '检查记忆库健康度：各类型数量、受保护条数、低置信度条目、疑似重复。主人问「记忆整理得怎么样」时用。',
        properties: {},
        required: [],
        execute: async () => {
          const a = audit()
          return {
            ok: true,
            total: a.total,
            byType: a.byType,
            protected: a.protectedCount,
            lowConfidence: a.low,
            duplicates: a.duplicates,
            message: auditMessage(a),
          }
        },
      })

      return [recallTool, auditTool]
    })

    api.route('/state', async () => {
      const a = audit()
      return {
        ok: true,
        total: a.total,
        byType: a.byType,
        protected: a.protectedCount,
        lowConfidence: a.low.length,
      }
    })

    api.route('/audit', async () => {
      const a = audit()
      return {
        ok: true,
        total: a.total,
        byType: a.byType,
        protected: a.protectedCount,
        protectedItems: a.protectedItems,
        lowConfidence: a.low,
        duplicates: a.duplicates,
        scope: a.scope,
        file: a.file,
        fileUpdatedAt: a.mtime,
        generatedAt: Date.now(),
      }
    })

    // 手动补齐（POST）：给运维/面板按钮用，返回补了几条
    api.route('/backfill', async (req) => {
      if (String(req?.method || '').toUpperCase() !== 'POST') {
        return { ok: false, patched: 0, message: '用 POST 触发' }
      }
      const r = patchFile()
      if (r.ok && r.patched > 0) api.log.info(`记忆字段补齐 ${r.patched} 条`)
      if (!r.ok) api.log.warn('手动补齐记忆字段失败：' + (r.message || ''))
      return { ok: r.ok, patched: r.patched, total: r.total, ...(r.ok ? {} : { message: r.message }) }
    })

    // 内置记忆模块新写的条目不带字段，每 30 分钟补一次（没缺就不写盘）
    api.every(BACKFILL_INTERVAL, () => {
      const r = patchFile()
      if (r.ok && r.patched > 0) api.log.info(`记忆字段补齐 ${r.patched} 条`)
      if (!r.ok) api.log.warn('定时补齐记忆字段失败：' + (r.message || ''))
    }, '补齐记忆字段')

    api.log.info('记忆编排器已挂上（只读 memories.json + 30 分钟字段补齐，工具仅主人私聊可见）')
    return {
      recall: (query, limit) => recall(String(query || ''), clampLimit(limit)),
      audit,
      backfill: () => patchFile(),
    }
  },
}
