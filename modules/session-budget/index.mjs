// 会话预算 —— 用户模块（Aurabot 扩展接口 v1）
//
// 真正费 token 的不是记忆库，是每个聊天越来越长的 DSH 会话历史。
// 这里做两件事：
//  1) 读会话文件里的真实 token 用量，超过阈值在日志/命令里提示；
//  2) 手动或按需轮转：先让她留一张连续性纸条，再重置这个聊天的会话。
//     记忆和全量存档都不动，重置只清 DSH 的对话上下文。
//
// 自动轮转默认关闭；先手动跑通再开。

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const run = promisify(execFile)
const USAGE_SCRIPT = DSH + '/plugins-data/aurabot/modules/self-inspect/session_usage.py'
const PY = '/usr/bin/python3'
const DAY = 86400_000

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'session-budget',
  name: '会话预算',
  version: '1.0.0',
  api: 1,
  description: '看每个聊天的真实 token 用量；手动/按需先留纸条再重置会话，省上下文',

  defaults: {
    enabled: true,
    warnTokens: 8000,
    rotateTokens: 14000,
    autoRotate: false,
    dryRun: false,
    idleMinutes: 15,
    maxRotationsPerDay: 3,
    checkMinutes: 15,
  },

  settings: [
    { key: 'enabled', label: '开启会话预算', type: 'switch' },
    { key: 'warnTokens', label: '超过多少 token 在日志里提醒', type: 'number', min: 1000, max: 100000, step: 500 },
    { key: 'rotateTokens', label: '超过多少 token 建议轮转', type: 'number', min: 2000, max: 200000, step: 1000 },
    { key: 'autoRotate', label: '自动轮转（默认关）', type: 'switch', hint: '只在聊天闲置超过设定分钟、且当天轮转次数没超时执行' },
    { key: 'dryRun', label: '只演练，不真的重置', type: 'switch', hint: '打开后 /预算 轮转 只更新纸条，不重置会话' },
    { key: 'idleMinutes', label: '自动轮转前至少闲置几分钟', type: 'number', min: 5, max: 180, step: 5 },
    { key: 'maxRotationsPerDay', label: '每天最多自动轮转几个聊天', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'checkMinutes', label: '每隔几分钟检查一次', type: 'number', min: 5, max: 120, step: 5 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const logFile = () => join(dir, 'rotations.json')
    let log = { version: 1, days: {}, entries: [] }
    try { log = { ...log, ...(JSON.parse(readFileSync(logFile(), 'utf8')) || {}) } } catch (error) {}
    log.days = log.days || {}
    log.entries = log.entries || []
    const saveLog = () => {
      try {
        log.entries = log.entries.slice(-200)
        writeFileSync(logFile(), JSON.stringify(log, null, 2))
      } catch (error) { api.log.warn('会话轮转记录写入失败：' + error.message) }
    }

    const usageCache = new Map()
    let checking = false
    let rotating = false
    const warned = new Map()

    async function sessionUsage(sessionId) {
      if (!sessionId) return { ok: false, error: '没有 sessionId' }
      const now = Date.now()
      const hit = usageCache.get(sessionId)
      if (hit && now - hit.at < 30_000) return hit.value
      try {
        const { stdout } = await run(PY, [USAGE_SCRIPT, sessionId], { timeout: 20000, windowsHide: true })
        const value = JSON.parse(String(stdout || '{}'))
        usageCache.set(sessionId, { at: now, value })
        return value
      } catch (error) {
        const value = { ok: false, error: String(error.message || error).slice(0, 160) }
        usageCache.set(sessionId, { at: now, value })
        return value
      }
    }

    const sessions = () => {
      try { return api.core.hub.sessions?.() || {} } catch (error) { return {} }
    }

    async function usageOf(chatId) {
      const entry = sessions()[chatId]
      if (!entry?.sessionId) return { ok: false, error: '这个聊天还没有会话' }
      const usage = await sessionUsage(entry.sessionId)
      const last = usage.last || {}
      const promptTokens = Number(last.promptTokens || 0)
      return {
        ok: Boolean(usage.ok !== false),
        chatId,
        sessionId: entry.sessionId,
        title: entry.title || '',
        promptTokens,
        inputTokens: Number(last.inputTokens || 0),
        cacheReadTokens: Number(last.cacheReadTokens || 0),
        outputTokens: Number(last.outputTokens || 0),
        turns: Number(usage.turns || 0),
        warnTokens: Number(api.settings().warnTokens) || 8000,
        rotateTokens: Number(api.settings().rotateTokens) || 14000,
        error: usage.error || '',
      }
    }

    function linesOf(chatId) {
      const out = []
      const hub = api.core.hub
      for (const dk of [dayKey(new Date(Date.now() - DAY)), dayKey()]) {
        let rows = []
        try { rows = hub.chatLogOf?.(dk) || [] } catch (error) { rows = [] }
        for (const l of rows) if (l && l.chatId === chatId && String(l.text || '').trim()) out.push(l)
      }
      out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
      return out
    }

    const lastTalkAt = (chatId) => {
      const lines = linesOf(chatId)
      return Number(lines.at(-1)?.t) || 0
    }

    function rotationsToday() {
      return Number(log.days[dayKey()]) || 0
    }

    async function rotate(chatId, reason = 'manual') {
      if (rotating) return { ok: false, message: '上一轮还在处理' }
      const chat = String(chatId || '')
      if (!chat || chat.startsWith('system:')) return { ok: false, message: '这个聊天不能轮转' }
      const hub = api.core.hub
      const continuity = api.use('continuity')
      if (!continuity || typeof continuity.updateChat !== 'function') {
        return { ok: false, message: '连续性纸条模块没在跑，先不轮转' }
      }
      rotating = true
      try {
        const lines = linesOf(chat)
        if (!lines.length) return { ok: false, message: '今天没有可整理的聊天，先不轮转' }
        const before = await usageOf(chat)
        const saved = await continuity.updateChat(chat, lines, { force: true })
        if (!saved) return { ok: false, message: '没能留下连续性纸条，先不轮转' }
        if (api.settings().dryRun) {
          return { ok: true, message: `演练：已更新 ${chat} 的连续性纸条，但没有重置会话${before.promptTokens ? `（当前约 ${before.promptTokens} tokens）` : ''}。` }
        }
        log.entries.push({ at: Date.now(), chatId: chat, reason, promptTokens: before.promptTokens || 0 })
        log.days[dayKey()] = rotationsToday() + 1
        saveLog()
        // 等命令回复 / 当前回合收尾后再重置
        api.later(8000, () => {
          try {
            hub.resetChat?.(chat)
            api.log.info(`会话已轮转：${chat}（${reason}），重置前约 ${before.promptTokens || 0} tokens`)
          } catch (error) {
            api.log.warn(`轮转 ${chat} 失败：` + error.message)
          }
        })
        return {
          ok: true,
          message: `已给 ${chat} 留下连续性纸条，8 秒后重置会话${before.promptTokens ? `（重置前约 ${before.promptTokens} tokens）` : ''}。记忆和全量存档都不会丢。`,
        }
      } finally {
        rotating = false
      }
    }

    async function tick() {
      if (checking || !api.settings().enabled) return
      checking = true
      try {
        const all = sessions()
        const cfg = api.settings()
        const now = Date.now()
        const candidates = Object.entries(all).filter(([chatId]) => !String(chatId).startsWith('system:'))
        for (const [chatId, entry] of candidates) {
          if (!entry?.sessionId) continue
          const usage = await usageOf(chatId)
          if (!usage.ok) continue
          if (usage.promptTokens >= (Number(cfg.warnTokens) || 8000)) {
            const lastWarn = Number(warned.get(chatId)) || 0
            if (now - lastWarn > 3600_000) {
              warned.set(chatId, now)
              api.log.info(`会话偏大：${chatId} 约 ${usage.promptTokens} tokens（${usage.turns} 轮）`)
            }
          }
          if (!cfg.autoRotate) continue
          if (usage.promptTokens < (Number(cfg.rotateTokens) || 14000)) continue
          if (rotationsToday() >= (Number(cfg.maxRotationsPerDay) || 3)) break
          const idle = now - lastTalkAt(chatId)
          if (idle < (Number(cfg.idleMinutes) || 15) * 60_000) continue
          const r = await rotate(chatId, 'auto')
          if (r.ok) break
        }
      } finally {
        checking = false
      }
    }

    api.route('/state', async () => ({
      ok: true,
      settings: api.settings(),
      today: rotationsToday(),
      entries: log.entries.slice(-20).reverse(),
    }))
    api.route('/usage', async (req) => usageOf(String(api.core.http.query(req).chat || '')))
    api.route('/rotate', async (req) => rotate(String(api.core.http.query(req).chat || ''), 'api'))

    api.command({
      name: '预算',
      desc: '看当前聊天的真实 token 用量；/预算 轮转 可以先留纸条再重置',
      run: async (arg, msg) => {
        if (/^轮转/.test(String(arg || '').trim())) return (await rotate(msg?.chatId, 'manual')).message || '轮转失败'
        const u = await usageOf(msg?.chatId)
        if (!u.ok) return `读不到会话用量：${u.error || '没有会话'}`
        return `当前上下文约 ${u.promptTokens} tokens（输入 ${u.inputTokens} + 缓存 ${u.cacheReadTokens}，${u.turns} 轮）；提醒线 ${u.warnTokens}，建议轮转线 ${u.rotateTokens}，自动轮转${api.settings().autoRotate ? '开' : '关'}。`
      },
    })

    api.every(Math.max(5, Number(api.settings().checkMinutes) || 15) * 60_000, tick, '会话预算')
    api.later(2 * 60_000, tick)
    api.log.info('会话预算已挂上（默认只提醒；/预算 轮转 手动轮转）')

    return { usageOf, rotate, tick, rotationsToday }
  },
}
