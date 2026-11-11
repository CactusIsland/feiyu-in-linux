// 名单管家 —— 用户模块（Aurabot 扩展接口 v1）
//
// 主人直接在 QQ 私聊里说人话就能改白名单：
//   「可以和次元聚集地聊天」  → 群加进 allow.groups
//   「可以和 YOUR_QQ 聊天」→ 人加进 allow.private
//   「不要和某某聊了」        → 移出名单
//   「只和我聊」              → 清空名单
//   「名单」                  → 看现在谁能聊
// 名字会先在群列表、好友列表里找，找不到再当 QQ 号 / 群号用。

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'allow-manager',
  name: '聊天名单',
  version: '1.0.0',
  api: 1,
  description: '在 QQ 里说「可以和某某聊天」就能改群/好友白名单',

  setup(api) {
    const owner = () => String(api.config().ownerQQ || '')
    const cfg = () => api.config()
    const allow = () => ({ private: [], groups: [], ...(cfg().allow || {}) })

    const norm = (s) => String(s || '').replace(/^[\s@「」"'“”]+|[\s「」"'“”]+$/g, '').trim()

    async function groupList() {
      try { const r = await api.onebot('get_group_list', {}); return r || [] } catch (error) { return [] }
    }
    async function friendList() {
      try { const r = await api.onebot('get_friend_list', {}); return r || [] } catch (error) { return [] }
    }

    /** 把「名字 / 号码」解析成 { kind: 'group'|'private', id, name }。 */
    async function resolve(raw) {
      const name = norm(raw)
      if (!name) return null
      const groups = await groupList()
      const friends = await friendList()

      const gHit = groups.find((g) => String(g.group_name || '').trim() === name) || groups.find((g) => String(g.group_name || '').includes(name))
      if (gHit) return { kind: 'group', id: String(gHit.group_id), name: gHit.group_name }

      const fHit = friends.find((f) => String(f.remark || '').trim() === name) || friends.find((f) => String(f.nickname || '').trim() === name) ||
        friends.find((f) => String(f.remark || '').includes(name) || String(f.nickname || '').includes(name))
      if (fHit) return { kind: 'private', id: String(fHit.user_id), name: fHit.remark || fHit.nickname }

      if (/^\d{5,}$/.test(name)) {
        const isGroup = groups.some((g) => String(g.group_id) === name)
        return { kind: isGroup ? 'group' : 'private', id: name, name }
      }
      return null
    }

    function write(allowPatch) {
      api.setConfig((current) => ({ ...current, allow: { ...(current.allow || {}), ...allowPatch } }))
    }

    function addTarget(t) {
      const a = allow()
      if (t.kind === 'group') {
        if (a.groups.includes(t.id)) return { changed: false, message: `「${t.name}」本来就能聊` }
        write({ groups: [...a.groups, t.id] })
        return { changed: true, message: `好，「${t.name}」加进来了，群里叫我「大肥鱼」就行` }
      }
      if (a.private.includes(t.id)) return { changed: false, message: `「${t.name}」本来就能聊` }
      write({ private: [...a.private, t.id] })
      return { changed: true, message: `好，${t.name}（${t.id}）可以聊了` }
    }

    function removeTarget(t) {
      const a = allow()
      if (t.kind === 'group') {
        if (!a.groups.includes(t.id)) return { changed: false, message: `「${t.name}」本来就不在名单里` }
        write({ groups: a.groups.filter((x) => x !== t.id) })
        return { changed: true, message: `好，「${t.name}」不理了` }
      }
      if (!a.private.includes(t.id)) return { changed: false, message: `「${t.name}」本来就不在名单里` }
      write({ private: a.private.filter((x) => x !== t.id) })
      return { changed: true, message: `好，不理 ${t.name} 了` }
    }

    /** 解析一句人话，返回要做的事（不执行）。 */
    async function parse(text) {
      const t = String(text || '').trim()
      if (!t) return null
      if (/^(名单|白名单|谁能聊|能聊的)$/.test(t)) return { action: 'list' }

      let m = t.match(/^(?:可以|允许|让|给)(?:让)?(?:和|跟|与)?(.+?)(?:也)?(?:能)?(?:聊天|聊|说话|进群|进来)(?:了|吧|啦)?$/)
      if (m) return { action: 'add', target: await resolve(m[1]) }
      m = t.match(/^加(?:上)?(?:和|跟|与)?(.+?)(?:进|到)(?:白名单|聊天名单|名单|群)$/)
      if (m) return { action: 'add', target: await resolve(m[1]) }
      m = t.match(/^(?:不要|别|不用|不准)(?:再)?(?:让|和|跟|理)?(.+?)(?:聊天|聊|说话了?)?(?:了|吧|啦)?$/)
      if (m) return { action: 'remove', target: await resolve(m[1]) }
      m = t.match(/^(?:移除|删掉|踢掉|去掉)(.+?)(?:的)?(?:白名单|名单)?$/)
      if (m) return { action: 'remove', target: await resolve(m[1]) }
      if (/^(只和我聊|清空名单|谁都不许聊|都不要聊)$/.test(t)) return { action: 'clear' }
      return null
    }

    async function listing() {
      const a = allow()
      const groups = await groupList()
      const friends = await friendList()
      const gName = (id) => (groups.find((g) => String(g.group_id) === id) || {}).group_name || id
      const fName = (id) => {
        const f = friends.find((x) => String(x.user_id) === id)
        return f ? (f.remark || f.nickname) : id
      }
      const lines = []
      if (a.groups.length) lines.push('群：' + a.groups.map((id) => `${gName(id)}(${id})`).join('、'))
      if (a.private.length) lines.push('人：' + a.private.map((id) => `${fName(id)}(${id})`).join('、'))
      lines.push(`主人：${owner()}（永远能聊）`)
      return lines.join('\n')
    }

    api.route('/parse', async (req) => {
      const text = String(api.core.http.query(req).text || '')
      const r = await parse(text)
      return { ok: true, text, parsed: r }
    })
    api.route('/list', async () => ({ ok: true, text: await listing(), allow: allow() }))

    api.command({
      name: '名单',
      desc: '看现在谁能和她聊',
      run: async () => await listing(),
    })

    api.on('message', async (msg) => {
      if (!msg || String(msg.chatId || '').indexOf('private:') !== 0) return false
      if (String(msg.userId) !== owner()) return false
      const r = await parse(msg.text)
      if (!r) return false

      let reply = ''
      if (r.action === 'list') reply = await listing()
      else if (r.action === 'clear') { write({ private: [], groups: [] }); reply = '好，只跟我聊' }
      else if (!r.target) reply = '没找到这个人或群，把 QQ 号/群号发我也行'
      else if (r.action === 'add') reply = addTarget(r.target).message
      else if (r.action === 'remove') reply = removeTarget(r.target).message

      await api.reply(msg, reply)
      return true
    })

    api.log.info('聊天名单管家已挂上（QQ 里说「可以和某某聊天」）')
    return { parse, listing }
  },
}
