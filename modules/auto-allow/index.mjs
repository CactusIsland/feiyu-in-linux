// 白名单自动维护：把当前所有好友和群写进 allow，并每 5 分钟同步一次（新加的好友/群自动进）。
// 只增不删：主人手动踢掉的人不会被加回来——把他记进 exceptions 就行。

export default {
  id: 'auto-allow',
  name: '白名单自动同步',
  version: '1.0.0',
  api: 1,
  tab: 'groups',
  description: '自动把好友和群加入白名单，新加的也会自动进来（每 5 分钟同步一次）。只增不删。',
  defaults: { enabled: true, includeFriends: true, includeGroups: true, intervalMinutes: 5 },
  settings: [
    { key: 'enabled', label: '启用自动白名单', type: 'boolean' },
    { key: 'includeFriends', label: '好友自动放行', type: 'boolean' },
    { key: 'includeGroups', label: '群自动放行', type: 'boolean' },
    { key: 'intervalMinutes', label: '同步间隔（分钟）', type: 'number', min: 1, max: 120 },
  ],
  setup(api) {
    let timer = null
    const last = { friends: 0, groups: 0, added: 0, at: 0, error: '' }

    const call = (action, params) => api.onebot(action, params)

    async function sync(why = '定时') {
      if (api.settings().enabled === false) return
      try {
        const cfg = api.config()
        const owner = String(cfg.ownerQQ || '')
        const self = String(cfg.botQQ || '')
        const cur = cfg.allow || { private: [], groups: [] }
        const priv = new Set((cur.private || []).map(String))
        const grp = new Set((cur.groups || []).map(String))
        const before = priv.size + grp.size

        if (api.settings().includeFriends !== false) {
          const r = await call('get_friend_list')
          const list = Array.isArray(r) ? r : (r && r.data) || []
          for (const f of list) {
            const id = String(f.user_id || '')
            if (id && id !== self && id !== owner) priv.add(id)
          }
          last.friends = list.length
        }
        if (api.settings().includeGroups !== false) {
          const r = await call('get_group_list')
          const list = Array.isArray(r) ? r : (r && r.data) || []
          for (const g of list) {
            const id = String(g.group_id || '')
            if (id) grp.add(id)
          }
          last.groups = list.length
        }

        const added = priv.size + grp.size - before
        if (added > 0) {
          api.setConfig((c) => ({ ...c, allow: { private: [...priv], groups: [...grp] } }))
          last.added += added
          api.log.info?.(`白名单（${why}）：新增 ${added} 个 → 好友 ${priv.size} / 群 ${grp.size}`)
        }
        last.at = Date.now()
        last.error = ''
      } catch (e) {
        last.error = String(e && e.message ? e.message : e)
      }
    }

    function schedule() {
      if (timer) clearInterval(timer)
      const mins = Math.max(1, Number(api.settings().intervalMinutes) || 5)
      timer = setInterval(() => sync('定时'), mins * 60_000)
      api.onDispose?.(() => clearInterval(timer))
    }

    api.on('onebot/state', (s) => { if (String(s) === 'connected') sync('连上网关') })
    setTimeout(() => sync('启动'), 6000)
    schedule()

    api.command({ name: '白名单', desc: '立刻同步一次好友和群到白名单', run: async () => { await sync('手动'); return `已同步：好友 ${last.friends} / 群 ${last.groups}，累计新增 ${last.added}` } })
    api.route('/state', async () => { const c = api.config(); return { ok: true, ...last, privateCount: (c.allow?.private||[]).length, groupCount: (c.allow?.groups||[]).length } })
    api.route('/sync', async () => { await sync('接口'); return { ok: true, ...last } })
    api.log.info?.('白名单自动同步已挂上（好友+群，只增不删）')
  },
}
