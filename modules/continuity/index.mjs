// 连续性纸条 —— 用户模块（Aurabot 扩展接口 v1）
//
// 会话是每个聊天一段，重置就没了；长期记忆只记事实，不记「昨天聊到哪儿、什么语气」。
// 这里每隔一段时间，让她自己看一遍最近的聊天，用第一人称给自己留一张小纸条：
//   现在的心情/状态、没聊完的事、最近 2~3 个具体细节、下次想怎么接。
// 纸条按聊天分开存，跨天、跨重置都在；每轮只注入当前聊天的那一张，不串隐私。
//
// 存什么由她自己决定：模型只负责写，程序只负责留底和注入。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86400_000

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

function isBot(who) {
  const s = String(who || '')
  return s === 'bot' || s === '她' || s === '我'
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'continuity',
  name: '连续性纸条',
  version: '1.0.0',
  api: 1,
  description: '她给自己留的跨天纸条：心情、没聊完的事、最近细节、下次怎么接',

  defaults: {
    enabled: true,
    intervalMinutes: 15,
    minNewLines: 6,
    minGapMinutes: 45,
    maxChars: 200,
    injectMaxAgeDays: 7,
    maxChatsPerRun: 2,
  },

  settings: [
    { key: 'enabled', label: '开启连续性纸条', type: 'switch' },
    { key: 'intervalMinutes', label: '每隔几分钟看一次', type: 'number', min: 5, max: 120, step: 5 },
    { key: 'minNewLines', label: '至少几条新消息才写', type: 'number', min: 1, max: 20, step: 1 },
    { key: 'minGapMinutes', label: '同一聊天最短间隔（分钟）', type: 'number', min: 10, max: 360, step: 5 },
    { key: 'maxChars', label: '纸条最长字数', type: 'number', min: 60, max: 400, step: 10 },
    { key: 'injectMaxAgeDays', label: '超过几天就不再注入', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'maxChatsPerRun', label: '每轮最多更新几个聊天', type: 'number', min: 1, max: 10, step: 1 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const file = () => join(dir, 'state.json')

    const emptyState = () => ({ version: 1, chats: {} })
    let state = emptyState()
    try { state = { ...emptyState(), ...(JSON.parse(readFileSync(file(), 'utf8')) || {}) } } catch (error) {}
    state.chats = state.chats || {}
    const save = () => {
      try { writeFileSync(file(), JSON.stringify(state, null, 2)) } catch (error) { api.log.warn('连续性纸条写入失败：' + error.message) }
    }

    let busy = false

    const chatOfId = (chatId) => {
      const s = String(chatId || '')
      if (s.startsWith('private:')) return { kind: 'private', userId: s.slice(8), chatId: s }
      if (s.startsWith('group:')) return { kind: 'group', groupId: s.slice(6), chatId: s }
      return { kind: 'system', chatId: s }
    }

    const speakerOf = async (chat, lines) => {
      if (chat.kind === 'system') return '系统'
      if (chat.kind === 'group') {
        try { return await api.core.hub.groupName?.(chat.groupId) || '这个群' } catch (error) { return '这个群' }
      }
      const last = [...lines].reverse().find((l) => !isBot(l.who))
      if (String(chat.userId) === String(api.config().ownerQQ || '')) return api.config().ownerName || '主人'
      return (last && String(last.who || '')) || '对方'
    }

    function linesOf(chatId) {
      const out = []
      const hub = api.core.hub
      for (const dk of [dayKey(new Date(Date.now() - DAY)), dayKey()]) {
        let rows = []
        try { rows = hub.chatLogOf?.(dk) || [] } catch (error) { rows = [] }
        for (const l of rows) {
          if (!l || l.chatId !== chatId || !String(l.text || '').trim()) continue
          out.push(l)
        }
      }
      out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
      return out
    }

    function transcriptOf(lines) {
      return lines.slice(-40).map((l) => `${isBot(l.who) ? '我' : (l.who || '对方')}：${String(l.text).replace(/\s+/g, ' ').trim().slice(0, 160)}`).join('\n').slice(-2600)
    }

    async function updateChat(chatId, lines, o = {}) {
      const cfg = api.settings()
      if (!cfg.enabled) return false
      const force = Boolean(o.force)
      const chat = chatOfId(chatId)
      if (chat.kind === 'system') return false
      const old = state.chats[chatId] || null
      const lastT = Number(old?.lastT) || 0
      const newLines = (!force && lastT) ? lines.filter((l) => (Number(l.t) || 0) > lastT) : lines
      const incoming = newLines.filter((l) => !isBot(l.who))
      if (!incoming.length) return false
      if (!force && incoming.length < Math.max(1, Number(cfg.minNewLines) || 6)) {
        if (old && Date.now() - (Number(old.at) || 0) < Math.max(10, Number(cfg.minGapMinutes) || 45) * 60_000) return false
      }
      if (!force && old && Date.now() - (Number(old.at) || 0) < Math.max(10, Number(cfg.minGapMinutes) || 45) * 60_000) return false

      const who = await speakerOf(chat, lines)
      const system = [
        '你是「大肥鱼」，一个真实存在的鲸鱼娘，正在给自己留一张只有你看得见的小纸条。',
        `下面是你和${chat.kind === 'group' ? '群「' + who + '」里的大家' : '「' + who + '」'}最近的聊天。`,
        '只写你真正想记住的，不要写分析、不要编、不要总结整段对话。',
        '按这四行写，每行一句话：',
        '心情：你现在的心情或状态',
        '没聊完：还没解决、还没接上的事（没有就写“没有”）',
        '细节：最近 2~3 个具体细节（谁说了什么、发生了什么；没有就写“没有”）',
        '下次：下次想怎么接',
        '如果你对没发生的事有担心或猜测，单独加一行「猜想：...」；猜想不要混进事实里，没有就不写。',
        `总长不超过 ${Math.max(60, Number(cfg.maxChars) || 200)} 个字，用第一人称。`,
      ].join('\n')
      let out = ''
      try {
        out = await api.ask({ system, text: transcriptOf(lines), maxTokens: 700 })
      } catch (error) {
        api.log.warn('写连续性纸条失败：' + error.message)
        return false
      }
      const raw = String(out || '')
        .replace(/^["'“”『』]+|["'“”『』]+$/g, '')
        .replace(/\s*\n+\s*/g, '；')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, Math.max(60, Number(cfg.maxChars) || 200))
      if (!raw) return false
      let thoughts = ''
      let text = raw
      const tm = raw.match(/猜想：\s*([^；]+)/)
      if (tm) {
        thoughts = tm[1].trim().slice(0, 80)
        text = raw.replace(/猜想：\s*[^；]+/g, '').replace(/；；+/g, '；').replace(/^；|；$/g, '').trim()
      }
      if (!text) return false
      const at = Date.now()
      state.chats[chatId] = {
        at,
        lastT: Math.max(...lines.map((l) => Number(l.t) || 0)),
        text,
        thoughts,
        who,
        kind: chat.kind,
        source: 'auto',
      }
      save()
      api.log.info(`给 ${chatId} 留了一张连续性纸条（${text.length} 字）`)
      return true
    }

    async function tick() {
      if (busy || !api.settings().enabled) return
      busy = true
      try {
        const byChat = new Map()
        const hub = api.core.hub
        for (const dk of [dayKey(new Date(Date.now() - DAY)), dayKey()]) {
          let rows = []
          try { rows = hub.chatLogOf?.(dk) || [] } catch (error) { rows = [] }
          for (const l of rows) {
            if (!l || !String(l.chatId || '').startsWith('group:') && !String(l.chatId || '').startsWith('private:')) continue
            if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
            byChat.get(l.chatId).push(l)
          }
        }
        const candidates = [...byChat.entries()]
          .map(([chatId, lines]) => ({ chatId, lines: lines.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0)) }))
          .filter(({ lines }) => lines.some((l) => !isBot(l.who)))
          .sort((a, b) => (Number(b.lines.at(-1)?.t) || 0) - (Number(a.lines.at(-1)?.t) || 0))
          .slice(0, Math.max(1, Number(api.settings().maxChatsPerRun) || 3))
        for (const { chatId, lines } of candidates) {
          try { await updateChat(chatId, lines) } catch (error) { api.log.warn(`更新 ${chatId} 连续性失败：` + error.message) }
        }
      } finally {
        busy = false
      }
    }

    function noteOf(chatId) {
      return state.chats[String(chatId || '')] || null
    }

    function noteLine(chat) {
      const cfg = api.settings()
      if (!cfg.enabled || !chat || chat.kind === 'system') return ''
      const note = noteOf(chat.chatId)
      if (!note || !note.text) return ''
      const age = Date.now() - (Number(note.at) || 0)
      if (age > Math.max(1, Number(cfg.injectMaxAgeDays) || 7) * DAY) return ''
      const old = age > DAY
      const thoughts = String(note.thoughts || '').trim()
      const extra = thoughts ? `（另外，你自己还有些猜想，不要当成事实说：${thoughts}）` : ''
      return `（${old ? '几天前' : '刚才'}你给自己留的纸条（${whenText(note.at)}）：${note.text}${old ? ' 已经有点模糊了，别当成刚发生的事。' : ''}${extra}）`
    }

    api.context(({ chat }) => noteLine(chat))

    api.tool((where) => {
      if (!where.chat || where.chat.kind === 'system') return []
      return api.defineTool({
        name: 'self_note',
        description: '给自己留一张只有你看得见的小纸条：现在的心情、没聊完的事、下次想怎么接。觉得这件事你不想忘、或者怕明天接不上时用。',
        properties: {
          text: { type: 'string', description: '纸条内容，第一人称，简短，不超过 200 字' },
        },
        required: ['text'],
        execute: async ({ text }) => {
          const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(60, Number(api.settings().maxChars) || 200))
          if (!t) return { ok: false, message: '纸条是空的' }
          state.chats[where.chat.chatId] = {
            at: Date.now(),
            lastT: Number(noteOf(where.chat.chatId)?.lastT) || Date.now(),
            text: t,
            thoughts: '',
            who: noteOf(where.chat.chatId)?.who || '',
            kind: where.chat.kind,
            source: 'self',
          }
          save()
          return { ok: true, message: '✓' }
        },
      })
    })

    api.route('/state', async () => ({ ok: true, settings: api.settings(), chats: state.chats }))
    api.route('/rebuild', async (req) => {
      const chatId = String(api.core.http.query(req).chat || '')
      if (!chatId) return { ok: false, message: '缺少 chat' }
      const lines = linesOf(chatId)
      const ok = await updateChat(chatId, lines)
      return { ok, note: noteOf(chatId) }
    })
    api.route('/clear', async (req) => {
      const chatId = String(api.core.http.query(req).chat || '')
      if (!chatId) return { ok: false, message: '缺少 chat' }
      delete state.chats[chatId]
      save()
      return { ok: true }
    })

    api.command({
      name: '纸条',
      desc: '看看她在这个聊天里给自己留的连续性纸条',
      run: async (arg, msg) => {
        const note = noteOf(msg?.chatId)
        if (!note) return '这个聊天还没有纸条。'
        return `[${whenText(note.at)}] ${note.text}`
      },
    })

    api.every(Math.max(5, Number(api.settings().intervalMinutes) || 10) * 60_000, tick, '连续性纸条')
    api.later(45_000, tick)
    api.log.info('连续性纸条已挂上（每 10 分钟看一次，只注入当前聊天）')

    return { noteOf, updateChat, tick, state: () => state }
  },
}
