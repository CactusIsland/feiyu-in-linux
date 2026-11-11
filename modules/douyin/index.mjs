// 抖音 v4.1：接口模式（dy-cli）：热榜 / 搜索 / 只读评论 / 豆包总结
// 只在主人私聊挂工具；风控自动通知；每日预算 ¥3。
//
// ⚠️ 高风险，默认关闭：
//   抖音自动化可能触发风控/封号，已有长期封禁（3 年）案例。
//   不要在共享服务器/主服务器上登录抖音账号，也不要把 Cookie 留在服务器上。
//   如果确实要跑，请用独立设备、独立小号、低频只读，风险自负。
//   本开源版已移除评论/点赞/收藏/关注/自动召唤等写操作，只保留只读能力。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const DIR = join(DSH, 'plugins-data/aurabot/modules-data/douyin')
const STATE = join(DIR, 'watched.json')
const REPO = '/opt/douyin'
const PY = REPO + '/.venv/bin/python'
const HOME = REPO + '/data/home'
const run = promisify(execFile)
const RISK = /登录|验证|风控|challenge|rate_limited|为空|国内 ?IP|verify/i

function readJson(p, d) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
function writeJson(p, o) {
  try {
    mkdirSync(DIR, { recursive: true })
    const t = p + '.tmp'
    writeFileSync(t, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o640 })
    renameSync(t, p)
  } catch {}
}
function parseJson(text) {
  const s = String(text)
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(s.slice(i, j + 1)) } catch { return null }
}
async function dy(args, timeout = 180000) {
  const env = Object.assign({}, process.env, { HOME, DOUYIN_DATA_DIR: REPO + '/data', PYTHONIOENCODING: 'utf-8' })
  const { stdout } = await run(PY, ['-m', 'dy_cli.main', ...args], { timeout, env, maxBuffer: 16 * 1024 * 1024, cwd: REPO })
  return String(stdout)
}

