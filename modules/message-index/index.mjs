// message-index / index.mjs
//
// 消息索引模块（Aurabot 扩展接口 v1）
//
// 把 DSH 的会话文件（session.v4.jsonl.zstd）增量索引进 SQLite/FTS5，
// 让「查历史消息」不用每次全量解压扫描。
//
// 权限（由框架给的 where 决定）：
//   - 主人私聊 level=full  → 全库
//   - 群聊                 → 只搜该群 chatId
//   - 其它私聊             → 只搜这个私聊的 chatId
// 所有搜索都带 chatId 过滤，群聊结果里不会出现私聊会话内容。

import { join } from 'node:path'
import { openStore } from './store.mjs'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const MODULE_ID = 'message-index'
const DB_PATH = join(DSH, 'plugins-data', 'aurabot', 'modules-data', MODULE_ID, 'messages.db')
const SESSIONS_DIR = join(DSH, 'sessions')
const INSPECT_URL = 'http://127.0.0.1:5043/aurabot/api/ext/self-inspect/sessions'
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '127.0.0.1'])
const DEFAULT_DAYS = 90
const MAX_LIMIT = 10

const PAD = (n) => String(n).padStart(2, '0')
function fmtTime(ms) {
  const d = new Date(Number(ms) || 0)
  return `${String(d.getFullYear()).slice(2)}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`
}

