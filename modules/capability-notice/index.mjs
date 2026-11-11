// 能力更新通告：每次我加了新能力，走这里让她（和主人）都知道。
//   ① 写进她的长期记忆（tags: 能力/self），下次聊天能被召回
//   ② 可选：往她的会话里塞一条系统提示，让当前这一轮就知道
//   ③ 可选：往主人 QQ 推一条确认

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const DIR = DSH + '/plugins-data/aurabot/modules-data/capability-notice'
const FILE = DIR + '/notices.json'

function readLog() {
  try { const j = JSON.parse(readFileSync(FILE, 'utf8')); if (Array.isArray(j.items)) return j } catch {}
  return { items: [] }
}

export default {
  id: 'capability-notice',
  name: '能力通告',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '把「新增了什么能力」写进她的记忆并可选推送，避免她不知道新工具而回「我没有这个通道」。',
  setup(api) {
    async function post({ title, detail, push = false, notify = false }) {
      const text = String(detail || title || '').trim()
      if (!text) return { ok: false, message: '没有内容' }
      const at = Date.now()

      let memorized = false
      try {
        const memory = api.use('memory')
        if (memory && typeof memory.addEvent === 'function') {
          memory.addEvent({ text: `我新增了能力：${text}`, tags: ['能力', 'self'], importance: 0.85 })
          memorized = true
        }
      } catch (e) {}

      let pushed = false
      if (push) {
        try {
          const hub = api.core.hub
          const owner = String(api.config().ownerQQ)
          const chat = { chatId: 'private:' + owner, kind: 'private', userId: owner }
          await hub.pushToSession(chat, [{ type: 'text', text: `【能力更新】${text}` }], owner, { steer: true })
          pushed = true
        } catch (e) {}
      }

      let notified = false
      if (notify) {
        try {
          await api.sendText('private:' + api.config().ownerQQ, `能力已更新：${String(title || text).slice(0, 120)}`)
          notified = true
        } catch (e) {}
      }

      const log = readLog()
      log.items = [...(log.items || []), { at, title: String(title || '').slice(0, 80), detail: text.slice(0, 300), memorized, pushed, notified }].slice(-100)
      try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(log, null, 1)) } catch {}

      api.log.info?.(`能力通告：${String(title || text).slice(0, 60)}（记忆 ${memorized ? '✓' : '×'} 推送 ${pushed ? '✓' : '×'} 通知 ${notified ? '✓' : '×'}）`)
      return { ok: true, memorized, pushed, notified }
    }

    api.route('/post', async (req) => {
      const ip = String((req.socket && req.socket.remoteAddress) || '')
      if (!/(127\.0\.0\.1|::1|10\.6\.0\.11)/.test(ip)) return { ok: false, message: '只能本机调用' }
      let b = {}
      try { let raw = ''; for await (const c of req) raw += c; b = raw.trim().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) } catch {}
      return await post(b)
    })
    api.route('/list', async () => ({ ok: true, ...readLog() }))
    api.route('/state', async () => { const l = readLog(); return { ok: true, count: (l.items || []).length, last: (l.items || []).slice(-3) } })

    api.command({ name: '新能力', desc: '/新能力 <说明> —— 记录一条能力更新', run: async (arg, msg) => {
      if (String((msg && msg.userId) || '') !== String(api.config().ownerQQ)) return '这个只有主人能用'
      const r = await post({ title: arg, detail: arg })
      return r.ok ? '记下了，她会记得自己有这个能力' : '没记成功'
    } })

    api.log.info?.('能力通告已就绪（/post）')
  },
}
