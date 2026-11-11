// 看链接：B站视频 / 公众号文章 / 普通网页。
// 实测：B站 API 需要伪造 buvid3 才不被 412；抖音/小红书/微博/知乎 对服务器 IP 有反爬，会明确告知打不开。

import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function buvid() {
  const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return h() + h() + h() + h() + 'infoc'
}

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，。！？、）)"'】]+/)
  return m ? m[0] : ''
}

function bvidOf(url) {
  const m = String(url || '').match(/(BV[0-9A-Za-z]{10})/)
  return m ? m[1] : ''
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim()
}

function metaOf(html) {
  const pick = (re) => { const m = String(html || '').match(re); return m ? stripTags(m[1]).trim() : '' }
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const desc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
  const site = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i)
  return { title, desc, site }
}

async function getText(url, opts = {}) {
  const r = await fetchSafe(url, {
    
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
  })
  const text = await r.text()
  return { status: r.status, final: r.url || url, text }
}

function fmtDuration(sec) {
  const s = Number(sec) || 0
  const m = Math.floor(s / 60), r = s % 60
  return m ? `${m}分${String(r).padStart(2, '0')}秒` : `${r}秒`
}

function fmtNum(n) {
  const v = Number(n) || 0
  return v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v)
}

async function readBili(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  const r = await getText(url, { headers: { referer: 'https://www.bilibili.com/', cookie: `buvid3=${buvid()}` } })
  let j
  try { j = JSON.parse(r.text) } catch { throw new Error('B站接口返回的不是 JSON') }
  if (j.code !== 0) throw new Error(`B站接口 ${j.code}：${j.message || ''}`)
  const v = j.data || {}
  const st = v.stat || {}
  const lines = [
    `【B站视频】${v.title || ''}`,
    `UP主：${(v.owner && v.owner.name) || '未知'}　时长：${fmtDuration(v.duration)}　分P：${v.videos || 1}`,
    `播放 ${fmtNum(st.view)} · 点赞 ${fmtNum(st.like)} · 投币 ${fmtNum(st.coin)} · 收藏 ${fmtNum(st.favorite)} · 弹幕 ${fmtNum(st.danmaku)} · 评论 ${fmtNum(st.reply)}`,
  ]
  if (v.pubdate) lines.push(`发布：${new Date(v.pubdate * 1000).toLocaleString('zh-CN')}`)
  if (v.desc) lines.push(`简介：${String(v.desc).slice(0, 300)}`)
  if (v.tname) lines.push(`分区：${v.tname}`)
  return { ok: true, kind: 'bilibili', title: v.title, text: lines.join('\n'), url: `https://www.bilibili.com/video/${bvid}`, aid: v.aid }
}

async function readGeneric(url) {
  const r = await getText(url)
  if (r.status >= 400) throw new Error(`目标网站返回 ${r.status}`)
  const m = metaOf(r.text)
  const body = stripTags(r.text)
  const snippet = body.slice(0, 600)
  const lines = []
  if (m.site) lines.push(`【${m.site}】`)
  if (m.title) lines.push(m.title)
  if (m.desc) lines.push(m.desc.slice(0, 300))
  if (snippet) lines.push('正文节选：' + snippet)
  if (!lines.length) throw new Error('页面里没抓到可用内容')
  return { ok: true, kind: 'page', title: m.title || '', text: lines.join('\n'), url: r.final }
}

async function readLink(rawUrl) {
  const url = extractUrl(rawUrl) || String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('这不是一个网址')
  const host = (() => { try { return new URL(url).host } catch { return '' } })()

  // B站：b23.tv 短链先跟随重定向拿 BV 号
  if (/bilibili\.com|b23\.tv/i.test(host)) {
    let bv = bvidOf(url)
    if (!bv && /b23\.tv/i.test(host)) {
      try { const r = await getText(url); bv = bvidOf(r.final) || bvidOf(r.text) } catch (e) {}
    }
    if (bv) return await readBili(bv)
    throw new Error('这个 B站链接里找不到 BV 号（可能是动态或专栏，暂不支持）')
  }

  // 已知有强反爬的站：直接说清楚，别让她瞎猜
  if (/douyin\.com|iesdouyin/i.test(host)) throw new Error('抖音对服务器 IP 有反爬，拿不到内容（需要登录 Cookie，暂未配置）')
  if (/xiaohongshu\.com|xhslink/i.test(host)) throw new Error('小红书有反爬，拿不到正文（需要登录 Cookie，暂未配置）')
  if (/weibo\.(com|cn)/i.test(host)) throw new Error('微博需要登录态，拿不到内容')
  if (/zhihu\.com/i.test(host)) throw new Error('知乎有反爬（403），拿不到正文')

  return await readGeneric(url)
}


