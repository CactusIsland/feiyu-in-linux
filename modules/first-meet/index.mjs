// 初次相遇 / 最初的日子 —— 用户模块（Aurabot 扩展接口 v1）
//
// 从全量存档里找“主人第一次跟她说话”，写成一条永不遗忘的锚点记忆；
// 再把最初 30 天里主人的话收成一段“最初的日子”，也写成受保护记忆。
// 这两条记忆 source=panel，内置整理不会删，memory-map 也会标成 never。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86400_000

function whenText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function clean(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'first-meet',
  name: '初次相遇',
  version: '1.0.0',
  api: 1,
  description: '从全量存档里找出和主人的初次相遇、最初 30 天，写成永不遗忘的锚点记忆',

  defaults: {
    enabled: true,
    createFirst30: true,
    maxFirst30Chars: 240,
  },

  settings: [
    { key: 'enabled', label: '开启初次相遇锚点', type: 'switch' },
    { key: 'createFirst30', label: '生成“最初的日子”', type: 'switch' },
    { key: 'maxFirst30Chars', label: '最初的日子最长字数', type: 'number', min: 100, max: 500, step: 20 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const file = () => join(dir, 'first-meet.json')
    let state = { version: 1, owner: null, lastRun: 0 }
    try { state = { ...state, ...(JSON.parse(readFileSync(file(), 'utf8')) || {}) } } catch (error) {}
    const save = () => {
      try { writeFileSync(file(), JSON.stringify(state, null, 2)) } catch (error) { api.log.warn('初次相遇状态写入失败：' + error.message) }
    }

    const ownerQQ = () => String(api.config().ownerQQ || '')
    const ownerName = () => String(api.config().ownerName || '主人')
    const memory = () => api.use('memory')
    const archive = () => api.use('memory-archive')

    const isOwnerRow = (r) => String(r.userId || '') === ownerQQ() || String(r.chatId || '') === `private:${ownerQQ()}`
    const meaningful = (text) => {
      const s = String(text || '').trim()
      return Boolean(s) && !/^\[[^\]]+\]$/.test(s) && s.replace(/[\s\p{P}\p{S}]/gu, '').length >= 2
    }

    function liveItems() {
      try { return (memory()?.list?.('') || []).filter((m) => !m.invalidAt) } catch (error) { return [] }
    }

    function findTagged(tag) {
      return liveItems().find((m) => (m.tags || []).includes(tag)) || null
    }

    function ensureFirst() {
      const arch = archive()
      if (!arch?.earliest) return null
      const first = arch.earliest((r) => r.kind === 'in' && isOwnerRow(r) && meaningful(r.text))
      if (!first) return null
      const text = `和主人的初次相遇：${whenText(first.at)}，${clean(first.text, 160)}`
      if (!state.owner) state.owner = {}
      state.owner.at = Number(first.at) || 0
      state.owner.chatId = String(first.chatId || '')
      state.owner.text = clean(first.text, 200)
      const existing = findTagged('初次相遇')
      const mem = memory()
      if (existing) {
        state.owner.firstMemoryId = existing.id
        if (String(existing.text || '') !== text && mem?.update) {
          try { mem.update(existing.id, { text }) } catch (error) { api.log.warn('更新初次相遇锚点失败：' + error.message) }
        }
        return first
      }
      if (!mem?.add) return first
      const added = mem.add({
        text,
        about: ownerQQ(),
        aboutName: ownerName(),
        importance: 0.95,
        source: 'panel',
        tags: ['初次相遇', '锚点'],
        chatId: String(first.chatId || ''),
      })
      const id = added && (added.id || added.updated)
      if (id) {
        state.owner.firstMemoryId = id
        api.log.info(`记下了和主人的初次相遇（${whenText(first.at)}）`)
      }
      return first
    }

    async function ensureFirst30(first) {
      if (!api.settings().createFirst30 || !first) return false
      const existing = findTagged('最初的日子')
      if (existing) {
        state.owner = state.owner || {}
        state.owner.first30MemoryId = existing.id
        return true
      }
      const arch = archive()
      if (!arch?.rowsBetween) return false
      const from = Number(first.at) || 0
      const to = from + 30 * DAY
      const rows = arch.rowsBetween(from, to, (r) => r.kind === 'in' && isOwnerRow(r)).slice(0, 80)
      if (rows.length < 3) return false
      const transcript = rows.map((r) => `主人：${clean(r.text, 120)}`).join('\n').slice(-2600)
      const maxChars = Math.max(100, Number(api.settings().maxFirst30Chars) || 240)
      let summary = ''
      try {
        summary = String(await api.ask({
          system: `你是「大肥鱼」。这是你和主人最初 30 天里的聊天片段。用第一人称写一段“最初的日子”的记忆：只写真实发生过的第一次、主人说过的话、你当时的感受，不要编、不要分析、不要写列表，不超过 ${maxChars} 个字。`,
          text: transcript,
          maxTokens: 700,
        }) || '').replace(/\s+/g, ' ').trim()
      } catch (error) {
        api.log.warn('写“最初的日子”失败：' + error.message)
      }
      if (!summary) summary = `最初 30 天里，主人和你说过 ${rows.length} 次话；最早一次是 ${whenText(first.at)}：${clean(first.text, 80)}。`
      const mem = memory()
      if (!mem?.add) return false
      const added = mem.add({
        text: `最初的日子（${whenText(first.at).slice(0, 10)} 起 30 天）：${clean(summary, maxChars)}`,
        about: ownerQQ(),
        aboutName: ownerName(),
        importance: 0.9,
        source: 'panel',
        tags: ['最初的日子', '锚点'],
        chatId: String(first.chatId || ''),
      })
      const id = added && (added.id || added.updated)
      if (id) {
        state.owner = state.owner || {}
        state.owner.first30MemoryId = id
        state.owner.first30At = from
        api.log.info(`记下了“最初的日子”（${rows.length} 条主人消息）`)
      }
      return Boolean(id)
    }

    let busy = false
    async function ensure(force = false) {
      if (busy || !api.settings().enabled) return { ok: false, message: '没开或忙' }
      busy = true
      try {
        const first = ensureFirst()
        if (first) await ensureFirst30(first)
        state.lastRun = Date.now()
        save()
        return { ok: true, owner: state.owner || null, message: first ? `初次相遇已就位（${whenText(first.at)}）` : '存档里还没找到主人的第一条消息' }
      } finally {
        busy = false
      }
    }

    api.route('/state', async () => ({ ok: true, owner: state.owner || null, lastRun: state.lastRun }))
    api.route('/rebuild', async () => ensure(true))

    api.command({
      name: '童年',
      desc: '看看她和主人的初次相遇、最初的日子',
      run: async () => {
        const r = await ensure()
        if (!r.owner) return r.message
        return `${r.message}${r.owner.first30MemoryId ? '；“最初的日子”也记下了' : ''}`
      },
    })

    api.every(60 * 60_000, () => ensure(), '初次相遇')
    api.later(3 * 60_000, () => ensure())
    api.log.info('初次相遇模块已挂上（从全量存档找主人最早一条消息 + 最初 30 天）')

    return { ensure, state: () => state }
  },
}
