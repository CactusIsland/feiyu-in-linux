// B站学习 v2.1：登录态 + 字幕 + 弹幕 + 热评 + vlog/投稿 + 评论回复
// 写操作（投稿/点赞/关注/评论/私信/回复评论）需要 cookies.txt；不要把 Cookie 提交到仓库。
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const BILI_DIR = process.env.BILI_DATA_DIR || '/opt/bili-data'
const DIR = join(DSH, 'plugins-data/aurabot/modules-data/bili-study')
const KNOW = join(DIR, 'knowledge.json')
const BUVID = join(DIR, 'buvid.json')
const VIDEOS = join(BILI_DIR, 'videos')
const VLOG = join(BILI_DIR, 'vlog.py')
const UPLOAD = join(BILI_DIR, 'upload.py')
const MY_VIDEOS = join(BILI_DIR, 'my_videos.py')
const PY = process.env.BILI_PYTHON || join(BILI_DIR, '.venv/bin/python')
const SEND_MEDIA = process.env.SEND_MEDIA_BIN || ''
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function readJson(p, d) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
function writeJson(p, o) {
  try { mkdirSync(DIR, { recursive: true }); const t = p + '.tmp'
    writeFileSync(t, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o640 }); renameSync(t, p) } catch {}
}
function cookie() {
  const files = [
    process.env.BILI_COOKIE_FILE,
    join(BILI_DIR, 'cookies.txt'),
    join(BILI_DIR, 'cookies_raw.txt'),
  ].filter(Boolean)
  for (const f of files) {
    try { const c = readFileSync(f, 'utf8').trim(); if (c) return c } catch {}
  }
  return ''
}
function qwenKey() {
  try { const t = readFileSync(join(DSH, '.credentials.yaml'), 'utf8'); const m = t.match(/QWEN_TOKEN_PLAN_CN_API_KEY:\s*(\S+)/); return m ? m[1] : '' } catch { return '' }
}

