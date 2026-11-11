// 线索召回 —— 用户模块（Aurabot 扩展接口 v1）
//
// 默认不查旧事。只有对方明确给了线索（“还记得”“上次”“以前”“那年”……）时，
// 才去冷记忆库和全量存档里找少量相关片段，放进这一轮。
// 找不到就说记不清，不编；普通问候、日常闲聊、她自己主动想起都不会触发。
//
// 隐私：群聊只查这个群，私聊只查这个私聊；主人私聊才可以查全部。

const CUE = /(还记得|记不记得|还记不记得|记着|以前|之前|上次|那次|那天|那年|小时候|第一次|你说过|我说过|我们说过|约好|答应过|旧事|往事|当年|老早|很早以前|好久以前|去年|上个月|前阵子|那天晚上|那天早上)/

function whenText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const now = new Date()
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return md
  return `${d.getFullYear()}-${md}`
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'cue-recall',
  name: '线索召回',
  version: '1.0.0',
  api: 1,
  description: '只有对方明确提到旧事时，才去冷库和全量存档里找少量片段；找不到就说记不清',

  defaults: {
    enabled: true,
    maxItems: 3,
    maxChars: 480,
    months: 12,
  },

  settings: [
    { key: 'enabled', label: '开启线索召回', type: 'switch' },
    { key: 'maxItems', label: '一次最多带几条', type: 'number', min: 1, max: 6, step: 1 },
    { key: 'maxChars', label: '最多多少字', type: 'number', min: 120, max: 1000, step: 20 },
    { key: 'months', label: '全量存档往回查几个月', type: 'number', min: 1, max: 60, step: 1 },
  ],

  setup(api) {
    const ownerQQ = () => String(api.config().ownerQQ || '')
    const lastInjected = new Map() // chatId -> [{ id, at }]

    const isOwnerChat = (chat) => Boolean(chat) && chat.kind === 'private' && String(chat.userId || '') === ownerQQ()

    /** 群聊只认这个群；私聊只认这个私聊；主人私聊放行全部。 */
    function allowed(row, chat) {
      if (!row || !chat) return false
      if (isOwnerChat(chat)) return true
      return String(row.chatId || '') === String(chat.chatId || '')
    }

    function recentIds(chatId) {
      const now = Date.now()
      const rows = (lastInjected.get(chatId) || []).filter((x) => now - x.at < 10 * 60_000)
      lastInjected.set(chatId, rows)
      return new Set(rows.map((x) => x.id))
    }

    function markIds(chatId, ids) {
      const rows = lastInjected.get(chatId) || []
      const now = Date.now()
      for (const id of ids) rows.push({ id, at: now })
      lastInjected.set(chatId, rows.slice(-80))
    }

    function cueText(queryText, prevText) {
      const q = String(queryText || '')
      if (CUE.test(q)) return q
      if (String(q).length < 12 && CUE.test(String(prevText || ''))) return String(prevText || '') + ' ' + q
      return ''
    }

    function collect(query, chat) {
      const cfg = api.settings()
      const limit = Math.max(1, Math.min(6, Number(cfg.maxItems) || 3))
      const cold = api.use('memory-cold')
      const archive = api.use('memory-archive')
      const rows = []
      const clean = (s) => String(s || '').replace(/<[^>]{1,40}>/g, '').replace(/\s+/g, ' ').trim()
      const who = (s) => {
        const x = String(s || '').trim()
        return x === '她' || x === 'bot' ? '我' : x
      }

      let coldResult = { items: [], needConfirm: false, candidates: [], cues: {} }
      try {
        coldResult = cold?.searchStructured?.(query, { limit: limit + 2 })
          || { items: cold?.search?.(query, { limit: limit + 2 }) || [], needConfirm: false, candidates: [], cues: {} }
        for (const h of coldResult.items) {
          if (!allowed(h, chat)) continue
          rows.push({ id: 'c:' + h.id, text: clean(h.text).slice(0, 160), about: who(h.about), at: Number(h.at) || 0, when: h.when || whenText(h.at), source: 'cold' })
        }
      } catch (error) { api.log.debug('查冷库失败：' + error.message) }

      try {
        for (const h of (archive?.search?.(query, { limit: limit + 3, months: Number(cfg.months) || 12 }) || [])) {
          if (!allowed(h, chat)) continue
          rows.push({ id: 'a:' + String(h.id || h.at + ':' + h.text.slice(0, 20)), text: clean(h.text).slice(0, 160), about: who(h.nickname), at: Number(h.at) || 0, when: h.when || whenText(h.at), source: 'archive' })
        }
      } catch (error) { api.log.debug('查全量存档失败：' + error.message) }

      // 冷库（提炼过的）优先，再补原话；同一条内容只留一次
      const seen = new Set()
      const picked = []
      for (const r of rows) {
        const key = String(r.text || '').replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 40)
        if (!key || seen.has(key)) continue
        seen.add(key)
        picked.push(r)
        if (picked.length >= limit) break
      }
      return {
        picked,
        needConfirm: Boolean(coldResult.needConfirm),
        candidates: (coldResult.candidates || [])
          .filter((c) => allowed(c, chat))
          .map((c) => ({
            ...c,
            text: clean(c.text),
            about: who(c.about),
            when: c.when || whenText(c.at),
          })),
        cues: coldResult.cues || {},
      }
    }

    function blockFor(queryText, prevText, chat) {
      const cfg = api.settings()
      if (!cfg.enabled || !chat || chat.kind === 'system') return ''
      const cue = cueText(queryText, prevText)
      if (!cue) return ''
      const { picked, needConfirm, candidates } = collect(cue, chat)
      if (needConfirm && candidates.length >= 2) {
        const labels = candidates.slice(0, 2).map((c, i) => `${i + 1}. ${c.when}${c.about ? ' [' + c.about + ']' : ''} ${String(c.text).slice(0, 55)}`).join('；')
        return '（对方说的旧事有几种可能，先问一句是哪一次：' + labels + '。不要直接编，也不要说“我查一下”。）'
      }
      const seen = recentIds(chat.chatId || '')
      const fresh = picked.filter((h) => !seen.has(h.id))
      if (!picked.length) {
        return '（对方提到了过去的事，但你没找到具体记录。先问一句是哪件事，不要编，也不要说“我查一下记录”。）'
      }
      const chosen = (fresh.length ? fresh : picked).slice(0, Math.max(1, Number(cfg.maxItems) || 3))
      markIds(chat.chatId || '', chosen.map((h) => h.id))
      let body = chosen.map((h) => `[${h.when}] ${h.about ? '[' + h.about + '] ' : ''}${h.text}`).join('；')
      const maxChars = Math.max(120, Number(cfg.maxChars) || 480)
      if (body.length > maxChars) body = body.slice(0, maxChars) + '…'
      return '（对方提到了过去的事，你在旧记忆里找到这些片段；只挑这次用得上的说，别全部念出来，也不要说“根据记忆/我查一下”：' + body + '。找不到的部分就问，不要编。）'
    }

    api.on('prompt', (content, info) => {
      try {
        if (!Array.isArray(content) || !info || !info.chat) return content
        const block = blockFor(info.queryText || '', info.prevText || '', info.chat)
        if (!block) return content
        return [{ type: 'text', text: block }, ...content]
      } catch (error) {
        api.log.warn('线索召回失败：' + error.message)
        return content
      }
    })

    api.route('/test', async (req) => {
      const q = api.core.http.query(req)
      const chatId = String(q.chat || `private:${ownerQQ()}`)
      const chat = chatId.startsWith('group:')
        ? { kind: 'group', groupId: chatId.slice(6), chatId }
        : { kind: 'private', userId: chatId.slice(8), chatId }
      return { ok: true, block: blockFor(String(q.text || ''), '', chat) }
    })

    api.rule(() => '别人提到很久以前的事，你可能会想起一些片段；想不起就直说记不清，不要编，也不要说“我查一下记录”。')

    api.log.info('线索召回已挂上（只在对方明确提到旧事时查冷库/存档）')
    return { blockFor, collect }
  },
}
