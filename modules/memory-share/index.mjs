// 记忆可见性：从记忆库里挑一部分"可以公开说"的，群里和抖音那边能用到
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const DIR = join(DSH, 'plugins-data/aurabot/modules-data/memory-share')
const SHARE = join(DIR, 'share.json')
const MEM = join(DSH, 'plugins-data/aurabot/memories.json')

function readJson(p, d) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
function writeJson(p, o) {
  try {
    mkdirSync(DIR, { recursive: true })
    const t = p + '.tmp'
    writeFileSync(t, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o640 })
    renameSync(t, p)
  } catch {}
}
function items() {
  const j = readJson(MEM, [])
  return Array.isArray(j) ? j : (j.items || [])
}

export default {
  id: 'memory-share',
  name: '记忆可见性',
  version: '1.0.0',
  api: 1,
  description: '挑一部分记忆作为"可以公开说"的，群聊和抖音共享，其余仍然只在主人私聊',
  defaults: { enabled: true, injectLimit: 3, maxChars: 220 },
  setup(api) {
    const owner = () => String(api.config().ownerQQ || '')
    const sharedIds = () => (readJson(SHARE, { ids: [] }).ids || [])

    function sharedItems() {
      const ids = new Set(sharedIds())
      return items().filter((x) => ids.has(String(x.id)))
    }

    api.tool((where) => {
      if (!where || where.level !== 'full') return []
      return [
        api.defineTool({
          name: 'memory_share',
          description: '把某条记忆设成"可以公开说"的（你自己或主人可见范围外也能提）。参数是记忆 id。',
          properties: { id: { type: 'string', description: '记忆 id' } },
          required: ['id'],
          execute: async ({ id }) => {
            const it = items().find((x) => String(x.id) === String(id))
            if (!it) return { ok: false, message: '没这条记忆' }
            const s = readJson(SHARE, { ids: [] })
            s.ids = Array.from(new Set([...(s.ids || []).map(String), String(id)]))
            s.updatedAt = Date.now()
            writeJson(SHARE, s)
            return { ok: true, message: '已设为可公开', text: String(it.text).slice(0, 60) }
          },
        }),
        api.defineTool({
          name: 'memory_unshare',
          description: '把某条记忆从"可公开"里撤掉。',
          properties: { id: { type: 'string', description: '记忆 id' } },
          required: ['id'],
          execute: async ({ id }) => {
            const s = readJson(SHARE, { ids: [] })
            s.ids = (s.ids || []).filter((x) => String(x) !== String(id))
            s.updatedAt = Date.now()
            writeJson(SHARE, s)
            return { ok: true, message: '已撤掉' }
          },
        }),
        api.defineTool({
          name: 'memory_shared_list',
          description: '看看现在有哪些记忆是"可以公开说"的。',
          properties: {},
          execute: async () => ({ ok: true, count: sharedItems().length, list: sharedItems().map((x) => ({ id: x.id, text: String(x.text).slice(0, 80) })) }),
        }),
      ]
    })

    // 群聊、抖音会话里注入"可以公开说"的那部分
    api.context(({ chat } = {}) => {
      try {
        const cid = String((chat && chat.chatId) || '')
        const isGroup = chat && chat.kind === 'group'
        const isDouyin = cid.startsWith('system:douyin')
        if (!isGroup && !isDouyin) return ''
        const list = sharedItems()
        if (!list.length) return ''
        const n = Math.max(1, Number(api.settings().injectLimit) || 3)
        const maxC = Math.max(60, Number(api.settings().maxChars) || 220)
        const picked = list.slice(-n).map((x) => String(x.text).replace(/\s+/g, ' ').slice(0, Math.floor(maxC / n)))
        return `【可以自然说出来的事】\n${picked.join('\n')}\n（这些是你愿意公开聊的；没列出来的别主动提。）`
      } catch { return '' }
    })

    api.route('/state', async () => {
      const s = readJson(SHARE, { ids: [] })
      return { ok: true, count: (s.ids || []).length, ids: (s.ids || []).slice(0, 50), updatedAt: s.updatedAt || 0 }
    })

    api.log.info?.('记忆可见性已挂上（群聊/抖音只看到可公开的那部分）')
  },
}