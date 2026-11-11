import { statfsSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { scryptSync, timingSafeEqual, createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
const DSH = process.env.DSH_HOME || '/root/.dsh'

const BASE = 'http://127.0.0.1:5043'
const COOKIE = 'dsh_panel'
const TTL = 7 * 24 * 3600 * 1000


const AUTH_FILE = DSH + '/plugins-data/aurabot/modules-data/panel/auth.json'
function readAuth() {
  try { const j = JSON.parse(readFileSync(AUTH_FILE, 'utf8')); if (j && j.salt && j.hash) return j } catch {}
  return null
}
function writeAuth(a) {
  try { mkdirSync(AUTH_FILE.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(AUTH_FILE, JSON.stringify(a)); chmodSync(AUTH_FILE, 0o600) } catch {}
}

export default {
  id: 'panel', name: '状态面板', version: '3.1.0', api: 1, tab: 'general',
  description: '酒红 + 淡蓝：独立登录页、总览整排卡片、会话上下文、活动日志。',
  setup(api) {
    const auth = () => readAuth() || {}
    const secret = () => {
      const a = auth(); if (a.secret) return a.secret
      const f = join(api.dataDir(), 'secret'); if (existsSync(f)) return readFileSync(f, 'utf8').trim()
      const s = randomBytes(32).toString('hex'); writeFileSync(f, s, { mode: 0o600 }); return s
    }
    const sign = (p) => createHmac('sha256', secret()).update(p).digest('hex').slice(0, 32)
    const token = (u) => { const p = `${u}|${Date.now() + TTL}`; return Buffer.from(p).toString('base64url') + '.' + sign(p) }
    const cookie = (req) => {
      for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim())
      } return ''
    }
    const who = (req) => {
      const raw = cookie(req); if (!raw) return null
      const [b, s] = raw.split('.'); if (!b || !s) return null
      let p; try { p = Buffer.from(b, 'base64url').toString() } catch { return null }
      if (s.length !== sign(p).length || !timingSafeEqual(Buffer.from(s), Buffer.from(sign(p)))) return null
      const [u, exp] = p.split('|'); return Number(exp) > Date.now() ? u : null
    }
    const fails = new Map()
    const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
    const locked = (k) => { const f = fails.get(k); return f && f.n >= 5 && Date.now() - f.at < 6e5 }
    const bad = (k) => { const f = fails.get(k) || { n: 0, at: 0 }; f.n++; f.at = Date.now(); fails.set(k, f) }
    const good = (k) => fails.delete(k)
    const verify = (pw) => {
      const a = auth(); if (!a.user || !a.salt || !a.hash) return false
      const got = scryptSync(String(pw), a.salt, 32), want = Buffer.from(a.hash, 'hex')
      return got.length === want.length && timingSafeEqual(got, want)
    }
    const go = (res, to, extra = {}) => { res.writeHead(302, { location: to, 'cache-control': 'no-store', ...extra }); res.end() }
    const j = async (p) => { try { const r = await fetch(BASE + p); return r.ok ? await r.json() : null } catch { return null } }
    const sys = () => {
      const t = os.totalmem() / 1048576, f = os.freemem() / 1048576
      let d = null; try { const s = statfsSync('/'); d = { totalGB: Math.round(s.blocks * s.bsize / 1073741824), freeGB: Math.round(s.bavail * s.bsize / 1073741824) } } catch {}
      const m = process.memoryUsage()
      return { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), uptimeSec: Math.round(process.uptime()), load: os.loadavg().map((n) => Math.round(n * 100) / 100), mem: { totalMB: Math.round(t), freeMB: Math.round(f), usedPct: Math.round((1 - f / t) * 100) }, disk: d }
    }

    api.route('/ui', async (req, res) => {
      api.core.http.send(res, 200, who(req) ? APP : LOGIN, 'text/html; charset=utf-8')
    })
    api.route('/login', async (req, res) => {
      if (String(req.method).toUpperCase() !== 'POST') return go(res, './ui')
      let b = {}
      try {
        let raw = ''
        for await (const c of req) raw += c
        b = raw.trim().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
      } catch {}
      const k = ip(req)
      if (locked(k)) return go(res, './ui?e=locked')
      if (String(b.user || '') !== String(auth().user || '') || !verify(b.pass)) { bad(k); return go(res, './ui?e=bad') }
      good(k)
      const secure = String(req.headers['x-forwarded-proto'] || '') === 'https'
      go(res, './ui', { 'set-cookie': `${COOKIE}=${encodeURIComponent(token(String(b.user)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000 | 0}${secure ? '; Secure' : ''}` })
    })
    api.route('/logout', async (req, res) => {
      res.writeHead(302, { location: './ui', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` }); res.end()
    })

    api.route('/data', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const [st, si, rt, wa, tt] = await Promise.all([
        j('/aurabot/api/state'), j('/aurabot/api/ext/self-inspect/status'),
        j('/aurabot/api/ext/smart-router/state'), j('/aurabot/api/ext/auto-allow/state'),
        j('/aurabot/api/ext/tts-doubao/state'),
      ])
      const c = (st && (st.config || st)) || {}, ob = (st && st.onebot) || {}
      return { ok: true, sys: sys(), now: Date.now(), bot: {
        enabled: !!c.enabled, dryRun: !!c.dryRun, botQQ: c.botQQ || '', ownerQQ: c.ownerQQ || '',
        persona: (c.persona && c.persona.current) || '',
        gateway: typeof ob === 'string' ? ob : (ob.state || 'unknown'),
        memory: (si && si.status && si.status.memory) || null },
        router: rt ? { stats: rt.stats || {} } : null,
        allow: wa ? { private: wa.privateCount, groups: wa.groupCount } : null,
        tts: tt ? { hasKey: tt.hasKey, remaining: tt.remaining, semitones: (tt.params || {}).semitones } : null }
    })

    api.route('/chats', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const fresh = String(api.core.http.query(req).fresh || '') === '1'
      if (fresh) usageCache.at = 0
      const [s, b, st] = await Promise.all([
        j('/aurabot/api/ext/self-inspect/sessions'),
        j('/aurabot/api/ext/session-budget/state'),
        j('/aurabot/api/state'),
      ])
      const scan = cachedScan()
      const use = {}
      for (const x of (scan.sessions || [])) use[x.sessionId] = x

      const sessions = (s && s.list) || []
      const byChat = new Map()
      for (const x of sessions) byChat.set(x.chatId, x)

      // 白名单里的群和好友：没会话也要露面
      const cfg = (st && st.config) || st || {}
      const allow = cfg.allow || {}
      const groups = (allow.groups || []).map(String)
      const privates = (allow.private || []).map(String)
      const owner = String(cfg.ownerQQ || '')

      const rows = []
      for (const gid of groups) rows.push(makeRow('group:' + gid, 'QQ 群 · ' + gid, 'social'))
      if (owner) rows.push(makeRow('private:' + owner, 'QQ · 主人私聊', 'full'))
      for (const qq of privates) if (qq !== owner) rows.push(makeRow('private:' + qq, 'QQ 私聊 · ' + qq, 'social'))
      for (const [chatId, x] of byChat) {
        if (chatId.startsWith('system:')) continue
        if (rows.some((r) => r.chatId === chatId)) continue
        rows.push(makeRow(chatId, x.title || chatId, x.level || ''))
      }

      function makeRow(chatId, title, level) {
        const x = byChat.get(chatId) || {}
        const m = use[x.sessionId] || {}
        return {
          chatId,
          title: x.title || title,
          model: x.model || '',
          level: x.level || level || '',
          sessionId: x.sessionId || '',
          hasSession: Boolean(x.sessionId),
          ctx: m.lastCtx || 0,
          spent: m.total || 0,
          turns: m.turns || 0,
          lastActive: m.lastAt || 0,
          createdAt: x.createdAt || 0,
        }
      }

      const last = {}
      for (const e of ((b && b.entries) || [])) if (e.chatId && e.promptTokens) last[e.chatId] = Math.max(last[e.chatId] || 0, e.promptTokens)
      for (const r of rows) r.lastPromptTokens = last[r.chatId] || null

      rows.sort((a2, b2) => (b2.lastActive || 0) - (a2.lastActive || 0))
      return { ok: true, list: rows, budget: (b && b.settings) || null, window: scan.window || 1000000, scannedAt: usageCache.at }
    })

    // 画图：画廊 / 生成 / 图片流
    const STUDIO = '/aurabot/api/ext/image-studio'
    api.route('/world', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const [w, life, wal] = await Promise.all([
        j('/aurabot/api/ext/world/state'),
        j('/aurabot/api/ext/life-state/state'),
        j('/aurabot/api/ext/wallet/state'),
      ])
      return { ok: true, world: w || null, life: life || null, wallet: wal || null, now: Date.now() }
    })
    api.route('/diary', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const d = String(api.core.http.query(req).date || '')
      return await j('/aurabot/api/ext/world/diary?date=' + encodeURIComponent(d))
    })

    api.route('/picture', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const [st, gal] = await Promise.all([j(STUDIO + '/state'), j(STUDIO + '/gallery?limit=48')])
      return { ok: true, state: st || null, gallery: (gal && gal.list) || [] }
    })
    api.route('/draw', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      let b = {}
      try { let raw = ''; for await (const c of req) raw += c; b = raw.trim().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) } catch {}
      try {
        const r = await fetch(BASE + STUDIO + '/draw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
        return await r.json()
      } catch (e) { return { ok: false, message: String(e.message || e) } }
    })
    api.route('/thumb', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, '')
      const f = String(api.core.http.query(req).file || '')
      if (!/^(?!.*\.\.)[^\/\\]+\.(png|jpe?g|webp)$/i.test(f)) return api.core.http.send(res, 400, '')
      const src = DSH + '/plugins-data/aurabot/imagegen/' + f
      if (!existsSync(src)) return api.core.http.send(res, 404, '')
      const dir = DSH + '/plugins-data/aurabot/modules-data/image-studio/thumbs'
      try { mkdirSync(dir, { recursive: true }) } catch {}
      const key = f.replace(/[^\w.]/g, '_') + '.jpg'
      const out = dir + '/' + key
      try {
        if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
          execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=360:-2', '-frames:v', '1', '-update', '1', '-q:v', '5', out], { timeout: 20000 })
        }
        const buf = readFileSync(out)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' })
        res.end(buf)
      } catch { api.core.http.send(res, 500, '') }
    })

    api.route('/img', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, '')
      const f = String(api.core.http.query(req).file || '')
      if (!/^(?!.*\.\.)[^\/\\]+\.(png|jpe?g|webp)$/i.test(f)) return api.core.http.send(res, 400, '')
      try {
        const r = await fetch(BASE + STUDIO + '/img?file=' + encodeURIComponent(f))
        if (!r.ok) return api.core.http.send(res, 404, '')
        const buf = Buffer.from(await r.arrayBuffer())
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' })
        res.end(buf)
      } catch { api.core.http.send(res, 500, '') }
    })

    const billingCache = { at: 0, value: null }
    // 花钱：图片（中转站账单 + 逐张记录）+ 对话（token 估算）+ 余额
    api.route('/money', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      let idx = { items: [] }
      try { idx = JSON.parse(readFileSync(DSH + '/plugins-data/aurabot/modules-data/image-studio/pictures.json', 'utf8')) } catch {}
      const pics = (idx.items || [])
      const withCost = pics.filter((x) => typeof x.costUsd === 'number')
      const imgCost = withCost.reduce((a, x) => a + x.costUsd, 0)
      let account = null
      if (billingCache.at && Date.now() - billingCache.at < 300000) account = billingCache.value
      else {
        try {
          const key = String((((api.config().ext || {})['image-studio'] || {}).apiKey) || '')
          if (key) {
            const r = await fetch('https://api.openlux.ai/v1/dashboard/billing/usage', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12000) })
            const j = await r.json()
            account = Number(j.total_usage) || 0
            billingCache.at = Date.now(); billingCache.value = account
          }
        } catch {}
      }
      // 对话花费：复用统一扫描（不重复解压）
      const scan = cachedScan()
      const chat = {
        input: scan.input,
        cache: scan.cache,
        output: scan.output,
        total: scan.total,
        turns: scan.turns,
        cny: Math.round((scan.input * 2 / 1e6 + scan.cache * 0.2 / 1e6 + scan.output * 8 / 1e6) * 100) / 100,
      }
      let balance = null
      try { balance = await j('/aurabot/api/ext/self-inspect/status') } catch {}
      return {
        ok: true,
        images: {
          count: pics.length,
          measured: withCost.length,
          costUsd: Math.round(imgCost * 10000) / 10000,
          avgUsd: withCost.length ? Math.round((imgCost / withCost.length) * 100000) / 100000 : null,
          last: pics.length ? { n: pics[pics.length - 1].n, costUsd: pics[pics.length - 1].costUsd || null, model: pics[pics.length - 1].model } : null,
          accountUsd: account,
        },
        chat,
        list: pics.slice(-20).reverse().map((x) => ({ n: x.n, at: x.at || 0, model: x.model || '', costUsd: typeof x.costUsd === 'number' ? x.costUsd : null, prompt: String(x.prompt || '').slice(0, 40) })),
        balance: { deepseek: balance && balance.status && balance.status.wallet && balance.status.wallet.deepseek || null },
        now: Date.now(),
      }
    })

    // 记忆：汇总 map / 冷存 / 归档 / 整理器状态 + 全部记忆条目
    api.route('/memory', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const [map, cold, arc, comp] = await Promise.all([
        j('/aurabot/api/ext/memory-map/map'), j('/aurabot/api/ext/memory-cold/state'),
        j('/aurabot/api/ext/memory-archive/stats'), j('/aurabot/api/ext/memory-compact/state'),
      ])
      let items = []
      try { items = JSON.parse(readFileSync(DSH + '/plugins-data/aurabot/memories.json', 'utf8')) } catch {}
      if (!Array.isArray(items)) items = (items && items.items) || []
      const list = items.map((x) => ({ id: x.id, text: x.text, about: x.aboutName || x.about || '', tags: x.tags || [], importance: x.importance || 0, source: x.source || '', at: x.at || 0, hits: x.hits || 0 }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
      return {
        ok: true,
        stats: (map && map.stats) || null, weights: (map && map.weights) || null,
        people: ((map && map.people) || []).map((x) => ({ name: x.name, kind: x.kind, count: x.count, lastText: x.lastText })).slice(0, 12),
        fading: ((map && map.fading) || []).slice(0, 10),
        cold: cold ? { tracked: cold.tracked, archived: cold.archived, rows: cold.rows, bytes: cold.bytes, settings: cold.settings } : null,
        archive: arc ? { rows: arc.totalRows, bytes: arc.totalBytes, events: (arc.meta && arc.meta.totalEvents) || 0 } : null,
        compact: comp ? { settings: comp.settings, lastResult: comp.lastResult, runs: comp.runs, lastRun: comp.lastRun } : null,
        list,
      }
    })
    api.route('/memory/run', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const r = await j('/aurabot/api/ext/memory-compact/run')
      return { ok: true, result: r }
    })

    // 用量：扫 DSH 会话文件里的 usage，算累计消耗 + 当前上下文占比
    // 统一扫描器：只重解压变化过的文件，结果缓存 5 分钟
    const SCAN_TTL = 5 * 60 * 1000
    const fileCache = new Map()
    const usageCache = { at: 0, data: null }

    function scanSessions() {
      const root = DSH + '/sessions'
      const totals = { input: 0, output: 0, cache: 0, total: 0, turns: 0, sessions: [] }
      let dirs = []
      try { dirs = readdirSync(root) } catch { return totals }
      for (const proj of dirs) {
        let ids = []
        try { ids = readdirSync(root + '/' + proj) } catch { continue }
        for (const sid of ids) {
          const f = root + '/' + proj + '/' + sid + '/session.v4.jsonl.zstd'
          if (!existsSync(f)) continue
          let st
          try { st = statSync(f) } catch { continue }
          const hit = fileCache.get(f)
          let per
          if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
            per = hit.per
          } else {
            let text = ''
            try { text = zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
            per = { input: 0, output: 0, cache: 0, total: 0, turns: 0, lastCtx: 0, lastAt: 0 }
            for (const line of text.split('\n')) {
              const tm = /"time":(\d{13})/.exec(line)
              if (tm) { const t2 = Number(tm[1]); if (t2 > per.lastAt) per.lastAt = t2 }
              if (line.indexOf('"usage"') < 0) continue
              let j2
              try { j2 = JSON.parse(line) } catch { continue }
              const u = (j2 && j2.data && j2.data.usage) || null
              if (!u) continue
              per.input += u.inputTokens || 0
              per.output += u.outputTokens || 0
              per.cache += u.cacheReadTokens || 0
              per.total += u.totalTokens || ((u.inputTokens || 0) + (u.outputTokens || 0))
              per.turns += 1
              if ((u.inputTokens || 0) > per.lastCtx) per.lastCtx = u.inputTokens || 0
              if (j2.time && j2.time > per.lastAt) per.lastAt = j2.time
            }
            fileCache.set(f, { mtime: st.mtimeMs, size: st.size, per })
          }
          totals.input += per.input
          totals.output += per.output
          totals.cache += per.cache
          totals.total += per.total
          totals.turns += per.turns
          totals.sessions.push(Object.assign({ sessionId: sid }, per))
        }
      }
      totals.sessions.sort((a, b) => b.lastAt - a.lastAt)
      const main = totals.sessions[0] || null
      totals.used = main ? main.lastCtx : 0
      totals.window = 1000000
      totals.pct = Math.round((totals.used / totals.window) * 1000) / 10
      return totals
    }

    function cachedScan() {
      if (!usageCache.data || Date.now() - usageCache.at > SCAN_TTL) {
        usageCache.data = scanSessions()
        usageCache.at = Date.now()
      }
      return usageCache.data
    }

    function scanUsage(map) {
      const root = DSH + '/sessions'
      const WINDOW = 1000000
      const sessions = []
      let dirs = []
      try { dirs = readdirSync(root) } catch { dirs = [] }
      for (const proj of dirs) {
        let ids = []
        try { ids = readdirSync(root + '/' + proj) } catch { continue }
        for (const sid of ids) {
          const f = root + '/' + proj + '/' + sid + '/session.v4.jsonl.zstd'
          if (!existsSync(f)) continue
          let text = ''
          try { text = zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
          let input = 0, output = 0, total = 0, cache = 0, turns = 0, lastCtx = 0, lastAt = 0
          for (const line of text.split('\n')) {
            const tm = /"time":(\d{13})/.exec(line)
            if (tm) { const t2 = Number(tm[1]); if (t2 > lastAt) lastAt = t2 }
            if (line.indexOf('"usage"') < 0) continue
            let j
            try { j = JSON.parse(line) } catch { continue }
            const u = (j && j.data && j.data.usage) || null
            if (!u) continue
            input += u.inputTokens || 0
            output += u.outputTokens || 0
            total += u.totalTokens || ((u.inputTokens || 0) + (u.outputTokens || 0))
            cache += u.cacheReadTokens || 0
            turns += 1
            if ((u.inputTokens || 0) > lastCtx) lastCtx = u.inputTokens || 0
            if (j.time && j.time > lastAt) lastAt = j.time
          }
          const meta = map.get(sid) || {}
          sessions.push({ sessionId: sid, chatId: meta.chatId || '', title: meta.title || '', model: meta.model || '', input, output, total, cache, turns, lastCtx, lastAt, bytes: statSync(f).size })
        }
      }
      sessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
      const sum = sessions.reduce((a, x) => ({ input: a.input + x.input, output: a.output + x.output, total: a.total + x.total, cache: a.cache + x.cache, turns: a.turns + x.turns }), { input: 0, output: 0, total: 0, cache: 0, turns: 0 })
      const main = sessions[0] || null
      const used = main ? main.lastCtx : 0
      return { ok: true, window: WINDOW, used, pct: Math.round(used / WINDOW * 1000) / 10, main, sessions, ...sum }
    }
    api.route('/usage', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const u = cachedScan()
      return { ok: true, window: u.window, used: u.used, pct: u.pct, input: u.input, output: u.output, cache: u.cache, total: u.total, turns: u.turns, sessions: u.sessions.map((x) => ({ sessionId: x.sessionId, chatId: '', title: '', input: x.input, output: x.output, cache: x.cache, total: x.total, turns: x.turns, lastCtx: x.lastCtx, lastAt: x.lastAt })) }
    })

    api.route('/logs', async (req, res) => {
      if (!who(req)) return api.core.http.send(res, 401, { ok: false })
      const n = Math.min(500, Math.max(20, Number(api.core.http.query(req).n) || 150))
      return { ok: true, ...(await j('/aurabot/api/ext/self-inspect/logs?n=' + n)) }
    })
    api.log.info?.('状态面板 v3.1 就绪（酒红+淡蓝 · 总览整排）')
  },
}

const CSS = `:root{
--bg:#eef3f7;--card:#ffffff;--line:#dde6ee;--fg:#2b1d21;--dim:#7a8b99;
--wine:#8c2f39;--wine2:#a63a47;--wine-soft:#f7e9eb;
--blue:#7fb8d9;--blue2:#a9d3e8;--blue-soft:#e8f3f9;
--ok:#2e9e6b;--warn:#c98a1e;--bad:#c0392b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--wine);text-decoration:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 18px;box-shadow:0 1px 2px rgba(43,29,33,.04)}
h2{margin:0;font-size:12px;letter-spacing:.06em;color:var(--wine);font-weight:700;text-transform:uppercase}
.kv{display:flex;align-items:baseline;gap:8px;font-size:13.5px}
.kv span:first-child{color:var(--dim)}
.kv b{color:var(--fg);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:12px;padding:7px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid #eef3f7}
tr:hover td{background:var(--blue-soft)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.dim{color:var(--dim)}
pre{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;color:#4a5a66;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}`

const LOGIN = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 登录</title><style>${CSS}
body{min-height:100vh;display:grid;place-items:center;background:
radial-gradient(900px 500px at 15% 0%,rgba(140,47,57,.10),transparent 60%),
radial-gradient(900px 520px at 95% 100%,rgba(127,184,217,.22),transparent 60%),var(--bg)}
.f{width:min(400px,92vw);background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:20px;padding:34px 30px 26px;box-shadow:0 18px 44px rgba(140,47,57,.10)}
.b{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.lg{width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,var(--wine),var(--wine2));display:grid;place-items:center;font-size:20px;font-weight:800;color:#fff;box-shadow:0 8px 18px rgba(140,47,57,.28)}
h1{margin:0;font-size:17px;font-weight:700;color:var(--wine)}
.sub{color:var(--dim);font-size:12px;margin-top:3px}
label{display:block;font-size:12px;color:var(--dim);margin:14px 0 6px;font-weight:600}
input{width:100%;padding:11px 13px;border-radius:11px;border:1px solid var(--line);background:#fbfdfe;color:var(--fg);font-size:14px;outline:none}
input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(127,184,217,.22);background:#fff}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:11px;cursor:pointer;font-size:14px;font-weight:700;background:linear-gradient(135deg,var(--wine),var(--wine2));color:#fff;letter-spacing:.08em}
button:hover{filter:brightness(1.07)}
.err{margin-top:14px;padding:9px 12px;border-radius:10px;background:#fdeceb;color:#a4302a;border:1px solid #f5cfcb;font-size:12.5px;display:none}
.err.on{display:block}.foot{margin-top:20px;text-align:center;color:var(--dim);font-size:11.5px}
</style></head><body><form class="f" method="post" action="login">
<div class="b"><div class="lg">鱼</div><div><h1>大肥鱼 · 控制台</h1><div class="sub">DeepSeek Harness · Aurabot</div></div></div>
<label>账号</label><input name="user" autocomplete="username" autofocus>
<label>密码</label><input name="pass" type="password" autocomplete="current-password">
<button>登 录</button><div class="err" id="e"></div>
<div class="foot">仅限本人使用 · 连错 5 次锁 10 分钟</div></form>
<script>const q=new URLSearchParams(location.search),e=document.getElementById('e');
if(q.get('e')){e.textContent=q.get('e')==='locked'?'错太多次了，10 分钟后再试':'账号或密码不对';e.classList.add('on')}</script></body></html>`

const APP = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 控制台</title><style>${CSS}
.wrap{display:grid;grid-template-columns:196px 1fr;min-height:100vh}
aside{background:linear-gradient(180deg,var(--wine) 0%,var(--wine2) 100%);padding:18px 12px;display:flex;flex-direction:column;gap:3px}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 18px}
.logo{width:34px;height:34px;border-radius:11px;background:#fff;color:var(--wine);display:grid;place-items:center;font-weight:800}
.brand b{color:#fff;font-size:14px;letter-spacing:.02em}
nav a{display:block;padding:9px 12px;border-radius:10px;color:rgba(255,255,255,.78);font-size:13.5px}
nav a:hover{background:rgba(255,255,255,.12);color:#fff}
nav a.on{background:#fff;color:var(--wine);font-weight:700}
.sp{margin-top:auto;padding:10px 12px;font-size:11.5px;color:rgba(255,255,255,.72);line-height:1.7}
.sp a{color:#dff0f8;text-decoration:underline}
main{padding:20px 26px;overflow:auto}
header{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
header h1{font-size:18px;margin:0;font-weight:700;color:var(--wine)}
.pill{font-size:12px;padding:3px 11px;border-radius:99px;border:1px solid var(--line);color:var(--dim);background:#fff}
.pill.green{color:var(--ok);border-color:#c6e3d5;background:#f0f9f4}
.pill.red{color:var(--bad);border-color:#f0cfcb;background:#fdf1f0}
.rows{display:grid;gap:10px;grid-template-columns:1fr}
.row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.row h2{flex:0 0 110px}
.row .kv{flex:0 0 auto;min-width:150px;padding:0}
.row .kv span:first-child::after{content:""}
.big{font-size:20px;font-weight:700;color:var(--wine)}
.bar{height:6px;border-radius:99px;background:#e8eef4;width:150px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--wine),var(--blue))}
.sec{display:none}.sec.on{display:block}
.toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
select,input.f,button.sm{padding:7px 11px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--fg);font-size:13px}
button.sm{cursor:pointer}button.sm:hover{border-color:var(--blue);color:var(--wine)}
@media(max-width:820px){.wrap{grid-template-columns:1fr}aside{flex-direction:row;overflow:auto;align-items:center}nav{display:flex}.sp{margin:0 0 0 auto;padding:6px}.row h2{flex:0 0 100%}}
</style></head><body><div class="wrap">
<aside><div class="brand"><div class="logo">鱼</div><b>大肥鱼</b></div>
<nav><a href="#o" class="on" data-s="o">总览</a><a href="#c" data-s="c">会话上下文</a><a href="#p" data-s="p">画图</a><a href="#m" data-s="m">记忆</a><a href="#w" data-s="w">世界</a><a href="#y" data-s="y">钱包</a><a href="#l" data-s="l">活动日志</a></nav>
<div class="sp" id="clock">—<br><a href="logout">退出登录</a></div></aside>
<main><header><h1 id="title">总览</h1><span class="pill" style="opacity:.5">v3.2</span><span class="pill" id="gw">—</span><span class="pill" id="up">—</span></header>
<section class="sec on" id="s-o"><div class="rows">
<div class="card row"><h2>机器人</h2>
<div class="kv"><span>QQ</span><b id="qq">—</b></div>
<div class="kv"><span>主人</span><b id="ow">—</b></div>
<div class="kv"><span>人格</span><b id="pe">—</b></div>
<div class="kv"><span>试运行</span><b id="dr">—</b></div></div>
<div class="card row"><h2>宿主进程</h2>
<div class="kv"><span>RSS</span><b id="rss">—</b></div>
<div class="kv"><span>堆</span><b id="heap">—</b></div>
<div class="kv"><span>负载</span><b id="ld">—</b></div>
<div class="kv"><span>运行</span><b id="ut">—</b></div></div>
<div class="card row"><h2>内存</h2>
<div class="kv"><span>占用</span><b class="big" id="mp">—</b></div>
<div class="bar"><i id="mb" style="width:0"></i></div>
<div class="kv"><span>可用/总</span><b id="mt">—</b></div></div>
<div class="card row"><h2>磁盘</h2>
<div class="kv"><span>可用</span><b class="big" id="dk">—</b></div>
<div class="kv"><span>总量</span><b id="dt">—</b></div></div>
<div class="card row"><h2>记忆</h2>
<div class="kv"><span>条数</span><b id="mc">—</b></div>
<div class="kv"><span>自动整理</span><b id="ma">—</b></div></div>
<div class="card row"><h2>智能路由</h2>
<div class="kv"><span>千问 3.8</span><b id="r1">—</b></div>
<div class="kv"><span>DeepSeek 4.1</span><b id="r2">—</b></div></div>
<div class="card row"><h2>白名单</h2>
<div class="kv"><span>好友</span><b id="wf">—</b></div>
<div class="kv"><span>群</span><b id="wg">—</b></div></div>
<div class="card row"><h2>豆包语音</h2>
<div class="kv"><span>Key</span><b id="tk">—</b></div>
<div class="kv"><span>变调</span><b id="ts">—</b></div>
<div class="kv"><span>剩余</span><b id="tq">—</b></div></div>
<div class="card row"><h2>花钱</h2>
<div class="kv"><span>画图</span><b id="m-img">—</b></div>
<div class="kv"><span>最近一张</span><b id="m-last">—</b></div>
<div class="kv"><span>对话（估算）</span><b id="m-chat">—</b></div>
<div class="kv"><span>余额</span><b id="m-bal">—</b></div></div>
<div class="card row"><h2>用量 · 上下文</h2>
<svg width="68" height="68" viewBox="0 0 68 68" style="flex:0 0 auto">
  <circle cx="34" cy="34" r="27" fill="none" stroke="#eaeef3" stroke-width="7"></circle>
  <circle id="ring" cx="34" cy="34" r="27" fill="none" stroke="#8c2f39" stroke-width="7" stroke-linecap="round"
    stroke-dasharray="169.6" stroke-dashoffset="169.6" transform="rotate(-90 34 34)" style="transition:stroke-dashoffset .6s"></circle>
  <text id="ringtxt" x="34" y="39" text-anchor="middle" font-size="15" font-weight="700" fill="#8c2f39">0%</text>
</svg>
<div class="kv"><span>当前上下文</span><b id="u-ctx">—</b></div>
<div class="kv"><span>累计消耗</span><b id="u-total">—</b></div>
<div class="kv"><span>输入 / 输出</span><b id="u-io">—</b></div>
<div class="kv"><span>缓存命中</span><b id="u-cache">—</b></div>
<div class="kv"><span>总轮次</span><b id="u-turns">—</b></div></div>
</div></section>
<section class="sec" id="s-c"><div class="toolbar"><button class="sm" onclick="loadC(1)">刷新</button><span class="dim" id="chint"></span></div><div class="card" id="cbox"></div></section>
<section class="sec" id="s-p">
<div class="toolbar"><input class="f" id="pp" placeholder="描述你想要的画面…" style="flex:1;min-width:220px"><select id="pmd"></select><select id="psz"><option value="1024x1024">1024×1024</option><option value="1024x1536">1024×1536 竖</option><option value="1536x1024">1536×1024 横</option></select><button class="sm" onclick="doDraw()" id="pbtn">开始画</button></div>
<div class="toolbar"><span class="dim" id="pstat">—</span></div>
<div id="pgrid" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))"></div>
</section>
<section class="sec" id="s-m">
<div class="toolbar"><button class="sm" onclick="loadMem()">刷新</button><button class="sm" onclick="runCompact()">立即整理</button><input class="f" id="mf" placeholder="搜索记忆" style="flex:1;max-width:240px"><span class="dim" id="mhint"></span></div>
<div class="rows" id="mcards" style="margin-bottom:12px"></div>
<div class="card"><div id="mbox" class="dim">加载中…</div></div>
</section>
<section class="sec" id="s-w">
<div class="rows">
<div class="card row"><h2>此刻</h2>
<div class="kv"><span>状态</span><b id="w-state">—</b></div>
<div class="kv"><span>精力 / 饱腹</span><b id="w-meter">—</b></div>
<div class="kv"><span>上次回顾</span><b id="w-rev">—</b></div>
<div class="kv"><span>画图花费</span><b id="w-cost">—</b></div>
</div>
<div class="card row"><h2>我是谁 <span class="dim" style="font-size:12px">（她自己写的，每晚改写）</span></h2>
<div id="w-self" class="dim" style="white-space:pre-wrap;line-height:1.7;font-size:13px">—</div>
</div>
<div class="card row"><h2>日记 <button class="sm" style="float:right" onclick="runReview()">现在回顾一次</button></h2>
<div id="w-list" class="dim" style="line-height:2">—</div>
<div id="w-text" style="white-space:pre-wrap;line-height:1.8;font-size:13px;margin-top:10px;display:none"></div>
</div>
</div></section>
<section class="sec" id="s-y">
<div class="rows">
<div class="card row"><h2>画图</h2>
<div class="kv"><span>张数</span><b class="big" id="y-count">—</b></div>
<div class="kv"><span>累计花费</span><b id="y-img">—</b></div>
<div class="kv"><span>平均每张</span><b id="y-avg">—</b></div>
<div class="kv"><span>最近一张</span><b id="y-last">—</b></div></div>
<div class="card row"><h2>对话</h2>
<div class="kv"><span>累计花费</span><b class="big" id="y-chat">—</b></div>
<div class="kv"><span>Tokens</span><b id="y-tok">—</b></div>
<div class="kv"><span>轮数</span><b id="y-turns">—</b></div></div>
<div class="card row"><h2>余额</h2>
<div class="kv"><span>DeepSeek</span><b id="y-bal">—</b></div>
<div class="kv"><span>OpenLux 已用</span><b id="y-acc">—</b></div></div>
<div class="card"><h2>最近 20 张 <button class="sm" style="float:right" onclick="loadY()">刷新</button></h2>
<div id="y-list" class="dim" style="line-height:1.9;font-size:13px">加载中…</div></div>
</div></section>
<section class="sec" id="s-l"><div class="toolbar"><select id="ln"><option>150</option><option>300</option><option>500</option></select><button class="sm" onclick="loadL()">刷新</button><input class="f" id="lf" placeholder="过滤关键字" style="flex:1;max-width:240px"></div><div class="card"><pre id="lbox">加载中…</pre></div></section>
</main></div><script>
var NL=String.fromCharCode(10);
var $=function(i){return document.getElementById(i)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})};
var fmt=function(s){return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m'};
var cur='o';
document.querySelectorAll('nav a').forEach(function(a){a.onclick=function(e){e.preventDefault();cur=a.dataset.s;
document.querySelectorAll('nav a').forEach(function(x){x.classList.toggle('on',x===a)});
document.querySelectorAll('.sec').forEach(function(s){s.classList.toggle('on',s.id==='s-'+cur)});
$('title').textContent={o:'总览',c:'会话上下文',l:'活动日志',m:'记忆',p:'画图',w:'世界',y:'钱包'}[cur];
if(cur==='c')loadC(1);if(cur==='l')loadL();if(cur==='m')loadMem();if(cur==='p')loadPic();if(cur==='w')loadW();if(cur==='y')loadY()}});
function g(u){return fetch(u,{cache:'no-store'}).then(function(r){if(r.status===401){location='.';return null}return r.json()}).catch(function(){return null})}
function tick(){
 g('data').then(function(d){
  if(!d||!d.ok)return;
  var s=d.sys||{},b=d.bot||{};
  $('gw').textContent=(b.gateway==='connected'?'● 在线':'● 离线');
  $('gw').className='pill '+(b.gateway==='connected'?'green':'red');
  $('up').textContent='运行 '+fmt(s.uptimeSec||0);
  $('clock').innerHTML=new Date(d.now).toLocaleString('zh-CN')+'<br><a href="logout">退出登录</a>';
  $('qq').textContent=b.botQQ||'—';$('ow').textContent=b.ownerQQ||'—';$('pe').textContent=b.persona||'—';
  $('dr').innerHTML=b.dryRun?'<span class="warn">开</span>':'<span class="ok">关</span>';
  $('rss').textContent=(s.rssMB||0)+' MB';$('heap').textContent=(s.heapMB||0)+' MB';
  $('ld').textContent=(s.load||[]).join(' / ');$('ut').textContent=fmt(s.uptimeSec||0);
  var m=s.mem||{};$('mp').textContent=(m.usedPct==null?0:m.usedPct)+'%';$('mb').style.width=(m.usedPct==null?0:m.usedPct)+'%';
  $('mt').textContent=(m.freeMB||0)+' / '+(m.totalMB||0)+' MB';
  if(s.disk){$('dk').textContent=s.disk.freeGB+' GB';$('dt').textContent=s.disk.totalGB+' GB'}
  var mm=b.memory||{};$('mc').textContent=(mm.count==null?'—':mm.count)+' 条';$('ma').textContent=(mm.auto==null?'—':mm.auto);
  var st=(d.router||{}).stats||{};$('r1').textContent=((st.cheap||0)+(st.balanced||0))+' 次';
  $('r2').textContent=((st.strong||0)+(st.long||0)+(st.vision||0))+' 次';
  var a=d.allow||{};$('wf').textContent=(a.private==null?'—':a.private)+' 人';$('wg').textContent=(a.groups==null?'—':a.groups)+' 个';
  var t=d.tts||{};$('tk').innerHTML=t.hasKey?'<span class="ok">已配置</span>':'<span class="warn">缺失</span>';
  $('ts').textContent=(t.semitones==null?'—':t.semitones)+' 半音';$('tq').textContent=(t.remaining==null?'—':t.remaining)+' 字';
 });
}
function loadC(){g('chats').then(function(d){if(!d)return;var L=d.list||[];
 $('chint').textContent='共 '+L.length+' 个会话'+(d.budget?' · 轮转阈值 '+d.budget.rotateTokens+' tokens':'');
 if(!L.length){$('cbox').innerHTML='<span class="dim">还没有会话</span>';return}
 var h='<table><thead><tr><th>聊天</th><th>标题</th><th>模型</th><th>级别</th><th>上下文占比</th><th>累计消耗</th><th>最后活跃</th></tr></thead><tbody>';
 L.forEach(function(x){var total=(d.window||1000000);var ctx=x.ctx||0;var ctxText=ctx?('<b>'+ctx.toLocaleString()+'</b> <span class="dim">/ '+total.toLocaleString()+'（'+Math.round(ctx/total*100)+'%）</span>'):(x.hasSession?'<span class="dim">—</span>':'<span class="dim">还没聊过</span>');var la=x.lastActive?new Date(x.lastActive).toLocaleString('zh-CN'):'<span class="dim">无会话</span>';h+='<tr><td class="mono">'+esc(x.chatId)+'</td><td>'+esc(x.title)+'</td><td class="mono dim">'+esc(x.model)+'</td><td class="dim">'+esc(x.level)+'</td>'+'<td>'+ctxText+'</td><td class="dim">'+(x.spent?x.spent.toLocaleString()+' tokens':'—')+'</td><td class="dim">'+la+'</td></tr>'})
 $('cbox').innerHTML=h+'</tbody></table>'})}
function loadL(){var n=$('ln').value;g('logs?n='+n).then(function(d){var L=(d&&d.lines)||[];
 var f=$('lf').value.trim();var out=f?L.filter(function(l){return l.indexOf(f)>=0}):L;
 out=out.slice().reverse();
 $('lbox').textContent=out.length?out.join(NL):'（空）'})}

var NL=String.fromCharCode(10);
function loadW(){
 g('world').then(function(d){
  if(!d||!d.ok)return;
  var w=d.world||{}, l=d.life||{}, wal=d.wallet||{};
  var openlux=wal.openlux||{};
  var asleep=l.asleep;
  document.getElementById('w-state').textContent=asleep?'睡着':'醒着';
  document.getElementById('w-meter').textContent=(l.energy!=null?Math.round(l.energy):'?')+' / '+(l.hunger!=null?Math.round(l.hunger):'?');
  document.getElementById('w-rev').textContent=w.lastReviewAt?new Date(w.lastReviewAt).toLocaleString('zh-CN'):'还没回顾过';
  document.getElementById('w-cost').textContent='$'+((openlux.realSpent||0).toFixed(4))+'（'+(openlux.realImages||0)+' 张）';
  document.getElementById('w-self').textContent=w.self||'（她还没写过自述，夜里回顾时会写）';
  var L=w.diaries||[];
  var box=document.getElementById('w-list');
  if(!L.length){box.innerHTML='<span class="dim">还没有日记，点右上角「现在回顾一次」</span>';return}
  box.innerHTML='';
  L.forEach(function(x,i){
   var a=document.createElement('a');
   a.href='javascript:void(0)';
   a.style.marginRight='14px';
   a.textContent=x.date;
   a.onclick=function(){openDiary(x.date)};
   box.appendChild(a);
   if(i===0) openDiary(x.date);
  });
 }).catch(function(){});
}
function openDiary(date){
 g('diary?date='+encodeURIComponent(date)).then(function(d){
  var el=document.getElementById('w-text');
  if(!d||!d.ok){el.style.display='none';return}
  el.style.display='block';
  el.textContent=(d.text||'（这篇是空的）');
 });
}
function runReview(){
 var btn=event&&event.target; if(btn){btn.disabled=true;btn.textContent='她在想…'}
 g('world').then(function(){});
 fetch('../../api/ext/world/run',{method:'POST'}).then(function(){return null}).catch(function(){});
 setTimeout(function(){ if(btn){btn.disabled=false;btn.textContent='现在回顾一次'} loadW() }, 25000);
}

function loadPic(){
 g('picture').then(function(d){
  if(!d||!d.ok)return;
  var st=d.state||{};
  var cur=st.settings&&st.settings.openaiModel||'';
  var sel=document.getElementById('pmd');
  if(sel.options.length===0&&st.models&&st.models.openai){
    st.models.openai.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;if(m===cur)o.selected=true;sel.appendChild(o)});
  }
  var q=st.quota||{};
  var usedTotal=Object.keys(q.used||{}).length;
  var totalCnt=(st.picturesCount!=null?st.picturesCount:(d.gallery||[]).length);
document.getElementById('pstat').textContent='模型 '+(cur||'?')+' · 共 '+totalCnt+' 张 · 本次运行成功 '+(st.ok||0)+' / 失败 '+(st.fail||0)+' · 其他人每天 '+(q.free||5)+' 张（你无限）';
  var L=d.gallery||[];
  var cnt=document.getElementById('pgrid');
  if(cnt) cnt.setAttribute('data-count', L.length);
  if(!L.length){document.getElementById('pgrid').innerHTML='<span class="dim">还没有画作</span>';return}
  var h='';
  L.forEach(function(x){
    h+='<figure style="margin:0"><a href="img?file='+encodeURIComponent(x.file)+'" target="_blank">'+
       '<img src="thumb?file='+encodeURIComponent(x.file)+'" loading="lazy" style="width:100%;border-radius:12px;border:1px solid var(--line);display:block"></a>'+
       '<figcaption class="dim" style="font-size:11px;margin-top:6px;line-height:1.4">'+esc(String(x.file).replace(/^\d{8}-\d{6}-/,'')).slice(0,44)+'</figcaption></figure>';
  });
  document.getElementById('pgrid').innerHTML=h;
 });
}
function doDraw(){
  var p=document.getElementById('pp').value.trim();
  if(!p){alert('先写点描述');return}
  var b=document.getElementById('pbtn');b.disabled=true;b.textContent='画着…';
  document.getElementById('pstat').textContent='生成中，通常 20-45 秒…';
  fetch('draw',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p,size:document.getElementById('psz').value,model:document.getElementById('pmd').value})})
   .then(function(r){return r.json()}).then(function(j){
     b.disabled=false;b.textContent='开始画';
     if(j&&j.ok){document.getElementById('pstat').textContent='好了：'+(j.model||'')+' · '+(j.ms/1000).toFixed(1)+' 秒 · '+Math.round(j.bytes/1024)+'KB';loadPic();loadUsage();loadMoney()}
     else{document.getElementById('pstat').textContent='失败：'+((j&&j.message)||'未知');alert('画失败：'+((j&&j.message)||''))}
   }).catch(function(e){b.disabled=false;b.textContent='开始画';document.getElementById('pstat').textContent='请求出错'});
}
function loadMem(){
 g('memory').then(function(d){
  if(!d||!d.ok)return;
  var st=d.stats||{},w=d.weights||{},c=d.cold||{},a=d.archive||{},k=d.compact||{};
  var rows=[
   ['记忆总数',(st.total||0)+' 条','人物 '+(st.people||0)+' · 永不遗忘 '+(st.never||0)],
   ['权重分布','快忘 '+(w.fast||0)+' · 常忘 '+(w.normal||0),'慢忘 '+(w.slow||0)+' · 不忘 '+(w.never||0)],
   ['冷存',(c.tracked||0)+' 条跟踪','已归档 '+(c.archived||0)+' · '+(c.rows||0)+' 行'],
   ['归档',(a.rows||0).toLocaleString()+' 行','事件 '+(a.events||0)],
   ['整理器',(k.runs||0)+' 次运行','上次：淡化 '+(k.lastResult&&k.lastResult.faded||0)+' / 遗忘 '+(k.lastResult&&k.lastResult.forgot||0)]
  ];
  var h='';
  rows.forEach(function(r){h+='<div class="card row"><h2>'+esc(r[0])+'</h2><div class="kv"><span>'+esc(r[1])+'</span></div><div class="kv"><span class="dim">'+esc(r[2])+'</span></div></div>'});
  document.getElementById('mcards').innerHTML=h;
  var q=(document.getElementById('mf').value||'').trim();
  var L=(d.list||[]).filter(function(x){return !q||(x.text||'').indexOf(q)>=0||(x.about||'').indexOf(q)>=0||(x.tags||[]).join(',').indexOf(q)>=0});
  document.getElementById('mhint').textContent=(d.list||[]).length+' 条'+(q?('，匹配 '+L.length):'');
  if(!L.length){document.getElementById('mbox').innerHTML='<span class="dim">没有记忆</span>';return}
  var t='<table><thead><tr><th style="width:96px">时间</th><th>内容</th><th style="width:80px">重要度</th><th style="width:110px">标签</th><th style="width:80px">关于</th></tr></thead><tbody>';
  L.slice(0,200).forEach(function(x){
    var dt=x.at?new Date(x.at).toLocaleDateString('zh-CN'):'';
    t+='<tr><td class="dim mono">'+dt+'</td><td>'+esc(x.text).slice(0,220)+'</td>'+
       '<td>'+(Math.round((x.importance||0)*100)/100)+'</td>'+
       '<td class="dim">'+esc((x.tags||[]).join(' '))+'</td>'+
       '<td class="dim">'+esc(x.about||'')+'</td></tr>';
  });
  document.getElementById('mbox').innerHTML=t+'</tbody></table>';
 });
}
function runCompact(){
 g('memory/run').then(function(r){
  if(r&&r.ok){alert('整理完成：'+JSON.stringify(r.result));loadMem()}
  else alert('整理失败');
 });
}
  function loadY(){
   g('money').then(function(d){
    if(!d||!d.ok)return;
    var im=d.images||{},c=d.chat||{},b=(d.balance&&d.balance.deepseek)||{};
    document.getElementById('y-count').textContent=(im.count||0)+' 张';
    document.getElementById('y-img').textContent='$'+(im.costUsd||0).toFixed(4);
    document.getElementById('y-avg').textContent=(im.avgUsd!=null)?('$'+Number(im.avgUsd).toFixed(5)):'-';
    var l=im.last;
    document.getElementById('y-last').textContent=l?('#'+l.n+' '+(l.model||'?')+' '+(l.costUsd!=null?('$'+Number(l.costUsd).toFixed(4)):'未结算')):'-';
    document.getElementById('y-chat').textContent='¥'+(c.cny||0).toFixed(2);
    document.getElementById('y-tok').textContent=((c.total||0)/10000).toFixed(1)+' 万';
    document.getElementById('y-turns').textContent=(c.turns||0)+' 轮';
    document.getElementById('y-bal').textContent=(b.total!=null)?('¥'+b.total):'读取失败';
    document.getElementById('y-acc').textContent=(im.accountUsd!=null)?('$'+Number(im.accountUsd).toFixed(2)):'-';
    var rows=(d.list||[]).map(function(x){
     var when=new Date(x.at||0).toLocaleString('zh-CN');
     var cost=(typeof x.costUsd==='number')?('$'+x.costUsd.toFixed(4)):'未结算';
     var pr=String(x.prompt||'').replace(/[<>&]/g,' ').slice(0,30);
     return '<div>#'+x.n+' · '+when+' · '+(x.model||'?')+' · '+cost+' · '+pr+'</div>';
    }).join('');
    document.getElementById('y-list').innerHTML=rows||'还没画过图';
   }).catch(function(){});
  }
function loadMoney(){
 g('money').then(function(d){
  if(!d||!d.ok)return;
  var im=d.images||{}, c=d.chat||{};
  document.getElementById('m-img').textContent=(im.count||0)+' 张 · $'+(im.costUsd||0).toFixed(4);
  var l=im.last;
  document.getElementById('m-last').textContent=l?('#'+l.n+' '+(l.costUsd!=null?('$'+l.costUsd.toFixed(4)):'未结算')):'—';
  document.getElementById('m-chat').textContent='¥'+(c.cny||0).toFixed(2)+' · '+((c.total||0)/10000).toFixed(1)+'万 tokens';
  var b=(d.balance&&d.balance.deepseek)||{};
  var acct=(im.accountUsd!=null)?('$'+Number(im.accountUsd).toFixed(2)+' 已用'):'';
  document.getElementById('m-bal').textContent='DeepSeek ¥'+(b.total!=null?b.total:'?')+(acct?(' · OpenLux '+acct):'');
 }).catch(function(){});
}
function loadUsage(){
 fetch('usage',{cache:'no-store'}).then(function(r){return r.json()}).then(function(u){
  if(!u||!u.ok)return;
  var C=169.6,pct=Math.min(100,u.pct||0);
  $('ring').style.strokeDashoffset=String(C*(1-pct/100));
  $('ringtxt').textContent=pct+'%';
  $('u-ctx').textContent=(u.used||0).toLocaleString()+' / '+(u.window||0).toLocaleString();
  $('u-total').textContent=(u.total||0).toLocaleString()+' tokens';
  $('u-io').textContent=(u.input||0).toLocaleString()+' / '+(u.output||0).toLocaleString();
  $('u-cache').textContent=(u.cache||0).toLocaleString()+' tokens';
  $('u-turns').textContent=(u.turns||0)+' 轮';
 }).catch(function(){});
}
tick();loadUsage();loadMoney();
setInterval(function(){ if(document.getElementById('s-c') && document.getElementById('s-c').classList.contains('on')) loadC(1) }, 300000);setInterval(tick,10000);setInterval(loadUsage,300000);setInterval(loadMoney,300000);
$('lf').oninput=function(){loadL()};$('mf').oninput=function(){loadMem()};
</script></body></html>`