// ---------- 看视频：下载 → 抽帧 → 拼图交给视觉模型 ----------
const FFMPEG = '/usr/bin/ffmpeg'
const FFPROBE = '/usr/bin/ffprobe'
const TMP = '/tmp'

function shellOut(cmd, args, timeoutMs = 120000) {
  return execFileSync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function biliView(bvid) {
  const r = await getText(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { referer: 'https://www.bilibili.com/', cookie: `buvid3=${buvid()}` } })
  const j = JSON.parse(r.text)
  if (j.code !== 0) throw new Error(`B站接口 ${j.code}：${j.message || ''}`)
  return j.data || {}
}

async function biliPlayUrl(bvid, cid) {
  const r = await getText(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=1&fourk=0`, { headers: { referer: 'https://www.bilibili.com/', cookie: `buvid3=${buvid()}` } })
  const j = JSON.parse(r.text)
  if (j.code !== 0) throw new Error(`取播放地址失败 ${j.code}：${j.message || ''}`)
  const durl = (j.data && j.data.durl) || []
  if (!durl.length || !durl[0].url) throw new Error('这个视频没有可下的直链（可能是付费或番剧）')
  return durl[0].url
}

async function downloadVideo(url, referer) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, ...(referer ? { referer } : {}), range: 'bytes=0-20000000' },
    signal: AbortSignal.timeout(90000),
  })
  if (!r.ok && r.status !== 206) throw new Error(`下载失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 20000) throw new Error('下到的视频太小，可能被拦了')
  return buf
}

function framesSheet(videoPath, seconds) {
  const dur = Math.max(1, Number(seconds) || 0)
  const fps = Math.max(0.02, 4 / dur)
  const out = videoPath + '.jpg'
  shellOut(FFMPEG, ['-y', '-loglevel', 'error', '-i', videoPath, '-vf', `fps=${fps.toFixed(4)},scale=480:-2,tile=2x2`, '-frames:v', '1', '-q:v', '4', out], 60000)
  return existsSync(out) ? out : ''
}

function probeDuration(file) {
  try { return Number(shellOut(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 15000).trim()) || 0 } catch { return 0 }
}

async function imageBlockOf(dsh, jpgPath) {
  try {
    const mod = await import(DSH + '/profiles/web/node_modules/dsh-aurabot-qq/src/core/img.js')
    if (!mod || typeof mod.imageToolBlock !== 'function') return null
    return await mod.imageToolBlock(dsh, readFileSync(jpgPath), { ffmpegPath: FFMPEG })
  } catch { return null }
}


