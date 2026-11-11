// 人格库快捷切换 —— 用户模块（Aurabot 扩展接口 v1）
//
// 参考 dsh-persona-dafeiyu 的「人格库 + 一键切换」思路，做成 QQ 里的轻量命令：
//   /人格            看当前人格和可用人格
//   /人格 切换 dafeiyu
// 只切 config.persona.current，下一条消息生效，不重启。
// 作用域仍是全局（Aurabot 的 persona 变量不分聊天）；按群/按会话的人格需要改插件内核，没做。

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'persona-switch',
  name: '人格快捷切换',
  version: '1.0.0',
  api: 1,
  description: 'QQ 里用人格库快速查看/切换人格；全局生效，下一条消息用新人格',

  defaults: {
    enabled: true,
  },

  settings: [
    { key: 'enabled', label: '开启人格快捷切换', type: 'switch' },
  ],

  setup(api) {
    const list = () => {
      try { return api.core.personas?.list?.() || [] } catch (error) { return [] }
    }
    const current = () => String(api.config().persona?.current || '')

    function findPersona(arg) {
      const want = String(arg || '').trim()
      if (!want) return null
      const all = list()
      return all.find((p) => p.id === want)
        || all.find((p) => String(p.name || '') === want)
        || all.find((p) => String(p.name || '').includes(want))
        || null
    }

    api.command({
      name: '人格',
      desc: '看可用人格；/人格 切换 <id 或名字> 切换人格',
      run: async (arg) => {
        if (!api.settings().enabled) return '人格快捷切换没开。'
        const a = String(arg || '').trim()
        if (!a || /^(列表|list)$/i.test(a)) {
          const all = list()
          if (!all.length) return `当前人格：${current() || '（没设置）'}；人格库是空的。`
          return `当前人格：${current() || '（没设置）'}；可用：${all.map((p) => `${p.id}${p.name ? '（' + p.name + '）' : ''}`).join('、')}`
        }
        const action = a.replace(/^(切换|用|换|切)\s*/i, '').trim()
        const p = findPersona(action)
        if (!p) return `没找到人格「${action}」。可用：${list().map((x) => x.id).join('、') || '（空）'}`
        api.setConfig({ persona: { current: p.id } })
        return `人格已切换到「${p.id}${p.name ? ' · ' + p.name : ''}」，下一条消息生效。`
      },
    })

    api.route('/list', async () => ({ ok: true, current: current(), items: list() }))
    api.log.info('人格快捷切换已挂上（/人格、/人格 切换 <id>）')
    return { list, current, findPersona }
  },
}
