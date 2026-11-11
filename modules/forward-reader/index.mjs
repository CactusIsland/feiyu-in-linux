// 合并转发读取 —— 用户模块（Aurabot 扩展接口 v1）
//
// 很多网关把「合并转发」当成 json 卡片（com.tencent.multimsg）送过来，插件只认 forward 段，
// 于是她只看到「[合并转发]」占位、里面内容拉不到。
// 这里在消息进 hub 之前扫一遍原始段，把 resid 抽出来补进 msg.forwards，让 hub 正常展开。

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'forward-reader',
  name: '合并转发读取',
  version: '1.0.0',
  api: 1,
  description: '识别 json 卡片形式的合并转发，抽出 resid 让插件展开内容',

  setup(api) {
    const segsOf = (msg) => {
      const raw = msg?.raw || {}
      if (Array.isArray(raw.message)) return raw.message
      if (Array.isArray(raw)) return raw
      if (raw.original?.message) return raw.original.message
      return []
    }

    const idsFromJson = (data) => {
      const text = typeof data === 'string' ? data : JSON.stringify(data || {})
      const out = []
      for (const re of [/"resid"\s*:\s*"([^"]+)"/gi, /"res_id"\s*:\s*"([^"]+)"/gi, /"fileid"\s*:\s*"([^"]+)"/gi]) {
        for (const m of text.matchAll(re)) if (m[1]) out.push(m[1])
      }
      // 只有 multimsg 卡片才当合并转发，别的 json 卡片别乱拉
      return /multimsg|合并转发|forward/i.test(text) ? out : []
    }

    api.on('message', async (msg) => {
      if (!msg) return false
      try {
        const ids = []
        for (const seg of segsOf(msg)) {
          if (!seg) continue
          if (seg.type === 'forward') {
            const id = String(seg.data?.id ?? seg.data?.res_id ?? seg.data?.forward_id ?? '')
            if (id) ids.push(id)
          } else if (seg.type === 'json') {
            ids.push(...idsFromJson(seg.data?.data ?? seg.data))
          }
        }
        const uniq = [...new Set(ids)].filter(Boolean)
        if (!uniq.length) return false
        msg.forwards = [...new Set([...(msg.forwards || []), ...uniq])]
        if (!String(msg.text || '').includes('[合并转发]')) {
          msg.text = (msg.text ? msg.text + ' ' : '') + '[合并转发]'
        }
        api.log.info(`合并转发：识别到 ${uniq.length} 个 id，交给插件展开`)
      } catch (error) {
        api.log.debug('forward-reader 出错：' + error.message)
      }
      return false
    })

    api.log.info('合并转发读取已挂上（json 卡片也能展开）')
    return {}
  },
}
