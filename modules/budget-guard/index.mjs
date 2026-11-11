// 请求前预算 —— 用户模块（Aurabot 扩展接口 v1）
//
// 会话历史的大头靠 session-budget 轮转；这里管“每轮额外塞进去的记忆块”：
// 记忆、线索召回、连续性纸条、跨聊天摘要加起来太长时，按优先级丢掉最低的几块。
// 只在发给模型前裁剪，不改存储、不改她记得的东西。

const SHARED = '【最近别处聊到的】'
const CONTINUITY = ['（刚才你给自己留的纸条', '（几天前你给自己留的纸条']
const CUE = ['（对方提到了过去的事', '（对方说的旧事有几种可能']
const MEMORY = ['（你记得这些事']

const starts = (text, arr) => arr.some((p) => String(text || '').startsWith(p))

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'budget-guard',
  name: '请求前预算',
  version: '1.0.0',
  api: 1,
  description: '每轮额外注入的记忆块太长时，按优先级裁掉最低的，避免上下文虚胖',

  defaults: {
    enabled: true,
    maxInjectedChars: 1200,
    dropMemory: false,
  },

  settings: [
    { key: 'enabled', label: '开启请求前预算', type: 'switch' },
    { key: 'maxInjectedChars', label: '额外注入最多多少字', type: 'number', min: 400, max: 4000, step: 100 },
    { key: 'dropMemory', label: '实在超了就丢内置记忆块', type: 'switch', hint: '默认不丢；先丢跨聊天摘要、连续性、线索召回' },
  ],

  setup(api) {
    const lastLog = new Map()

    const kindOf = (item) => {
      if (!item || item.type !== 'text') return ''
      const text = String(item.text || '')
      if (text.startsWith(SHARED)) return 'shared'
      if (starts(text, CONTINUITY)) return 'continuity'
      if (starts(text, CUE)) return 'cue'
      if (starts(text, MEMORY)) return 'memory'
      return ''
    }

    const totalChars = (content) => content.reduce((n, item) => n + (item && item.type === 'text' ? String(item.text || '').length : 0), 0)

    api.on('prompt', (content, info) => {
      try {
        if (!api.settings().enabled || !Array.isArray(content)) return content
        const max = Math.max(400, Number(api.settings().maxInjectedChars) || 1200)
        if (totalChars(content) <= max) return content

        const order = api.settings().dropMemory ? ['shared', 'continuity', 'cue', 'memory'] : ['shared', 'continuity', 'cue']
        for (const kind of order) {
          const filtered = content.filter((item) => kindOf(item) !== kind)
          if (filtered.length !== content.length) {
            const chatId = String((info && info.chat && info.chat.chatId) || '')
            const now = Date.now()
            const last = Number(lastLog.get(chatId)) || 0
            if (now - last > 10 * 60_000) {
              lastLog.set(chatId, now)
              api.log.info(`请求前预算：${chatId || '这个聊天'} 超过 ${max} 字，丢掉 ${kind} 块（${totalChars(content)} → ${totalChars(filtered)}）`)
            }
            content = filtered
          }
          if (totalChars(content) <= max) break
        }
        return content
      } catch (error) {
        api.log.warn('请求前预算失败：' + error.message)
        return content
      }
    })

    api.log.info('请求前预算已挂上（先丢跨聊天摘要，再丢连续性/线索；默认不丢内置记忆）')
    return { kindOf, totalChars }
  },
}