export default {
  id: 'douyin',
  name: '抖音',
  version: '4.1.0',
  api: 1,
  description: '抖音：热榜、搜索、只读评论、找豆包总结（接口模式，不写评论、不播视频）',
  defaults: { enabled: false, dailyMax: 5, dailyBudgetCny: 3, commentCount: 20 },
  setup(api) {
    const today = () => new Date().toISOString().slice(0, 10)
    const items = () => (readJson(STATE, { items: [] }).items || [])
    const todayItems = () => items().filter((x) => String(x.at || '').slice(0, 10) === today())
    const spent = () => todayItems().reduce((a, x) => a + (Number(x.costCny) || 0), 0)

    async function alertRisk(reason) {
      try {
        const key = 'risk:' + new Date().toISOString().slice(0, 13)
        const s = readJson(STATE, { items: [], alerts: [] })
        s.alerts = s.alerts || []
        if (s.alerts.includes(key)) return
        s.alerts = [...s.alerts.slice(-20), key]
        writeJson(STATE, s)
        await api.sendText('private:' + String(api.config().ownerQQ || ''), `抖音被风控了：${String(reason).slice(0, 100)}`)
      } catch {}
    }

    async function search(keyword, n) {
      const out = await dy(['search', String(keyword), '--count', String(n), '--json-output'])
      const j = parseJson(out)
      const list = (j?.data?.data || j?.data || []).map((x) => x.aweme_info || x).filter(Boolean)
      return list.map((x) => ({
        id: String(x.aweme_id || ''),
        desc: String(x.desc || '').slice(0, 80),
        author: x.author?.nickname || '',
        like: x.statistics?.digg_count || 0,
        comment: x.statistics?.comment_count || 0,
      })).filter((x) => x.id)
    }

    async function comments(id, n) {
      const out = await dy(['comments', String(id), '--count', String(n), '--json-output'])
      const j = parseJson(out)
      const arr = j?.data?.comments || j?.comments || j?.data || []
      return (Array.isArray(arr) ? arr : []).map((c) => ({
        who: c.user?.nickname || c.nickname || '',
        text: String(c.text || c.content || ''),
        like: c.digg_count || 0,
      }))
    }


    async function act(label, args) {
      try {
        const out = await dy(args, 180000)
        return { ok: true, action: label, output: String(out).slice(-400) }
      } catch (e) {
        return { ok: false, action: label, message: String(e.stderr || e.message || e).slice(-200) }
      }
    }

    const tools = [

      api.defineTool({
        name: 'douyin_me',
        description: '看她自己这个抖音号的信息。',
        properties: {},
        execute: async () => await act('我的账号', ['me']),
      }),
      api.defineTool({
        name: 'douyin_notifications',
        description: '看抖音通知（点赞、评论、关注）。',
        properties: { n: { type: 'number' } },
        execute: async ({ n }) => await act('通知', ['notifications']),
      }),
      api.defineTool({
        name: 'douyin_hot',
        description: '看抖音热榜（不需要登录）。',
        properties: { n: { type: 'number', description: '默认 10' } },
        execute: async ({ n }) => {
          try {
            const r = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { signal: AbortSignal.timeout(12000) })
            const j = await r.json()
            return { ok: true, list: (j.word_list || []).slice(0, Math.max(1, Math.min(30, Number(n) || 10))).map((x) => `${x.word}（${x.hot_value}）`) }
          } catch (e) { return { ok: false, message: '热榜没拿到：' + e.message } }
        },
      }),
      api.defineTool({
        name: 'douyin_search',
        description: '在抖音搜视频，返回标题、作者、点赞和评论数。',
        properties: { keyword: { type: 'string' }, n: { type: 'number', description: '默认 8' } },
        required: ['keyword'],
        execute: async ({ keyword, n }) => {
          try { return { ok: true, list: await search(keyword, Math.max(1, Math.min(20, Number(n) || 8))) } }
          catch (e) { const m = String(e.stderr || e.message); if (RISK.test(m)) await alertRisk(m); return { ok: false, message: '搜索失败：' + m.slice(0, 120) } }
        },
      }),
      api.defineTool({
        name: 'douyin_watch',
        description: '看一条抖音视频的评论区：读评论，找豆包的总结。只读，不会发评论或召唤。参数是视频 id 或链接。',
        properties: { target: { type: 'string' } },
        required: ['target'],
        execute: async ({ target }) => {
          if (todayItems().length >= Number(api.settings().dailyMax || 5)) return { ok: false, message: '今天看够 5 条了' }
          if (spent() >= Number(api.settings().dailyBudgetCny || 3)) return { ok: false, message: '今天抖音预算用完了（¥3）' }
          const id = String(target).match(/(\d{15,})/)?.[1]
          if (!id) return { ok: false, message: '给我视频链接或 id' }
          let list = []
          try { list = await comments(id, Number(api.settings().commentCount) || 20) }
          catch (e) { const m = String(e.stderr || e.message); if (RISK.test(m)) await alertRisk(m); return { ok: false, message: '评论区没拿到：' + m.slice(0, 120) } }

          const doubao = list.find((c) => /豆包/.test(c.who) && c.text.length > 20)
          const top = list.slice(0, 8).map((c) => `${c.who}：${c.text.slice(0, 50)}`)
          const item = { at: new Date().toISOString(), id, doubao: doubao?.text.slice(0, 800) || '', top, costCny: 0.02 }
          const s = readJson(STATE, { items: [], alerts: [] })
          s.items = [...(s.items || []).slice(-199), item]
          writeJson(STATE, s)

          if (doubao) return { ok: true, summary: doubao.text.slice(0, 600), top, note: '豆包在评论区的总结' }
          return { ok: true, top, note: '评论区没有豆包（本版本不自动召唤）', count: list.length }
        },
      }),
      api.defineTool({
        name: 'douyin_recent',
        description: '最近看过的抖音视频。',
        properties: { n: { type: 'number' } },
        execute: async ({ n }) => ({ ok: true, list: items().slice(-(Number(n) || 5)).reverse().map((x) => ({ at: x.at, id: x.id, hasDoubao: Boolean(x.doubao) })) }),
      }),
    ]
    api.tool((where) => (where && where.level === 'full' ? tools : []))

    // 抖音私信：给桥用的回复接口（只给本机）
    api.route('/dm', async (req) => {
      const ip = String((req.socket && req.socket.remoteAddress) || '')
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)) return { ok: false, code: 403 }
      let b = {}
      try { b = await api.core.http.body(req) } catch {}
      const text = String(b.text || '').slice(0, 400)
      const prompt = [
        '你在抖音私信里，对方是个普通网友，昵称「' + String(b.who || '') + '」。',
        '对方说：' + text,
        '只用一句话回，40 字以内。绝对不能提任何现实信息：QQ、微信、手机号、服务器、电脑、插件、模型、记忆、主人、密钥、文件路径。被问"你是谁"就说"抖音上的一条鱼"。',
      ].join('\n')
      try {
        const reply = await api.core.hub.runSystemTurn('douyin-dm', '抖音私信', prompt, { noTools: true, timeoutMs: 60000 })
        return { ok: true, reply: String(reply || '').slice(0, 300) }
      } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 120) } }
    })

    api.route('/state', async () => ({ ok: true, today: todayItems().length, spentCny: spent(), total: items().length }))
    api.rule('抖音走接口，不开浏览器。看视频只读评论区找豆包；本版本不写评论、不点赞、不关注、不召唤。抖音上不要提 QQ、后台、服务器。')
    api.log.info?.('抖音 v4（搜索/评论/豆包）已挂上')
  },
}