function toStr(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: MODULE_ID,
  name: '消息索引',
  version: '1.0.0',
  api: 1,
  description: '把历史聊天记录索引进 SQLite（FTS5 中文分词），按权限检索，不再每次全量解压会话',
  defaults: { days: DEFAULT_DAYS },
  settings: [
    {
      key: 'days',
      label: '索引最近多少天',
      type: 'number',
      min: 1,
      max: 3650,
      step: 1,
      hint: '默认 90 天。改大以后下一次索引会把更早的消息补进来',
    },
  ],

  setup(api) {
    let store = null
    let indexJob = null
    let lastError = ''

    api.log.info(`[message-index] 启动，数据库：${DB_PATH}`)

    const getStore = () => {
      if (!store) store = openStore(DB_PATH)
      return store
    }

    const daysSetting = () => clampInt(api.settings()?.days, 1, 3650, DEFAULT_DAYS)

    function isLocal(req) {
      const raw = toStr(req?.socket?.remoteAddress)
      const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw
      return LOCAL_IPS.has(ip)
    }

    function ownerQQ() {
      return toStr(api.config?.()?.ownerQQ)
    }

    function whoOf(row, owner) {
      if (row.role === 'assistant') return '她'
      if (owner && row.chatId === `private:${owner}`) return '主人'
      if (row.chatId.startsWith('group:')) return '群友'
      if (row.chatId.startsWith('private:')) return '对方'
      return '内部'
    }

    function chatTag(chatId) {
      if (chatId.startsWith('group:')) return `群${chatId.slice(6)}`
      if (chatId.startsWith('private:')) return `私聊${chatId.slice(8)}`
      return chatId
    }

    function chatKind(chat) {
      const kind = toStr(chat?.kind)
      if (kind) return kind
      const id = toStr(chat?.chatId)
      if (id.startsWith('group:')) return 'group'
      if (id.startsWith('private:')) return 'private'
      if (id.startsWith('system:')) return 'system'
      return ''
    }

    /** 当前会话能搜的范围。null = 全库（只有主人私聊才有）。 */
    function scopeOf(where) {
      const chat = where?.chat || {}
      const kind = chatKind(chat)
      // 全库只给「主人私聊」。就算哪天 where 给错了，群聊也不会被放开成全库
      if (where?.level === 'full' && kind === 'private') return { chatIds: null, label: '全库' }
      if (kind === 'group') {
        const id = chat.chatId && chat.chatId.startsWith('group:') ? chat.chatId : chat.groupId ? `group:${chat.groupId}` : ''
        return id ? { chatIds: [id], label: `本群 ${id.slice(6)}` } : { chatIds: [], label: '无' }
      }
      if (kind === 'private') {
        const id = chat.chatId && chat.chatId.startsWith('private:') ? chat.chatId : chat.userId ? `private:${chat.userId}` : ''
        return id ? { chatIds: [id], label: '本私聊' } : { chatIds: [], label: '无' }
      }
      return { chatIds: [], label: '无' }
    }

    async function fetchMapping() {
      const res = await fetch(INSPECT_URL, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error(`self-inspect 返回 ${res.status}`)
      const body = await res.json()
      const map = new Map()
      for (const row of body?.list || []) {
        if (row?.sessionId && row?.chatId) map.set(String(row.sessionId), String(row.chatId))
      }
      return map
    }

    async function runIndex(reason) {
      const startedAt = Date.now()
      try {
        const mapping = await fetchMapping().catch((error) => {
          // 映射拿不到时用上次存下的 chatId，别把已有数据当成陌生会话
          api.log.warn(`[message-index] 拿会话映射失败（用上次的）：${toStr(error?.message || error).slice(0, 200)}`)
          return new Map()
        })
        const days = daysSetting()
        const summary = await getStore().indexAll({
          sessionsDir: SESSIONS_DIR,
          mapping,
          days,
          yieldEvery: 500,
          onWarn: (line) => api.log.warn(line),
        })
        lastError = summary.failed ? `${summary.failed} 个会话文件读取失败` : ''
        api.log.info(
          `[message-index] ${reason} 索引完成：新增 ${summary.imported} 条，跳过 ${summary.skipped}，` +
            `扫描 ${summary.scanned} 条消息，${summary.files} 个会话文件，耗时 ${summary.tookMs}ms`,
        )
        return { ok: true, reason, elapsedMs: Date.now() - startedAt, ...summary }
      } catch (error) {
        lastError = toStr(error?.message || error).slice(0, 300)
        api.log.warn(`[message-index] ${reason} 索引失败：${lastError}`)
        return { ok: false, reason, message: lastError }
      }
    }

    function indexNow(reason) {
      if (indexJob) return indexJob
      indexJob = runIndex(reason).finally(() => {
        indexJob = null
      })
      return indexJob
    }

    // ── 工具：message_search ────────────────────────────────────────────────
    api.tool((where) => {
      const chat = where?.chat || {}
      const kind = chatKind(chat)
      if (!kind || kind === 'system') return []
      const scope = scopeOf(where)
      // null = 全库（主人私聊）；空数组 = 没有任何范围
      if (Array.isArray(scope.chatIds) && !scope.chatIds.length) return []

      return api.defineTool({
        name: 'message_search',
        description:
          '翻历史聊天记录：查以前谁说过什么、之前聊到过什么、谁提过某个东西。' +
          '返回时间、谁说的、摘要。权限按当前会话：群里只能查本群，别人私聊只能查那个私聊，主人私聊可以查全部。',
        properties: {
          query: { type: 'string', description: '要搜的词或短句，比如「白米饭」「新服务器」' },
          days: { type: 'number', description: '往前查多少天，默认 90' },
          limit: { type: 'number', description: '最多几条，默认 5，最多 10' },
        },
        required: ['query'],
        execute: async (args = {}) => {
          const query = toStr(args.query).trim()
          if (!query) return { ok: false, message: '要搜什么？给个词或短句。' }
          const days = clampInt(args.days, 1, 3650, daysSetting())
          const limit = clampInt(args.limit, 1, MAX_LIMIT, 5)
          try {
            const result = getStore().search({ q: query, days, chatIds: scope.chatIds, limit })
            const owner = ownerQQ()
            if (!result.rows.length) {
              return { ok: true, message: `没找到「${query}」相关的历史消息（最近 ${days} 天，${scope.label}）。` }
            }
            const lines = [`找到 ${result.rows.length} 条（${result.tookMs} 毫秒，${scope.label}）：`]
            result.rows.forEach((row, i) => {
              const tag = scope.chatIds === null ? ` ${chatTag(row.chatId)}` : ''
              lines.push(`${i + 1}. ${fmtTime(row.at)}${tag} ${whoOf(row, owner)}：${row.snippet}`)
            })
            return { ok: true, message: lines.join('\n') }
          } catch (error) {
            api.log.warn(`[message-index] 搜索失败：${toStr(error?.message || error).slice(0, 200)}`)
            return { ok: false, message: '索引库暂时打不开，等会儿再试。' }
          }
        },
      })
    })

    // 让她知道有这个本事
    api.rule(
      () =>
        '想不起以前聊过什么、需要翻旧消息时，用 message_search 查历史记录；它只返回当前聊天能看的部分（群里只有本群，私聊只有这个私聊）。',
    )

    // ── 路由 ───────────────────────────────────────────────────────────────
    api.route('/state', async () => {
      try {
        const s = getStore()
        return {
          ok: true,
          ...s.state(),
          indexing: Boolean(indexJob),
          lastError,
          settings: { days: daysSetting() },
          dbPath: DB_PATH,
        }
      } catch (error) {
        return { ok: false, message: toStr(error?.message || error) }
      }
    })

    api.route('/search', async (req) => {
      if (!isLocal(req)) return { ok: false, code: 403, message: '只允许本机调用' }
      const q = api.core.http.query(req) || {}
      const query = toStr(q.q).trim()
      if (!query) return { ok: false, message: '要给 q 参数' }
      const days = clampInt(q.days, 1, 3650, daysSetting())
      const limit = clampInt(q.limit, 1, 50, 10)
      let chatIds = null
      let label = '全库'
      if (q.chat) {
        const chatId = toStr(q.chat)
        if (!/^(private|group|system):/.test(chatId)) return { ok: false, message: 'chat 参数不对' }
        chatIds = [chatId]
        label = chatId
      }
      try {
        const result = getStore().search({ q: query, days, chatIds, limit })
        const owner = ownerQQ()
        return {
          ok: true,
          q: query,
          chat: chatIds ? chatIds[0] : '',
          scope: label,
          days,
          limit,
          tookMs: result.tookMs,
          mode: result.mode,
          tokens: result.tokens,
          list: result.rows.map((row) => ({
            at: row.at,
            time: fmtTime(row.at),
            chatId: row.chatId,
            role: row.role,
            who: whoOf(row, owner),
            snippet: row.snippet,
          })),
        }
      } catch (error) {
        return { ok: false, message: toStr(error?.message || error) }
      }
    })

    // 手动重建：清空后重新扫。并发调用会并到同一个任务上，不会叠加。
    api.route('/reindex', async (req) => {
      if (req?.method && req.method !== 'POST') return { ok: false, message: '这个方法要 POST' }
      try {
        // 正在索引时先等它跑完，免得一边清表一边写
        if (indexJob) await indexJob
        getStore().reset()
      } catch (error) {
        return { ok: false, message: toStr(error?.message || error) }
      }
      return indexNow('manual')
    })

    // ── 定时 + 启动一次 ────────────────────────────────────────────────────
    api.later(4000, () => {
      indexNow('startup')
    })
    api.every(10 * 60 * 1000, () => {
      indexNow('timer')
    }, 'message-index 每 10 分钟增量索引')

    api.onDispose(() => {
      if (indexJob) api.log.warn('[message-index] 停止时还有索引任务在跑')
      try {
        store?.close()
      } catch {}
      store = null
    })

    return {
      state: () => getStore().state(),
      search: (opts) => getStore().search(opts),
      indexNow,
    }
  },
}