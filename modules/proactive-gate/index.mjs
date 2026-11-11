// 主动提起门控 —— 用户模块（Aurabot 扩展接口 v1）
//
// 她主动找人说话时，很容易“为了说点什么”硬翻旧事，或者把自己的担心说成发生过的。
// 这里在主动回合的提示里加一段门槛，并把“事实/猜想分开”写成一条常驻规则。
//
// 不拦截她的话，只影响她怎么想；真正的发言仍由她自己决定。

const PROACTIVE = /(【系统提醒|主动搭话|主动找|主动开口|purpose|目的回合|你想不想主动)/i

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'proactive-gate',
  name: '主动提起门控',
  version: '1.0.0',
  api: 1,
  description: '主动找话时，先判断旧事该不该提；事实和猜想分开，不把猜的当发生过',

  defaults: {
    enabled: true,
  },

  settings: [
    { key: 'enabled', label: '开启主动提起门控', type: 'switch' },
  ],

  setup(api) {
    const block = '（这次是你主动找话说，不是对方先问。不要为了有话说就硬翻旧事：只有和现在确实相关、不是刚说过、对方这会儿可能想听，才提。你记得的是发生过的事；你自己想的、担心的、猜的，不要当成事实说出来。）'

    api.on('prompt', (content, info) => {
      try {
        if (!api.settings().enabled) return content
        if (!Array.isArray(content) || !info) return content
        const q = String(info.queryText || '')
        if (!PROACTIVE.test(q)) return content
        return [{ type: 'text', text: block }, ...content]
      } catch (error) {
        api.log.warn('主动提起门控失败：' + error.message)
        return content
      }
    })

    api.rule(() => '你记得的是发生过的事；你自己的想法、担心、猜测，不要当成事实说。主动提起旧事之前，先判断有没有关系、是不是刚说过、对方现在想不想听；不确定就不提。')

    api.route('/test', async (req) => {
      const q = String(api.core.http.query(req).text || '')
      return { ok: true, proactive: PROACTIVE.test(q), block: PROACTIVE.test(q) ? block : '' }
    })

    api.log.info('主动提起门控已挂上（主动回合加门槛；事实/猜想分开）')
    return { block }
  },
}