export default {
  id: 'bili-study',
  name: 'B站学习',
  version: '2.1.0',
  api: 1,
  description: 'B站：搜视频、字幕/弹幕/热评、学习笔记、vlog、可选投稿/互动/回复评论（写操作需登录+确认）',
  defaults: { enabled: true, dailyMax: 4, autoLearnHours: 6, wakeHour: 8, sleepHour: 23, browseMax: 6, browseChance: 0.35, sharePerDay: 2, subtitleChars: 5000, commentsCount: 15, topics: 'AI,机器人,有意思的知识', replyComments: false },
  setup(api) {
    let buvid = ''
    async function ensureBuvid() {
      if (buvid) return buvid
      const cached = readJson(BUVID, {})
      if (cached.b3 && Date.now() - (cached.at || 0) < 7 * 86400000) { buvid = cached.b3; return buvid }
      try {
        const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })
        const j = await r.json(); buvid = j.data?.b_3 || ''
        if (buvid) writeJson(BUVID, { b3: buvid, at: Date.now() })
      } catch {}
      return buvid
    }
    async function bili(path, withCookie = true) {
      const b3 = await ensureBuvid()
      const ck = (withCookie ? cookie() : '') || ('buvid3=' + b3)
      const r = await fetch('https://api.bilibili.com' + path, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: ck },
        signal: AbortSignal.timeout(20000),
      })
      const t = await r.text()
      try { return JSON.parse(t) } catch { return { code: -1, message: '非 JSON' } }
    }
    const knowledge = () => readJson(KNOW, { items: [] })
    const todayCount = () => (knowledge().items || []).filter((x) => String(x.at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length

    async function getSubtitle(cid, aid) {
      const j = await bili(`/x/player/wbi/v2?aid=${aid}&cid=${cid}`)
      const list = j?.data?.subtitle?.subtitles || []
      if (!list.length) return { text: '', lang: '' }
      const pick = list.find((s) => /zh/i.test(s.lan)) || list[0]
      const u = pick.subtitle_url.startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
      try {
        const r = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) })
        const s = await r.json()
        const text = (s.body || []).map((x) => x.content).join('')
        return { text, lang: pick.lan_doc || pick.lan || '' }
      } catch { return { text: '', lang: '' } }
    }

    async function getDanmaku(cid) {
      try {
        const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000),
        })
        const buf = Buffer.from(await r.arrayBuffer())
        const txt = buf.toString('utf8')
        const arr = [...txt.matchAll(/<d [^>]*>([^<]*)<\/d>/g)].map((m) => m[1]).filter(Boolean)
        return arr.slice(0, 500)
      } catch { return [] }
    }

    async function summarize({ title, up, desc, subtitle, danmaku, comments }) {
      const key = qwenKey()
      if (!key) return ''
      const prompt = [
        '你看了一个B站视频，用第一人称写一条学习笔记，120 字以内。',
        `标题：${title}`, `UP主：${up}`, `简介：${String(desc || '').slice(0, 400)}`,
        subtitle ? `字幕节选：${String(subtitle).slice(0, 3000)}` : '',
        danmaku.length ? `弹幕节选：${danmaku.slice(0, 30).join(' / ')}` : '',
        comments.length ? `热评：\n${comments.slice(0, 8).map((c) => '- ' + c).join('\n')}` : '',
        '要求：写"讲了什么"+"我原来以为…其实…"，口语，不要客套，不要分条。不要提字幕弹幕这些来源。',
      ].filter(Boolean).join('\n')
      try {
        const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3.8-flash', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(60000),
        })
        const j = await r.json()
        return String(j.choices?.[0]?.message?.content || '').trim()
      } catch { return '' }
    }

    async function learn(target) {
      const bvid = String(target).match(/(BV[0-9A-Za-z]{10})/)?.[1]
      if (!bvid) return { ok: false, message: '给我 BV 号或链接' }
      const v = await bili('/x/web-interface/view?bvid=' + bvid)
      if (v.code !== 0) return { ok: false, message: '拿不到视频信息：' + (v.message || v.code) }
      const d = v.data
      const rp = await bili(`/x/v2/reply?type=1&oid=${d.aid}&ps=${Number(api.settings().commentsCount) || 15}&sort=1`)
      const comments = ((rp.data && rp.data.replies) || []).map((x) => String(x.content?.message || '').replace(/<[^>]+>/g, '').slice(0, 80)).filter(Boolean)
      const sub = await getSubtitle(d.cid, d.aid)
      const dm = await getDanmaku(d.cid)
      const note = await summarize({ title: d.title, up: d.owner?.name || '', desc: d.desc, subtitle: sub.text, danmaku: dm, comments })
      const item = {
        bvid, aid: d.aid, cid: d.cid, title: d.title, up: d.owner?.name || '',
        url: 'https://www.bilibili.com/video/' + bvid, desc: String(d.desc || '').slice(0, 300),
        stat: { view: d.stat?.view, like: d.stat?.like, reply: d.stat?.reply },
        comments: comments.slice(0, 6), danmaku: dm.slice(0, 20), subtitleLen: sub.text.length,
        subtitle: String(sub.text || '').slice(0, Number(api.settings().subtitleChars) || 5000),
        note, at: new Date().toISOString(), tags: [],
      }
      const k = knowledge()
      const idx = (k.items || []).findIndex((x) => x.bvid === bvid)
      if (idx >= 0) k.items[idx] = item
      else k.items = [...(k.items || []).slice(-299), item]
      writeJson(KNOW, k)
      return { ok: true, title: d.title, up: item.up, note, subtitleChars: sub.text.length, danmaku: dm.length, comments: comments.slice(0, 3) }
    }



    async function genComment(title, note) {
      const key = qwenKey()
      if (!key) return ''
      const prompt = [
        '你在B站看了个视频，想留一条评论。',
        '视频标题：' + title,
        '你的观后感：' + String(note || '').slice(0, 200),
        '要求：一句话，15 字以内，像个普通网友随手留的；不要提AI、不要提自己看了字幕或弹幕；不要客套；不要带话题标签。',
      ].join('\n')
      try {
        const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3.8-flash', max_tokens: 60, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(30000),
        })
        const j = await r.json()
        return String(j.choices?.[0]?.message?.content || '').trim().replace(/^["'“”]|["'“”]$/g, '')
      } catch { return '' }
    }

    // ---- 写操作（登录态 + csrf）----
    function csrf() { const m = cookie().match(/bili_jct=([^;]+)/); return m ? m[1] : '' }
    const FORBID = /(QQ|qq|群号|微信|手机号|服务器|后台|插件|模块|记忆|主人|密钥|token|api[_-]?key|sk-|\.dsh|\/root|\/var|\d{5,12})/
    function safeText(t) {
      const x = String(t || '').trim()
      if (!x) throw new Error('内容是空的')
      if (FORBID.test(x)) throw new Error('这句话里有不能公开的信息，换一句')
      return x.slice(0, 500)
    }
    async function myMid() {
      const j = await bili('/x/web-interface/nav')
      return j?.data?.mid || 0
    }
    async function apiPost(host, path, form) {
      const body = new URLSearchParams({ ...form, csrf: csrf() })
      const r = await fetch(host + path, {
        method: 'POST',
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(20000),
      })
      const t = await r.text()
      try { return JSON.parse(t) } catch { return { code: -1, message: t.slice(0, 100) } }
    }
    async function aidOf(target) {
      const bvid = String(target).match(/(BV[0-9A-Za-z]{10})/)?.[1]
      if (bvid) { const v = await bili('/x/web-interface/view?bvid=' + bvid); return v.code === 0 ? v.data : null }
      const aid = String(target).match(/^\d{5,}$/)?.[0]
      if (aid) { const v = await bili('/x/web-interface/view?aid=' + aid); return v.code === 0 ? v.data : null }
      return null
    }

    const tools = [


      api.defineTool({
        name: 'bili_report', description: '把在B站学到的内容汇总成一份学习报告。',
        properties: { days: { type: 'number', description: '默认 7 天' } },
        execute: async ({ days }) => {
          const items = (knowledge().items || []).slice(-(Number(days) || 7) * 10)
          if (!items.length) return { ok: false, message: '还没学过东西' }
          const lines = items.map((x, i) => `${i + 1}. ${x.title}（${x.up}）\n   ${String(x.note || '').slice(0, 120)}`).join('\n')
          const key = qwenKey()
          let report = lines
          if (key) {
            try {
              const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
                method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'qwen3.8-flash', max_tokens: 1200, messages: [{ role: 'user', content:
                  '你是「大肥鱼」，把这些天在B站看的东西整理成一份学习报告，第一人称，300字以内，分三段：我看了什么、我学到了什么、我接下来想试什么。不要分条列点，口语化。\n\n' + lines }] }),
                signal: AbortSignal.timeout(60000),
              })
              const j = await r.json()
              report = String(j.choices?.[0]?.message?.content || '').trim() || lines
            } catch {}
          }
          return { ok: true, count: items.length, report }
        },
      }),


      api.defineTool({
        name: 'make_vlog', description: '把想说的话做成一条竖屏短视频（配音+字幕+配图背景），只发给主人预览，不发布。',
        properties: { text: { type: 'string', description: '要说的内容，60-120字' }, send: { type: 'boolean', description: '是否发到主人QQ，默认 true' } },
        required: ['text'],
        execute: async ({ text, send }) => {
          const t = String(text || '').trim()
          if (t.length < 8) return { ok: false, message: '太短了，多说两句' }
          try { safeText(t) } catch (e) { return { ok: false, message: e.message } }
          const out = join(VIDEOS, 'vlog-' + Date.now() + '.mp4')
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const runp = promisify(execFile)
          try {
            const { stdout } = await runp(PY, [VLOG, JSON.stringify({ text: t.slice(0, 200), out })], {
              timeout: 240000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, HOME: process.env.BILI_HOME || '/tmp' },
            })
            const j = JSON.parse(String(stdout).trim().split('\n').pop())
            if (!j.ok) return { ok: false, message: String(j.error || '').slice(0, 200) }
            let sent = false
            if (send !== false && api.config().ownerQQ) {
              try {
                if (SEND_MEDIA) await runp('node', [SEND_MEDIA, j.file, '我做了条视频，你看看'], { timeout: 120000 })
                else await api.sendFile('private:' + api.config().ownerQQ, j.file, 'vlog.mp4')
                sent = true
              } catch {}
            }
            return { ok: true, file: j.file, seconds: j.seconds, sent }
          } catch (e) { return { ok: false, message: String(e.stderr || e.message).slice(-250) } }
        },
      }),
      api.defineTool({
        name: 'bili_publish', description: '投稿一个B站视频。必须传 confirm=true 才会真的发；标题/简介/标签会过隐私检查。',
        properties: {
          file: { type: 'string', description: '视频路径（BILI_DATA_DIR/videos/ 下）' },
          title: { type: 'string' }, desc: { type: 'string' },
          tags: { type: 'string', description: '逗号分隔' }, tid: { type: 'number', description: '分区，默认 21 日常' },
          confirm: { type: 'boolean' },
        },
        required: ['file', 'title', 'confirm'],
        execute: async ({ file, title, desc, tags, tid, confirm }) => {
          if (!String(file).startsWith(VIDEOS + '/')) return { ok: false, message: '视频必须放在 ' + VIDEOS + ' 里' }
          if (!existsSync(file)) return { ok: false, message: '找不到这个文件' }
          let t, d
          try { t = safeText(title).slice(0, 80); d = safeText(desc || '').slice(0, 500) } catch (e) { return { ok: false, message: e.message } }
          if (!confirm) return { ok: false, message: '没确认。确认要发就把 confirm 设为 true' }
          const L = life(); const today = new Date().toISOString().slice(0, 10)
          if (L.day !== today) { L.day = today; L.watched = 0; L.shared = 0 }
          if ((L.published || 0) >= 2) return { ok: false, message: '今天已经发过 2 条了' }
          const payload = JSON.stringify({ file, title: t, desc: d, tags: String(tags || '日常').split(',').map((x) => x.trim()).filter(Boolean), tid: Number(tid) || 21 })
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const runp = promisify(execFile)
          try {
            const { stdout } = await runp(PY, [UPLOAD, payload], {
              timeout: 600000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, HOME: process.env.BILI_HOME || '/tmp' },
            })
            const j = JSON.parse(String(stdout).trim().split('\n').pop())
            if (j.ok) { L.published = (L.published || 0) + 1; saveLife(L) }
            return j
          } catch (e) { return { ok: false, message: String(e.stderr || e.message).slice(-300) } }
        },
      }),
      api.defineTool({
        name: 'bili_like', description: '给 B 站视频点赞（可撤销）。',
        properties: { target: { type: 'string' }, undo: { type: 'boolean' } }, required: ['target'],
        execute: async ({ target, undo }) => {
          const d = await aidOf(target)
          if (!d) return { ok: false, message: '找不到这个视频' }
          const j = await apiPost('https://api.bilibili.com', '/x/web-interface/archive/like', { aid: d.aid, like: undo ? 0 : 1 })
          return j.code === 0 ? { ok: true, action: undo ? '取消点赞' : '点赞', title: d.title } : { ok: false, message: j.message || String(j.code) }
        },
      }),
      api.defineTool({
        name: 'bili_follow', description: '关注一个 B 站 UP 主（参数是 UID 或空间链接）。',
        properties: { uid: { type: 'string' } }, required: ['uid'],
        execute: async ({ uid }) => {
          const id = String(uid).match(/(\d{4,})/)?.[1]
          if (!id) return { ok: false, message: '给我 UID 或空间链接' }
          const j = await apiPost('https://api.bilibili.com', '/x/relation/modify', { fid: id, act: 1, re_src: 11 })
          return j.code === 0 ? { ok: true, action: '关注', uid: id } : { ok: false, message: j.message || String(j.code) }
        },
      }),
      api.defineTool({
        name: 'bili_comment', description: '在 B 站视频下发一条评论。内容会先过隐私检查。',
        properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'],
        execute: async ({ target, text }) => {
          const d = await aidOf(target)
          if (!d) return { ok: false, message: '找不到这个视频' }
          let t
          try { t = safeText(text) } catch (e) { return { ok: false, message: e.message } }
          const j = await apiPost('https://api.bilibili.com', '/x/v2/reply/add', { oid: d.aid, type: 1, message: t, plat: 1 })
          return j.code === 0 ? { ok: true, action: '评论', title: d.title, text: t } : { ok: false, message: j.message || String(j.code) }
        },
      }),
      api.defineTool({
        name: 'bili_dm', description: '给 B 站用户发一条私信（参数 UID + 内容）。',
        properties: { uid: { type: 'string' }, text: { type: 'string' } }, required: ['uid', 'text'],
        execute: async ({ uid, text }) => {
          const to = String(uid).match(/(\d{4,})/)?.[1]
          if (!to) return { ok: false, message: '给我对方 UID' }
          let t
          try { t = safeText(text) } catch (e) { return { ok: false, message: e.message } }
          const me = await myMid()
          if (!me) return { ok: false, message: '登录态失效' }
          const j = await apiPost('https://api.vc.bilibili.com', '/web_im/v1/web_im/send_msg', {
            'msg[sender_uid]': me, 'msg[receiver_id]': to, 'msg[receiver_type]': 1,
            'msg[msg_type]': 1, 'msg[msg_status]': 0,
            'msg[timestamp]': Math.floor(Date.now() / 1000),
            'msg[content]': JSON.stringify({ content: t }),
            'msg[dev_id]': 'ABCDEFGH-1234-5678-9012-ABCDEFGHIJKL',
            csrf_token: csrf(),
          })
          return j.code === 0 ? { ok: true, action: '私信', to, text: t } : { ok: false, message: j.message || String(j.code) }
        },
      }),
      api.defineTool({
        name: 'bili_search', description: '在 B 站搜视频。', properties: { keyword: { type: 'string' }, n: { type: 'number' } }, required: ['keyword'],
        execute: async ({ keyword, n }) => {
          const j = await bili('/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(keyword))
          if (j.code !== 0) return { ok: false, message: '搜索失败：' + (j.message || j.code) }
          return { ok: true, list: (j.data?.result || []).slice(0, Math.max(1, Math.min(20, Number(n) || 5))).map((x) => ({ bvid: x.bvid, title: String(x.title).replace(/<[^>]+>/g, ''), up: x.author, play: x.play })) }
        },
      }),
      api.defineTool({
        name: 'bili_watch', description: '看一个 B 站视频（读字幕、弹幕、热评），写成学习笔记。参数是 BV 号或链接。',
        properties: { target: { type: 'string' } }, required: ['target'],
        execute: async ({ target }) => {
          if (todayCount() >= Number(api.settings().dailyMax || 4)) return { ok: false, message: '今天学够 4 个了' }
          try { return await learn(target) } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 150) } }
        },
      }),
      api.defineTool({
        name: 'bili_subtitle', description: '只取一个视频的字幕原文（不总结，省钱）。',
        properties: { target: { type: 'string' }, chars: { type: 'number' } }, required: ['target'],
        execute: async ({ target, chars }) => {
          const bvid = String(target).match(/(BV[0-9A-Za-z]{10})/)?.[1]
          if (!bvid) return { ok: false, message: '给我 BV 号' }
          const v = await bili('/x/web-interface/view?bvid=' + bvid)
          if (v.code !== 0) return { ok: false, message: '拿不到信息' }
          const sub = await getSubtitle(v.data.cid, v.data.aid)
          if (!sub.text) return { ok: false, message: '这个视频没有字幕' }
          return { ok: true, title: v.data.title, lang: sub.lang, chars: sub.text.length, text: sub.text.slice(0, Number(chars) || 3000) }
        },
      }),
      api.defineTool({
        name: 'bili_recall', description: '翻一翻在 B 站学过的东西。',
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
        await learn(pick.bvid)
        api.log.info?.('B站自动学习：' + pick.title)
      } catch (e) { api.log.warn?.('B站学习失败：' + (e && e.message)) }
    }, 'B站自己学')


    // ---- 作息 + 自己刷视频 ----
    const LIFE = join(DIR, 'life.json')
    const life = () => readJson(LIFE, { day: '', watched: 0, shared: 0, log: [] })
    function saveLife(o) { writeJson(LIFE, o) }
    function isAwake() {
      const h = new Date().getHours()
      const wake = Number(api.settings().wakeHour ?? 8)
      const sleep = Number(api.settings().sleepHour ?? 23)
      return h >= wake && h < sleep
    }
    async function popularVideos(n) {
      const j = await bili('/x/web-interface/popular?ps=' + n + '&pn=1', false)
      return (j?.data?.list || []).map((x) => ({ bvid: x.bvid, title: x.title, up: x.owner?.name || '' })).filter((x) => x.bvid)
    }

    api.every(20 * 60000, async () => {
      try {
        if (!isAwake()) return
        const L = life()
        const today = new Date().toISOString().slice(0, 10)
        if (L.day !== today) { L.day = today; L.watched = 0; L.shared = 0 }
        const max = Number(api.settings().browseMax || 6)
        if (L.watched >= max) return
        if (Math.random() > Number(api.settings().browseChance || 0.35)) return

        let pick = null
        const topics = String(api.settings().topics || '').split(',').map((x) => x.trim()).filter(Boolean)
        if (topics.length && Math.random() < 0.5) {
          const topic = topics[Math.floor(Math.random() * topics.length)]
          const j = await bili('/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(topic))
          const list = (j.data?.result || []).filter((x) => x.bvid)
          if (list.length) { const x = list[Math.floor(Math.random() * Math.min(8, list.length))]; pick = { bvid: x.bvid, title: x.title } }
        }
        if (!pick) { const pv = await popularVideos(20); if (pv.length) pick = pv[Math.floor(Math.random() * pv.length)] }
        if (!pick) return

        const k = knowledge()
        if ((k.items || []).some((x) => x.bvid === pick.bvid)) return
        const r = await learn(pick.bvid)
        if (!r.ok) return
        L.watched += 1
        L.log = [...(L.log || []).slice(-59), { at: new Date().toISOString(), bvid: pick.bvid, title: r.title }]
        saveLife(L)
        api.log.info?.('B站自己刷：' + r.title)

        // 有概率留一条评论（概率 = 浏览概率 × commentChance）
        if (Math.random() < Number(api.settings().commentChance ?? 0.33)) {
          try {
            const txt = await genComment(r.title, r.note)
            if (txt && txt.length >= 4 && !FORBID.test(txt)) {
              const d = await aidOf(pick.bvid)
              if (d) {
                const jr = await apiPost('https://api.bilibili.com', '/x/v2/reply/add', { oid: d.aid, type: 1, message: txt, plat: 1 })
                if (jr.code === 0) { L.commented = (L.commented || 0) + 1; saveLife(L); api.log.info?.('B站评论：' + txt) }
              }
            }
          } catch {}
        }

        const shareMax = Number(api.settings().sharePerDay ?? 2)
        if (L.shared < shareMax && r.note) {
          L.shared += 1; saveLife(L)
          const who = api.config().ownerQQ ? 'private:' + String(api.config().ownerQQ) : ''
          if (who) await api.sendText(who, '刚在B站看了个视频——' + r.title + '\n' + r.note.slice(0, 220))
        }
      } catch (e) { api.log.warn?.('B站作息调度失败：' + (e && e.message)) }
    }, 'B站自己刷视频')

    // 每天 22:50 报今天看了什么
    api.every(30 * 60000, async () => {
      try {
        const now = new Date()
        if (now.getHours() !== 22) return
        const L = life()
        const today = now.toISOString().slice(0, 10)
        if (L.day !== today || L.reported === today || !L.watched) return
        L.reported = today; saveLife(L)
        const items = (knowledge().items || []).filter((x) => String(x.at || '').slice(0, 10) === today)
        const who = api.config().ownerQQ ? 'private:' + String(api.config().ownerQQ) : ''
        if (!who) return
        await api.sendText(who, '今天在B站看了 ' + L.watched + ' 个视频：\n' + items.map((x) => '· ' + x.title).join('\n'))
      } catch {}
    }, 'B站晚间小结')

    api.rule('主人说「做视频」「做个视频」「发个视频」「录一段」时，不要解释流程、不要问怎么做，直接调用 make_vlog：把内容写成第一人称、60~120 字的口语，然后告诉主人「做好了，发你了」。')

    // ---------- 做视频：固定触发，不靠模型选工具 ----------
    async function doVlog(text) {
      const t = String(text || '').trim()
      if (t.length < 6) return { ok: false, message: '想让我讲什么？给我一句话' }
      const VLOGBAD = /(QQ|qq|微信|手机号|密钥|password|token|api[_-]?key|sk-[A-Za-z0-9]|\.dsh|\/root|\/var|\/opt|服务器|后台|主人|\b\d{6,}\b)/
      if (VLOGBAD.test(t)) return { ok: false, message: '这句话里有不能公开的信息，换一句' }
      const out = join(VIDEOS, 'vlog-' + Date.now() + '.mp4')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const runp = promisify(execFile)
      try {
        const { stdout } = await runp(PY, [VLOG, JSON.stringify({ text: t.slice(0, 200), out })], {
          timeout: 240000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, HOME: process.env.BILI_HOME || '/tmp' },
        })
        const j = JSON.parse(String(stdout).trim().split('\n').pop())
        if (!j.ok) return { ok: false, message: String(j.error || '').slice(0, 150) }
        try {
          if (SEND_MEDIA) await runp('node', [SEND_MEDIA, j.file, '我做了条视频，你看看'], { timeout: 90000 })
          else await api.sendFile('private:' + api.config().ownerQQ, j.file, 'vlog.mp4')
        } catch {}
        return { ok: true, file: j.file, seconds: j.seconds }
      } catch (e) { return { ok: false, message: String(e.stderr || e.message).slice(-200) } }
    }

    api.route('/vlog', async (req) => {
      let b = {}
      try { b = await api.core.http.body(req) } catch {}
      const r = await doVlog(b.text)
      return r
    })

    async function vlogFromMessage(msg) {
      const t = String(msg.text || '').trim()
      const m = t.match(/^(?:\/vlog|\/视频|做[个一]?视频|发[个一]?视频|录一段|做个vlog)[:：,，\s]*([\s\S]*)$/i)
      if (!m) return false
      const ownerQQ = String(api.config().ownerQQ || '')
      const id = String(msg.senderId || msg.userId || msg.from || '')
      const isOwner = (ownerQQ && (id === ownerQQ || String(msg.chatId || '') === 'private:' + ownerQQ)) || msg.level === 'full'
      if (!isOwner) return false
      let text = String(m[1] || '').trim()
      if (!text) text = '今天又学了点新东西，先记下来，慢慢变成我自己的。'
      const r = await doVlog(text)
      await api.send(msg.chatId, r.ok ? '做好了，发你了' : ('没做成：' + r.message))
      return true
    }

    api.on('message', async (msg) => {
      try { return await vlogFromMessage(msg) } catch { return false }
    })


    // ---- 回复自己视频下的评论：第一条 100%，其余 70% ----
    const REPLIED = join(DIR, 'replied.json')
    const replied = () => readJson(REPLIED, { ids: [] })
    function markReplied(rpid) { const r = replied(); r.ids = [...(r.ids || []).slice(-2000), String(rpid)]; writeJson(REPLIED, r) }

    async function myVideos() {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const runp = promisify(execFile)
      try {
        const { stdout } = await runp(PY, [MY_VIDEOS], {
          timeout: 60000, env: { ...process.env, HOME: process.env.BILI_HOME || '/tmp' },
        })
        return JSON.parse(String(stdout).trim().split('\n').pop()) || []
      } catch { return [] }
    }

    async function replyToCommenters() {
      const me = await myMid()
      if (!me) return 0
      const vids = (await myVideos()).filter((v) => Number(v.comments) > 0).slice(0, 5)
      const done = new Set(replied().ids.map(String))
      let posted = 0
      for (const v of vids) {
        const j = await bili(`/x/v2/reply?type=1&oid=${v.aid}&ps=20&sort=0`)
        const list = (j?.data?.replies || []).slice().reverse()  // 时间正序：第一条最早
        for (let i = 0; i < list.length && posted < 3; i++) {
          const c = list[i]
          if (!c?.member || String(c.member.mid) === String(me)) continue
          if (done.has(String(c.rpid))) continue
          const isFirst = i === 0
          const p = isFirst ? 1.0 : 0.7
          if (Math.random() > p) continue
          const text = await genReply(c.content?.message || '')
          if (!text) continue
          const r = await apiPost('https://api.bilibili.com', '/x/v2/reply/add', {
            oid: v.aid, type: 1, message: text, root: c.rpid, parent: c.rpid, plat: 1,
          })
          if (r.code === 0) { markReplied(c.rpid); posted++; api.log.info?.(`B站回复 ${c.member.uname}：${text}`) }
        }
      }
      return posted
    }

    async function genReply(commentText) {
      const key = qwenKey()
      if (!key) return ''
      const prompt = [
        '有人在你的B站视频下评论了：' + String(commentText).slice(0, 120),
        '用你的语气回一句，12 字以内，像个普通网友，不要客套不要提AI。',
      ].join('\n')
      try {
        const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
          method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3.8-flash', max_tokens: 50, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(30000),
        })
        const j = await r.json()
        const t = String(j.choices?.[0]?.message?.content || '').trim().replace(/^["'“”]|["'“”]$/g, '')
        return t.length >= 2 && !FORBID.test(t) ? t.slice(0, 30) : ''
      } catch { return '' }
    }

    api.every(10 * 60000, async () => {
      // 自动回复评论默认关闭：在 ext.bili-study.replyComments 打开
      if (api.settings().replyComments !== true) return
      try { await replyToCommenters() } catch (e) { api.log.warn?.('回复评论失败：' + (e && e.message)) }
    }, 'B站回复评论')

    const myVideosTool = api.defineTool({
      name: 'bili_my_videos', description: '看自己 B 站视频的评论情况。',
      properties: {}, execute: async () => {
        const vids = await myVideos()
        return { ok: true, count: vids.length, list: vids.slice(0, 10).map((v) => ({ bvid: v.bvid, title: String(v.title).slice(0, 30), comments: v.comments })) }
      },
    })
    api.tool((where) => (where && where.level === 'full' ? [myVideosTool] : []))

    api.route('/state', async () => {
      const k = knowledge()
      return { ok: true, total: (k.items || []).length, today: todayCount(), loggedIn: Boolean(cookie()), last: (k.items || []).slice(-1)[0]?.title || null }
    })
    api.log.info?.('B站学习 v2（字幕+弹幕）已挂上')
  },
}