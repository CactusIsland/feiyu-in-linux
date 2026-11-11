// 自己的后台 —— 用户模块（Aurabot 扩展接口 v1）
//
// 让她能看自己的后台：版本、开关、模型、记忆、余额、白名单、最近的日志。
// 只在主人私聊里给她这些工具（别人问不出来，也不会泄露密钥）。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const runPy = promisify(execFile)
const USAGE_SCRIPT = DSH + '/plugins-data/aurabot/modules/self-inspect/session_usage.py'
const PY = '/usr/bin/python3'
let usageCache = { at: 0, key: '', value: null }

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'self-inspect',
  name: '自己的后台',
  version: '1.0.0',
  api: 1,
  description: '让她能查自己的状态、余额、记忆和日志（只有主人能问）',

  setup(api) {
    const dataDir = () => join(homedir(), '.dsh', 'plugins-data', 'aurabot')
    const owner = () => String(api.config().ownerQQ || '')

    const redact = (s) => String(s || '')
      .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
      .replace(/(accessToken|token|apiKey|api_key)"?\s*[:=]\s*"?[A-Za-z0-9_\-]{12,}/gi, '$1=***')

    function memoryStats() {
      try {
        const m = api.use('memory')
        if (!m || typeof m.stats !== 'function') return null
        return m.stats()
      } catch (error) { return null }
    }

    async function wallet() {
      try {
        const w = api.use('wallet')
        if (!w || typeof w.summary !== 'function') return null
        return await w.summary()
      } catch (error) { return null }
    }

    function allowList() {
      const a = api.config().allow || {}
      return { groups: a.groups || [], private: a.private || [] }
    }

    /** 读会话文件里的真实 token 用量（带 30 秒缓存）。 */
    async function sessionUsage(sessionId) {
      if (!sessionId) return null
      const now = Date.now()
      if (usageCache.key === sessionId && now - usageCache.at < 30_000) return usageCache.value
      try {
        const { stdout } = await runPy(PY, [USAGE_SCRIPT, sessionId], { timeout: 20000, windowsHide: true })
        const value = JSON.parse(String(stdout || '{}'))
        usageCache = { at: now, key: sessionId, value }
        return value
      } catch (error) {
        const value = { ok: false, error: String(error.message || error).slice(0, 200) }
        usageCache = { at: now, key: sessionId, value }
        return value
      }
    }

    /** 她自己的上下文/记忆规模（粗估）。 */
    async function contextInfo(chat) {
      const hub = api.core.hub || {}
      const cfg = api.config()
      const mem = api.use('memory')
      const items = mem && typeof mem.list === 'function' ? mem.list('').filter((m) => !m.invalidAt) : []
      const memChars = items.reduce((n, m) => n + String(m.text || '').length, 0)
      const today = new Date()
      const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      let logLines = 0
      let logChars = 0
      try {
        const logs = hub.chatLogOf ? hub.chatLogOf(key) : []
        logLines = logs.length
        logChars = logs.reduce((n, l) => n + String(l.text || '').length, 0)
      } catch (error) {}
      const sessions = (() => { try { return hub.sessions ? hub.sessions() : {} } catch (error) { return {} } })()
      const chatId = chat && chat.chatId ? chat.chatId : ''
      const entry = sessions[chatId] || null
      const personaChars = (() => { try { return String(api.config().persona?.current || '').length } catch (error) { return 0 } })()
      const usage = await sessionUsage(entry && entry.sessionId)
      return {
        chat,
        session: entry,
        model: cfg.model?.model || '（DSH 默认）',
        reasoning: cfg.model?.reasoningEffort || '',
        realUsage: usage,
        memory: { count: items.length, chars: memChars, avg: items.length ? Math.round(memChars / items.length) : 0 },
        todayLog: { lines: logLines, chars: logChars },
        sessions: Object.keys(sessions).length,
        note: 'realUsage 来自 DSH 会话文件：promptTokens = inputTokens + cacheReadTokens（真实喂给模型的上下文）',
      }
    }

    function sessionsInfo() {
      const hub = api.core.hub || {}
      const sessions = (() => { try { return hub.sessions ? hub.sessions() : {} } catch (error) { return {} } })()
      return Object.entries(sessions).map(([chatId, s]) => ({
        chatId,
        title: s.title || '',
        model: s.model || '',
        level: s.level || '',
        sessionId: s.sessionId || '',
        createdAt: s.createdAt || 0,
      }))
    }

    function modulesInfo() {
      const modules = api.core.modules?.status?.() ?? []
      return modules.map((m) => ({ id: m.id, name: m.name, running: m.running, error: m.error || '' }))
    }

    function logTail(lines = 30) {
      try {
        const dir = join(DSH, 'plugins-data', 'aurabot', 'logs')
        const files = readdirSync(dir).filter((n) => n.endsWith('.log')).sort()
        if (!files.length) return []
        const text = readFileSync(join(dir, files.at(-1)), 'utf8')
        return text.split(/\r?\n/).filter(Boolean).slice(-lines).map(redact)
      } catch (error) { return [] }
    }

    async function status() {
      const cfg = api.config()
      const w = await wallet()
      const mem = memoryStats()
      const a = allowList()
      return {
        version: api.version,
        enabled: cfg.enabled,
        dryRun: cfg.dryRun,
        bot: cfg.botQQ,
        owner: cfg.ownerQQ,
        persona: cfg.persona?.current || '',
        model: cfg.model?.model || '（DSH 默认）',
        memory: mem,
        wallet: w ? { openlux: w.openlux, deepseek: w.deepseek } : null,
        allow: a,
        group: { wake: cfg.group?.wakeWords || [], interject: cfg.group?.interjectChance },
      }
    }

    function configView() {
      const c = api.config()
      return {
        model: c.model,
        chatModels: c.chatModels,
        persona: c.persona,
        memory: c.memory,
        voice: { enabled: c.voice?.enabled, engine: c.voice?.engine, voice: c.voice?.voice },
        imageGen: { enabled: c.imageGen?.enabled, provider: c.imageGen?.provider, model: c.imageGen?.model, baseUrl: c.imageGen?.baseUrl },
        group: { wakeWords: c.group?.wakeWords, interjectChance: c.group?.interjectChance, quietHours: c.group?.quietHours },
        allow: c.allow,
        speakUp: c.speakUp,
        mood: c.mood,
      }
    }

    const fmt = (x) => JSON.stringify(x, null, 1)

    api.tool(({ chat }) => {
      if (!chat || chat.kind !== 'private') return []
      if (String(chat.userId) !== owner()) return []
      return [
        api.defineTool({
          name: 'self_status',
          description: '看自己的后台概况：开关、模型、人格、记忆条数、余额、群/私聊白名单。主人问「你现在怎么样」「后台什么情况」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: fmt(await status()) }),
        }),
        api.defineTool({
          name: 'self_balance',
          description: '查自己还剩多少钱（openlux 生图额度 + DeepSeek 余额）。',
          properties: {},
          execute: async () => {
            const w = await wallet()
            if (!w) return { ok: false, message: '钱包模块没在跑' }
            const ds = w.deepseek
            const dsText = !ds ? 'DeepSeek 没查' : ds.ok ? `${ds.total} ${ds.currency}` : `查不到（${ds.message}）`
            return { ok: true, message: `openlux 剩 ${w.openlux.remaining} 美元（画了 ${w.openlux.images} 张）｜ DeepSeek 剩 ${dsText}` }
          },
        }),
        api.defineTool({
          name: 'self_config',
          description: '看自己的关键设置（模型、人格、记忆、语音、生图、群规矩、白名单）。主人问「你的设置」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: fmt(configView()) }),
        }),
        api.defineTool({
          name: 'self_logs',
          description: '看自己最近 30 行日志（已脱敏）。主人问「你刚才怎么了」「有没有报错」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: logTail(30).join('\n') || '没有日志' }),
        }),
        api.defineTool({
          name: 'self_memory',
          description: '看自己记住了多少条、最记得谁。',
          properties: {},
          execute: async () => {
            const mem = api.use('memory')
            if (!mem) return { ok: false, message: '记忆模块没在跑' }
            const stats = mem.stats()
            const list = mem.list('').filter((m) => !m.invalidAt).slice(0, 10)
            return { ok: true, message: fmt({ stats, recent: list.map((m) => ({ text: m.text, importance: m.importance, tags: m.tags })) }) }
          },
        }),
        api.defineTool({
          name: 'self_context',
          description: '看自己的上下文占了多少：记忆条数与字数、今天聊了多少、会话用的是哪个模型。主人问「你上下文多大了」「你记得多少东西」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: fmt(await contextInfo(chat)) }),
        }),
        api.defineTool({
          name: 'self_sessions',
          description: '看自己现在有多少个聊天会话、分别对应谁。',
          properties: {},
          execute: async () => ({ ok: true, message: fmt(sessionsInfo()) }),
        }),
        api.defineTool({
          name: 'self_modules',
          description: '看自己装了哪些模块、哪些在跑、哪个报错了。',
          properties: {},
          execute: async () => ({ ok: true, message: fmt(modulesInfo()) }),
        }),
      ]
    })

    api.command({
      name: '后台',
      desc: '看自己的后台概况',
      run: async () => fmt(await status()),
    })

    api.route('/reset-chat', async (req) => {
      const chatId = String(api.core.http.query(req).chat || '')
      if (!chatId) return { ok: false, message: '要给 chat 参数' }
      try {
        const done = api.core.hub.resetChat(chatId)
        return { ok: true, chatId, reset: done }
      } catch (error) {
        return { ok: false, chatId, message: String(error?.message || error) }
      }
    })

    api.route('/status', async () => ({ ok: true, status: await status() }))
    api.route('/context', async (req) => {
      const chatId = String(api.core.http.query(req).chat || `private:${owner()}`)
      const kind = chatId.startsWith('group:') ? 'group' : 'private'
      return { ok: true, context: await contextInfo({ chatId, kind, userId: owner() }) }
    })
    api.route('/sessions', async () => ({ ok: true, list: sessionsInfo() }))
    api.route('/modules', async () => ({ ok: true, list: modulesInfo() }))
    api.route('/logs', async (req) => {
      const n = Math.min(200, Math.max(5, Number(api.core.http.query(req).n) || 30))
      return { ok: true, lines: logTail(n) }
    })

    // 群聊里被 @ 问「上下文」：直接回具体数字，不交给模型，任何群都生效
    api.on('message', async (msg) => {
      if (!msg) return false
      const text = String(msg.text || '')
      if (!/上下文|context|token|多少字|记忆|会话|记得多少/i.test(text)) return false
      const inGroup = msg.kind === 'group'
      if (inGroup && !msg.mentioned) return false
      if (!inGroup && String(msg.userId) !== owner()) return false

      const info = await contextInfo(msg)
      const u = info.realUsage || {}
      const last = u.last
      const mem = `记忆 ${info.memory.count} 条 / ${info.memory.chars} 字`
      let out
      if (last) {
        out = `上一轮上下文 ${last.promptTokens} tokens（输入 ${last.inputTokens} + 缓存读 ${last.cacheReadTokens}），输出 ${last.outputTokens}；`
          + `这个会话一共 ${u.turns} 轮，累计输入 ${u.total.input}、输出 ${u.total.output}；${mem}`
      } else {
        out = `这个会话还没跑过一轮；${mem}`
      }
      try { await api.reply(msg, out) } catch (error) { api.log.warn('上下文回复失败：' + error.message) }
      return true
    })

    api.log.info('自己的后台已挂上（主人私聊里可用 self_* 工具；群里 @ 问上下文会直接报数）')
    return { status, logTail }
  },
}
