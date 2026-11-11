// B站学习：搜视频 → 读简介/评论 → 写成"我学到的东西"
// 记忆分两层：个人记忆 memories.json（已有）+ 知识库 knowledge.json（本模块）

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const DIR = join(DSH, 'plugins-data/aurabot/modules-data/bili-study')
const KNOW = join(DIR, 'knowledge.json')
const BUVID = join(DIR, 'buvid.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function readJson(p, d) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
function writeJson(p, o) {
  try {
    mkdirSync(DIR, { recursive: true })
    const t = p + '.tmp'
    writeFileSync(t, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o640 })
    renameSync(t, p)
  } catch {}
}
function qwenKey() {
  try {
    const t = readFileSync(join(DSH, '.credentials.yaml'), 'utf8')
    const m = t.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/)
    return m ? m[1] : ''
  } catch { return '' }
}

export default {
  id: 'bili-study',
  name: 'B站学习',
  version: '1.0.0',
  api: 1,
  description: '在 B 站找视频、读简介和评论，写成她自己的学习笔记（知识库与个人记忆分开存）',
  defaults: { enabled: true, dailyMax: 4, commentsCount: 15, autoLearnHours: 6, topics: '大肥鱼,AI 助手,机器人日常,有意思的知识' },
  setup(api) {
    let buvid = ''
    async function ensureBuvid() {
      if (buvid) return buvid
      const cached = readJson(BUVID, {})
      if (cached.b3 && Date.now() - (cached.at || 0) < 7 * 86400000) { buvid = cached.b3; return buvid }
      try {
        const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })
        const j = await r.json()
        buvid = j.data?.b_3 || ''
        if (buvid) writeJson(BUVID, { b3: buvid, at: Date.now() })
      } catch {}
      return buvid
    }
    async function bili(path) {
      const b3 = await ensureBuvid()
      const r = await fetch('https://api.bilibili.com' + path, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: 'buvid3=' + b3 },
        signal: AbortSignal.timeout(20000),
      })
      const t = await r.text()
      try { return JSON.parse(t) } catch { return { code: -1, message: '非 JSON' } }
    }

    const knowledge = () => readJson(KNOW, { items: [] })
    function todayCount() {
      const d = new Date().toISOString().slice(0, 10)
      return (knowledge().items || []).filter((x) => String(x.at || '').slice(0, 10) === d).length
    }

    async function learn(bvidOrUrl) {
      const m = String(bvidOrUrl).match(/(BV[0-9A-Za-z]{10})/)
      const bvid = m ? m[1] : ''
      if (!bvid) return { ok: false, message: '给我 BV 号或 bilibili 链接' }
      const v = await bili('/x/web-interface/view?bvid=' + bvid)
      if (v.code !== 0) return { ok: false, message: '拿不到视频信息：' + (v.message || v.code) }
      const d = v.data
      const rp = await bili(`/x/v2/reply?type=1&oid=${d.aid}&ps=${Number(api.settings().commentsCount) || 15}&sort=1`)
      const comments = ((rp.data && rp.data.replies) || []).map((x) => String(x.content?.message || '').replace(/<[^>]+>/g, '').slice(0, 80)).filter(Boolean)

      const key = qwenKey()
      let note = ''
      if (key) {
        const prompt = [
          `你在 B 站看了一个视频，用你自己的口吻写一条学习笔记。`,
          `标题：${d.title}`,
          `UP 主：${d.owner?.name || ''}`,
          `简介：${String(d.desc || '').slice(0, 600)}`,
          comments.length ? `热评：\n${comments.slice(0, 8).map((c) => '- ' + c).join('\n')}` : '',
          `要求：第一人称，120 字以内，写"这个视频讲了什么"+"我原来以为…其实…"+"我想试试…"三部分，不要分条，不要客套。`,
        ].filter(Boolean).join('\n')
        try {
          const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'qwen3.8-flash', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
            signal: AbortSignal.timeout(60000),
          })
          const j = await r.json()
          const msg = (j.choices || [])[0]?.message || {}
          note = String(msg.content || '').trim()
        } catch {}
      }

      const item = {
        bvid, aid: d.aid, title: d.title, up: d.owner?.name || '', url: 'https://www.bilibili.com/video/' + bvid,
        desc: String(d.desc || '').slice(0, 300), stat: { view: d.stat?.view, like: d.stat?.like, reply: d.stat?.reply },
        comments: comments.slice(0, 6), note, at: new Date().toISOString(), tags: [],
      }
      const k = knowledge()
      const idx = (k.items || []).findIndex((x) => x.bvid === bvid)
      if (idx >= 0) k.items[idx] = item
      else k.items = [...(k.items || []).slice(-299), item]
      writeJson(KNOW, k)
      return { ok: true, title: d.title, up: item.up, note: note.slice(0, 400), comments: comments.slice(0, 3), cost: 'tokens' }
    }

    const tools = [
      api.defineTool({
        name: 'bili_search',
        description: '在 B 站搜视频（不需要登录）。想知道某个话题有什么视频时用。',
        properties: { keyword: { type: 'string' }, n: { type: 'number', description: '默认 5' } },
        required: ['keyword'],
        execute: async ({ keyword, n }) => {
          const j = await bili('/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(keyword))
          if (j.code !== 0) return { ok: false, message: '搜索失败：' + (j.message || j.code) }
          const list = (j.data?.result || []).slice(0, Math.max(1, Math.min(20, Number(n) || 5)))
          return { ok: true, list: list.map((x) => ({ bvid: x.bvid, title: String(x.title).replace(/<[^>]+>/g, ''), up: x.author, play: x.play })) }
        },
      }),
      api.defineTool({
        name: 'bili_learn',
        description: '看一个 B 站视频并写学习笔记（读简介+热评，不播放视频）。参数是 BV 号或链接。',
        properties: { target: { type: 'string', description: 'BV 号或 bilibili 视频链接' } },
        required: ['target'],
        execute: async ({ target }) => {
          if (todayCount() >= Number(api.settings().dailyMax || 4)) return { ok: false, message: '今天学够 4 个了' }
          return await learn(target)
        },
      }),
      api.defineTool({
        name: 'bili_recall',
        description: '翻一翻在 B 站学过的东西，按关键词找。',
        properties: { query: { type: 'string' }, n: { type: 'number' } },
        execute: async ({ query, n }) => {
          const items = knowledge().items || []
          const q = String(query || '').trim()
          const hit = items.filter((x) => !q || (x.title + x.note + x.up).includes(q)).slice(-(Number(n) || 5)).reverse()
          return { ok: true, count: hit.length, list: hit.map((x) => ({ title: x.title, up: x.up, note: String(x.note || '').slice(0, 120), url: x.url })) }
        },
      }),
    ]

    api.tool((where) => (where && where.level === 'full' ? tools : []))

    // 定时自己学一条：从话题库里轮换
    api.every(Number(api.settings().autoLearnHours || 6) * 3600 * 1000, async () => {
      try {
        if (todayCount() >= Number(api.settings().dailyMax || 4)) return
        const topics = String(api.settings().topics || '').split(',').map((x) => x.trim()).filter(Boolean)
        if (!topics.length) return
        const topic = topics[Math.floor(Date.now() / 86400000) % topics.length]
        const j = await bili('/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(topic))
        const list = (j.data?.result || []).filter((x) => x.bvid)
        if (!list.length) return
        const pick = list[Math.floor(Math.random() * Math.min(5, list.length))]
        const r = await learn(pick.bvid)
        if (r.ok) api.log.info?.(`B站学习：${r.title}（${r.up}）`)
      } catch (e) { api.log.warn?.('B站学习失败：' + (e && e.message)) }
    }, 'B站自己学')

    // 每天 21:00 给主人一句"今天学了什么"
    api.every(30 * 60 * 1000, async () => {
      try {
        const now = new Date()
        if (now.getHours() !== 21) return
        const s = readJson(join(DIR, 'digest.json'), {})
        const today = now.toISOString().slice(0, 10)
        if (s.last === today) return
        const items = (knowledge().items || []).filter((x) => String(x.at || '').slice(0, 10) === today)
        if (!items.length) return
        const text = `今天在 B 站学了 ${items.length} 个：\n` + items.map((x) => `· ${x.title}（${x.up}）`).join('\n')
        await api.sendText('private:' + String(api.config().ownerQQ || ''), text)
        writeJson(join(DIR, 'digest.json'), { last: today, at: Date.now() })
      } catch {}
    }, 'B站学习日报')

    api.route('/state', async () => {
      const k = knowledge()
      return { ok: true, total: (k.items || []).length, today: todayCount(), budget: api.settings().dailyMax, last: (k.items || []).slice(-1)[0]?.title || null }
    })

    api.log.info?.('B站学习已挂上（搜索 / 看视频写笔记 / 知识库）')
  },
}