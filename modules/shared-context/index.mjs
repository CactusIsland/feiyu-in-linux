// 共享上下文 —— 用户模块（Aurabot 扩展接口 v1）
//
// 目标：会话是每个聊天各一段，重置就没了；这里再叠一层「跨聊天的近期上下文」。
// 做法：所有她会处理的聊天，来一条就记一条；每轮给任何聊天注入一小段「最近别处聊到的」，
//       所以 QQ 私聊能看到群里/微信刚发生的事，反之亦然。数据落盘，重置会话不影响。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ITEMS = 300
const DIGEST_LINES = 10
const LINE_CHARS = 42

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'shared-context',
  name: '共享上下文',
  version: '1.0.0',
  api: 1,
  description: '跨聊天的近期上下文：任何聊天都能看到别处刚聊了什么（存盘，重置不丢）',

  setup(api) {
    const file = () => join(api.dataDir(), 'recent.json')
    const load = () => {
      try { return JSON.parse(readFileSync(file(), 'utf8')) || { items: [] } } catch (error) { return { items: [] } }
    }
    const save = (s) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(file(), JSON.stringify(s)) } catch (error) { api.log.warn('共享上下文写入失败：' + error.message) }
    }

    const short = (t, n = LINE_CHARS) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim()
      return s.length > n ? s.slice(0, n) + '…' : s
    }
    const labelOf = (msg) => {
      const kind = msg.kind === 'group' ? '群' : msg.kind === 'private' ? '私聊' : '别的'
      const name = msg.nickname || (msg.kind === 'group' ? String(msg.groupId || '') : String(msg.userId || ''))
      return `${kind}·${name || '?'}`
    }

    api.on('message', (msg) => {
      if (!msg || !msg.text) return false
      const s = load()
      s.items.push({ at: Date.now(), chatId: msg.chatId, label: labelOf(msg), text: short(msg.text) })
      if (s.items.length > MAX_ITEMS) s.items = s.items.slice(-MAX_ITEMS)
      save(s)
      return false
    })

    const isOwnerChat = (chat) => Boolean(chat) && chat.kind === 'private' && String(chat.userId || '') === String(api.config().ownerQQ || '')

    function digest(excludeChatId = '', chat = null) {
      const s = load()
      const since = Date.now() - 24 * 3600_000
      const rows = s.items.filter((x) => {
        if (x.at < since || x.chatId === excludeChatId) return false
        if (!chat) return true
        // 主人私聊可以看到全部；群聊只能看到别的群（不带任何私聊内容）；别人的私聊不串
        if (isOwnerChat(chat)) return true
        if (chat.kind === 'group') return String(x.chatId || '').startsWith('group:')
        return false
      }).slice(-DIGEST_LINES)
      if (!rows.length) return ''
      return '【最近别处聊到的】\n' + rows.map((x) => `${x.label}：${x.text}`).join('\n')
    }

    api.context(({ chat }) => {
      if (!chat || chat.kind === 'system') return ''
      return digest(chat.chatId || '', chat)
    })

    api.route('/digest', async (req) => {
      const q = api.core.http.query(req)
      const chatId = String(q.chat || '')
      const chat = chatId.startsWith('group:')
        ? { kind: 'group', groupId: chatId.slice(6), chatId }
        : chatId.startsWith('private:')
          ? { kind: 'private', userId: chatId.slice(8), chatId }
          : null
      return { ok: true, digest: digest(String(q.exclude || ''), chat), items: load().items.length }
    })

    api.log.info('共享上下文已挂上（跨聊天近期对话互通，落盘不随重置丢）')
    return { digest }
  },
}