async function biliComments(aid, n = 5) {
  try {
    const r = await getText(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${n}&pn=1`, { headers: { referer: 'https://www.bilibili.com/', cookie: `buvid3=${buvid()}` } })
    const j = JSON.parse(r.text)
    if (j.code !== 0) return []
    return ((j.data && j.data.replies) || []).slice(0, n).map((x) => ({
      user: (x.member && x.member.uname) || '',
      like: x.like || 0,
      text: String((x.content && x.content.message) || '').replace(/\s+/g, ' ').slice(0, 100),
    })).filter((x) => x.text)
  } catch (e) { return [] }
}

async function biliSubtitle(bvid, cid, maxChars = 1200) {
  try {
    const r = await getText(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { headers: { referer: 'https://www.bilibili.com/', cookie: `buvid3=${buvid()}` } })
    const j = JSON.parse(r.text)
    if (j.code !== 0) return ''
    const list = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || []
    if (!list.length) return ''
    const u = String(list[0].subtitle_url || '')
    if (!u) return ''
    const full = u.startsWith('//') ? 'https:' + u : u
    const r2 = await getText(full, { headers: { referer: 'https://www.bilibili.com/' } })
    const j2 = JSON.parse(r2.text)
    const body = (j2 && j2.body) || []
    return body.map((x) => String(x.content || '')).join(' ').replace(/\s+/g, ' ').slice(0, maxChars)
  } catch (e) { return '' }
}

async function watchVideo(rawUrl, api, chat) {
  const url = extractUrl(rawUrl) || String(rawUrl || '').trim()
  const host = (() => { try { return new URL(url).host } catch { return '' } })()
  let bv = bvidOf(url)
  if (!bv && /b23\.tv/i.test(host)) { try { const r = await getText(url); bv = bvidOf(r.final) || bvidOf(r.text) } catch (e) {} }
  if (!bv) throw new Error('只支持 B站视频链接（bilibili.com/video/BV… 或 b23.tv 短链）；抖音/小红书对服务器 IP 有反爬，下不了')

  const v = await biliView(bv)
  const playUrl = await biliPlayUrl(bv, v.cid)
  const buf = await downloadVideo(playUrl, 'https://www.bilibili.com/')
  const videoPath = `${TMP}/lr-${Date.now()}.mp4`
  try {
    (await import('node:fs')).writeFileSync(videoPath, buf)
    const realDur = probeDuration(videoPath) || v.duration || 0
    const sheet = framesSheet(videoPath, realDur)
    const img = sheet ? await imageBlockOf(api.dsh, sheet) : null
    const st = v.stat || {}
    const [comments, subtitle] = await Promise.all([biliComments(v.aid, 5), biliSubtitle(bv, v.cid)])
    const parts = [
      `【看了视频】${v.title || ''}`,
      `UP主 ${(v.owner && v.owner.name) || '未知'} · 时长 ${fmtDuration(v.duration)} · 播放 ${fmtNum(st.view)}`,
      v.desc ? `简介：${String(v.desc).slice(0, 200)}` : '',
    ]
    if (subtitle) parts.push(`字幕（视频里说的话）：${subtitle}`)
    if (comments.length) {
      parts.push('热门评论：')
      comments.forEach((c, i) => parts.push(`  ${i + 1}. [${c.user} 赞${fmtNum(c.like)}] ${c.text}`))
    }
    const head = parts.filter(Boolean).join('\n')
    const tail = img
      ? '\n（下面是这个视频按时间顺序抽的 4 帧画面，从左到右、从上到下）'
      : '\n（视频画面没能交给你，只能看文字信息）'
    if (sheet) { try { unlinkSync(sheet) } catch (e) {} }
    return { ok: true, text: head + tail, image: img, title: v.title, duration: v.duration }
  } finally {
    try { unlinkSync(videoPath) } catch (e) {}
  }
}


// SSRF 防护：解析域名后逐个 IP 判断，拒绝私网/回环/链路本地/ULA；重定向逐跳校验
import dns from 'node:dns'

function expand6(ip) {
  let v = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (!v) return null
  if (v.includes('.')) {
    const i = v.lastIndexOf(':')
    if (i < 0) return null
    const p = v.slice(i + 1).split('.').map(Number)
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
    v = v.slice(0, i + 1) + (((p[0] << 8) | p[1]).toString(16)) + ':' + (((p[2] << 8) | p[3]).toString(16))
  }
  const dbl = v.split('::')
  if (dbl.length > 2) return null
  const head = dbl[0] ? dbl[0].split(':') : []
  const tail = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : null
  let groups
  if (tail === null) groups = head
  else {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  }
  if (groups.length !== 8) return null
  const out = groups.map((g) => parseInt(g || '0', 16))
  return out.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff) ? null : out
}

function isPrivateIp(ip) {
  const v = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!v) return true

  // IPv6（含 IPv4-mapped 的十六进制写法）
  if (v.includes(':')) {
    const g = expand6(v)
    if (!g) return true
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.')
      return isPrivateIp(v4)
    }
    if (g.every((x) => x === 0)) return true                    // ::
    if (g.slice(0, 7).every((x) => x === 0)) return true         // ::1 回环及 ::2 之类
    if ((g[0] & 0xffc0) === 0xfe80) return true                 // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true                 // fc00::/7 ULA
    if (g[0] === 0x2002) return true                            // 2002::/16 6to4
    if (g[0] === 0x0064 && g[1] === 0xff9b) return true         // 64:ff9b::/96 NAT64
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true         // 文档地址
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true
    return false
  }

  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const n = m.slice(1).map(Number)
  if (n.some((x) => x > 255)) return true
  const [a, b] = n
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 192 && b === 0) return true
  if (a >= 224) return true
  return false
}

async function assertPublicUrl(u) {
  let url
  try { url = new URL(u) } catch { throw new Error('链接格式不对') }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http/https')
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'metadata') throw new Error('内网地址不能访问')
  if (isPrivateIp(h)) throw new Error('内网地址不能访问')
  let addrs = []
  try { addrs = await dns.promises.lookup(h, { all: true, verbatim: true }) } catch { throw new Error('域名解析失败') }
  if (!addrs.length) throw new Error('域名解析失败')
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('内网地址不能访问')
  return url.toString()
}

async function fetchSafe(u, opts = {}, maxHops = 4) {
  let cur = await assertPublicUrl(u)
  for (let i = 0; i < maxHops; i++) {
    const r = await fetch(cur, { ...opts, redirect: 'manual' })
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location')
      if (!loc) return r
      cur = await assertPublicUrl(new URL(loc, cur).toString())
      continue
    }
    return r
  }
  throw new Error('重定向太多次')
}

export default {
  id: 'link-reader',
  name: '看链接',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '给她 read_link 工具：打开 B站视频、公众号文章、普通网页看内容。抖音/小红书/微博/知乎有反爬会明确说打不开。',
  defaults: { enabled: true },
  setup(api) {
    const stats = { total: 0, ok: 0, fail: 0, lastAt: 0, lastUrl: '', lastError: '', recent: [] }

    async function read(url) {
      stats.total += 1; stats.lastAt = Date.now(); stats.lastUrl = String(url).slice(0, 200)
      try {
        const r = await readLink(url)
        stats.ok += 1
        stats.recent = [...stats.recent, { at: Date.now(), url: stats.lastUrl, ok: true, title: r.title || '' }].slice(-12)
        return r
      } catch (error) {
        stats.fail += 1; stats.lastError = String(error.message || error).slice(0, 120)
        stats.recent = [...stats.recent, { at: Date.now(), url: stats.lastUrl, ok: false, error: stats.lastError }].slice(-12)
        throw error
      }
    }

    api.tool(() => api.defineTool({
      name: 'read_link',
      description: '打开一个链接看里面的内容。有人发来 B站视频、公众号文章、网页链接，或你想知道某条分享卡片讲了什么时用它。抖音/小红书/微博/知乎 目前打不开，会返回原因。',
      properties: { url: { type: 'string', description: '要看的网址，或包含网址的一段文字' } },
      required: ['url'],
      execute: async ({ url }) => {
        try {
          const r = await read(url)
          return { ok: true, message: r.text }
        } catch (error) {
          return { ok: false, message: '看不了：' + String(error.message || error).slice(0, 140) }
        }
      },
    }))

    api.tool(({ chat }) => api.defineTool({
      name: 'watch_video',
      description: '打开 B站视频「真的看内容」：抽 4 帧画面交给你的视觉，同时抓字幕（视频里说的话）和热门评论。有人发来视频链接或说「看看这个视频」时用它。',
      properties: { url: { type: 'string', description: '视频网址（B站链接或 b23.tv 短链）' } },
      required: ['url'],
      execute: async ({ url }) => {
        try {
          const r = await watchVideo(url, api, chat)
          return { ok: true, message: r.text, ...(r.image ? { image: r.image } : {}) }
        } catch (error) {
          return { ok: false, message: '看不了这个视频：' + String(error.message || error).slice(0, 140) }
        }
      },
    }))

    api.command({
      name: '看视频',
      desc: '/看视频 <链接> —— 真的去看画面（B站）',
      run: async (arg) => {
        try { const r = await watchVideo(arg, api, { chatId: 'private', kind: 'private' }); return r.text }
        catch (error) { return '看不了：' + String(error.message || error) }
      },
    })

    api.command({
      name: '看',
      desc: '/看 <链接> —— 打开链接看内容',
      run: async (arg) => {
        try { const r = await read(arg); return r.text.slice(0, 1200) }
        catch (error) { return '看不了：' + String(error.message || error) }
      },
    })

    api.route('/read', async (req) => {
      const url = String(api.core.http.query(req).url || '')
      try { const r = await read(url); return { ok: true, ...r } }
      catch (error) { return { ok: false, message: String(error.message || error) } }
    })
    api.route('/watch', async (req) => {
      const url = String(api.core.http.query(req).url || '')
      try {
        const r = await watchVideo(url, api, { chatId: 'route', kind: 'private' })
        return { ok: true, title: r.title, text: r.text, hasImage: Boolean(r.image) }
      } catch (error) { return { ok: false, message: String(error.message || error) } }
    })
    api.route('/state', async () => ({ ok: true, ...stats, enabled: api.settings().enabled !== false }))

    api.rule('有人发来分享卡片或链接时，如果你想谈论里面的内容，先用 read_link 打开看看；打不开就照实说，不要编内容。')
    api.log.info?.('看链接模块已就绪（read_link）')
  },
}
