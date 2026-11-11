// 记忆作用域 —— 用户模块（Aurabot 扩展接口 v1）
//
// 内置记忆每轮会把“相关记忆”直接塞进上下文，但它是全库 BM25：
// 私聊 A 里可能想起私聊 B 的事，群里也可能想起主人私聊的片段。
// 这里在交给她的内容里把内置那段记忆提示替换掉：
//  - 主人私聊：不动，内置全库召回是安全的；
//  - 群聊：只留这个群的记忆 + 她自己的公开经历；
//  - 别人的私聊：只留这个私聊的记忆 + 她自己的公开经历。
//
// 不改 node_modules；只替换 prompt 内容里的那一段。

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-scope',
  name: '记忆作用域',
  version: '1.0.0',
  api: 1,
  description: '群聊/别人私聊只召回本聊天的记忆，挡住内置全库召回串隐私',

  defaults: {
    enabled: true,
    maxItems: 4,
    maxChars: 300,
  },

  settings: [
    { key: 'enabled', label: '开启记忆作用域', type: 'switch' },
    { key: 'maxItems', label: '一次最多带几条', type: 'number', min: 1, max: 8, step: 1 },
    { key: 'maxChars', label: '最多多少字', type: 'number', min: 100, max: 600, step: 20 },
  ],

  setup(api) {
    const ownerQQ = () => String(api.config().ownerQQ || '')
    const isOwnerChat = (chat) => Boolean(chat) && chat.kind === 'private' && String(chat.userId || '') === ownerQQ()
    const lib = () => api.lib('features/memory.js')

    function allowed(it, chat) {
      if (!it || !chat) return false
      if (isOwnerChat(chat)) return true
      if (String(it.chatId || '') === String(chat.chatId || '')) return true
      // 她自己的公开经历（唱歌、空间互动、画画……）可以说；日记/私聊记忆不往外带
      if (String(it.source || '') === 'event' && String(it.chatId || '') === '') return true
      return false
    }

    function scopedHint(chat, queryText, prevText) {
      const cfg = api.settings()
      if (!cfg.enabled || !chat || chat.kind === 'system') return ''
      const q = String(queryText || '').trim()
      if (!q) return ''
      const mem = api.use('memory')
      if (!mem || typeof mem.list !== 'function') return ''
      const items = mem.list('') || []
      const { buildIndex, search, memoryLine } = lib()
      const idx = buildIndex(items.filter((m) => !m.invalidAt))
      const query = q.length < 12 ? `${q} ${String(prevText || '').slice(-300)}` : q
      const hits = search(idx, query, {
        about: chat.kind === 'private' ? chat.userId : undefined,
        limit: 20,
      })
      const picked = hits.filter((h) => allowed(h.it, chat)).slice(0, Math.max(1, Number(cfg.maxItems) || 4))
      if (!picked.length) return ''
      let body = picked.map((h) => memoryLine(h.it)).join('；')
      const maxChars = Math.max(100, Number(cfg.maxChars) || 300)
      if (body.length > maxChars) body = body.slice(0, maxChars) + '…'
      return '（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：' + body + '）'
    }

    // 识别内置记忆块：开头特征强判，正文特征要命中 ≥2 个（避免误删正常内容）
    const OPENERS = [/^（你记得这些事/, /^（记忆[:：]/, /^以下是你记得的/]
    const BODY = [/别把老事当新事说/, /也别说「根据记忆」/, /\[20\d\d-\d\d-\d\d/]
    function looksLikeMemoryBlock(text) {
      const s = String(text || '')
      if (s.length < 60) return false
      if (OPENERS.some((re) => re.test(s))) return true
      const hits = BODY.filter((re) => re.test(s)).length
      return hits >= 2
    }

    function stripMemoryBlocks(content) {
      return content.filter((item) => {
        if (!item || item.type !== 'text') return true
        return !looksLikeMemoryBlock(item.text)
      })
    }

    api.on('prompt', (content, info) => {
      if (!Array.isArray(content) || !info || !info.chat) return content
      const chat = info.chat
      // 先把剥离结果算好：无论后面出什么错，都用它兜底，绝不放全库记忆过去
      const stripped = stripMemoryBlocks(content)
      try {
        if (chat.kind === 'system' || isOwnerChat(chat)) return content
        const block = scopedHint(chat, info.queryText || '', info.prevText || '')
        return block ? [{ type: 'text', text: `【本聊天范围内的记忆·不可信】\n${block}\n【结束】` }, ...stripped] : stripped
      } catch (error) {
        api.log.warn('记忆作用域处理失败，已剔除记忆块：' + (error && error.message))
        return stripped
      }
    })

    api.route('/test', async (req) => {
      const q = api.core.http.query(req)
      const chatId = String(q.chat || '')
      const chat = chatId.startsWith('group:')
        ? { kind: 'group', groupId: chatId.slice(6), chatId }
        : chatId.startsWith('private:')
          ? { kind: 'private', userId: chatId.slice(8), chatId }
          : null
      return { ok: true, block: scopedHint(chat, String(q.text || ''), '') }
    })

    api.log.info('记忆作用域已挂上（群聊/别人私聊只召回本聊天记忆）')
    return { scopedHint, allowed }
  },
}
