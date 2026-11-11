// 画图工坊：支持多后端的生图模块。
//   dashscope  —— 通义万相 / qwen-image（当前默认，43 秒出图）
//   openai     —— 任何兼容 /v1/images/generations 的服务（GPT-image、硅基流动、中转站）
//   gemini     —— Google Gemini 生图（nano banana），走原生 API
// 生成的图存进和 Aurabot 自带画廊同一个目录，面板与内置画廊共享。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setDefaultResultOrder } from 'node:dns'
const DSH = process.env.DSH_HOME || '/root/.dsh'
try { setDefaultResultOrder('ipv4first') } catch {}

const DIR = DSH + '/plugins-data/aurabot/imagegen'
const CRED = DSH + '/.credentials.yaml'

const MODELS = {
  dashscope: ['qwen-image-3.0', 'qwen-image-3.0-pro', 'wan2.7-image', 'z-image-turbo'],
  openai: ['gpt-image-2.6-sunburst-c', 'gpt-image-2.5-sunburst-c', 'muse-image'],
  gemini: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'],
}

function readKey(name) {
  try {
    const t = readFileSync(CRED, 'utf8')
    const m = t.match(new RegExp(name + ':\\s*(\\S+)'))
    return m ? m[1].replace(/['"]/g, '') : ''
  } catch { return '' }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}

async function download(url, headers = {}) {
  const r = await fetchRetry(url, { headers, signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`下载图片失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 1000) throw new Error('下载到的图片太小')
  return buf
}

async function viaDashscope(prompt, { model, size }) {
  const key = readKey('QWEN_TOKEN_PLAN_CN_API_KEY')
  if (!key) throw new Error('没有 QWEN 密钥')
  const body = {
    model: model || 'qwen-image-3.0',
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: { size: size || '1024*1024', n: 1, watermark: false },
  }
  const r = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error('通义返回的不是 JSON：' + text.slice(0, 100)) }
  if (!r.ok) throw new Error((j && j.message) || `HTTP ${r.status}`)
  const items = (((j.output || {}).choices || [])[0] || {}).message || {}
  const img = (items.content || []).find((x) => x && x.image)
  if (!img) throw new Error('通义没返回图片地址')
  return { buf: await download(img.image), model: body.model }
}

async function viaOpenai(prompt, { model, size, baseUrl, apiKey }) {
  const base = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const key = apiKey || readKey('OPENAI_API_KEY')
  if (!key) throw new Error('没有 OpenAI 密钥')
  const r = await fetchRetry(`${base}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-image-2', prompt, n: 1, size: String(size || '1024x1024').replace('*', 'x'), response_format: 'b64_json' }),
    signal: AbortSignal.timeout(180000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error('返回的不是 JSON：' + text.slice(0, 100)) }
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`)
  const item = (j.data || [])[0] || {}
  const imageTokens = (j.usage && j.usage.output_tokens_details && j.usage.output_tokens_details.image_tokens) || (j.usage && j.usage.output_tokens) || 0
  if (item.b64_json) return { buf: Buffer.from(item.b64_json, 'base64'), model, imageTokens }
  if (item.url) return { buf: await download(item.url, { 'user-agent': 'Mozilla/5.0' }), model, imageTokens }
  throw new Error('没有拿到图片数据')
}

async function viaGemini(prompt, { model, apiKey }) {
  const key = apiKey || readKey('GEMINI_API_KEY') || readKey('GOOGLE_API_KEY')
  if (!key) throw new Error('没有 Gemini 密钥')
  const m = model || 'gemini-2.5-flash-image'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
    signal: AbortSignal.timeout(180000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error('返回的不是 JSON：' + text.slice(0, 100)) }
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`)
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || []
  const inline = parts.find((p) => p.inlineData || p.inline_data)
  if (!inline) throw new Error('Gemini 没返回图片')
  const d = inline.inlineData || inline.inline_data
  return { buf: Buffer.from(d.data, 'base64'), model: m }
}


// ---------- 配额：主人无限量，其他人每天 5 张，可被授权 +5 ----------
const QUOTA_DIR = DSH + '/plugins-data/aurabot/modules-data/image-studio'
const QUOTA_FILE = QUOTA_DIR + '/quota.json'
const FREE_PER_DAY = 5

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

function readQuota() {
  try {
    const j = JSON.parse(readFileSync(QUOTA_FILE, 'utf8'))
    if (j && j.date === today()) return j
  } catch {}
  return { date: today(), used: {}, bonus: {} }
}

function writeQuota(q) {
  try { mkdirSync(QUOTA_DIR, { recursive: true }); writeFileSync(QUOTA_FILE, JSON.stringify(q, null, 1)) } catch {}
}

function remainingOf(q, key) {
  const used = q.used[key] || 0
  const bonus = q.bonus[key] || 0
  return Math.max(0, FREE_PER_DAY + bonus - used)
}

function consumeQuota(key) {
  const q = readQuota()
  q.used[key] = (q.used[key] || 0) + 1
  writeQuota(q)
  return remainingOf(q, key)
}

function grantQuota(key, add = 5) {
  const q = readQuota()
  q.bonus[key] = (q.bonus[key] || 0) + add
  writeQuota(q)
  return remainingOf(q, key)
}


// ---------- 参考图：先搜图，再拿参考图去生成 ----------
const UA_IMG = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function bingImageUrls(query, count = 10) {
  const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(query) + '&first=0&count=' + count + '&mmasync=1'
  const r = await fetch(url, { headers: { 'user-agent': UA_IMG, referer: 'https://www.bing.com/images/search' }, signal: AbortSignal.timeout(25000) })
  if (!r.ok) throw new Error('图片搜索失败 HTTP ' + r.status)
  const html = await r.text()
  const out = []
  const re = /murl&quot;:&quot;(.*?)&quot;/g
  let m
  while ((m = re.exec(html))) {
    const u = m[1].replace(/\\u002f/gi, '/')
    if (/^https?:/i.test(u)) out.push(u)
    if (out.length >= count) break
  }
  return out
}

async function fetchImageBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA_IMG, accept: 'image/*' }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const type = String(r.headers.get('content-type') || '')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 15000) throw new Error('图太小 ' + buf.length)
  return { buf, type: type.startsWith('image/') ? type : 'image/jpeg' }
}

/** 搜参考图：返回第一张能下载的图。 */
async function findReference(query) {
  const urls = await bingImageUrls(query, 10)
  if (!urls.length) throw new Error('没搜到「' + query + '」的图片')
  const failed = []
  for (const u of urls) {
    try { const r = await fetchImageBuf(u); return { buf: r.buf, type: r.type, url: u } }
    catch (e) { failed.push(u) }
  }
  throw new Error('搜到 ' + urls.length + ' 张但都下不动')
}

/** 带参考图生成（OpenAI 兼容 images/edits）。 */
async function viaEdits(prompt, refBuf, opt) {
  const base = String(opt.baseUrl || 'https://api.openlux.ai/v1').replace(/\/+$/, '')
  const key = opt.apiKey
  if (!key) throw new Error('没有 API Key')
  const fd = new FormData()
  fd.append('model', opt.model || 'gpt-image-2.6-sunburst-c')
  fd.append('prompt', prompt)
  fd.append('size', String(opt.size || '1024x1024').replace('*', 'x'))
  fd.append('n', '1')
  fd.append('image', new Blob([refBuf], { type: 'image/png' }), 'ref.png')
  const r = await fetchRetry(base + '/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(240000) })
  const txt = await r.text()
  let j
  try { j = JSON.parse(txt) } catch { throw new Error('返回不是 JSON：' + txt.slice(0, 100)) }
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status))
  const d = (j.data || [])[0] || {}
  if (d.b64_json) return Buffer.from(d.b64_json, 'base64')
  if (d.url) return await download(d.url)
  throw new Error('没拿到图片')
}


// ---------- 参考图缓存（按搜索词 hash 存，避免重复下载）----------
const REF_DIR = DSH + '/plugins-data/aurabot/modules-data/image-studio/refs'
const REF_TTL = 7 * 24 * 3600 * 1000

function refPath(q) {
  const h = createHash('sha1').update(String(q)).digest('hex').slice(0, 20)
  return { file: REF_DIR + '/' + h + '.bin', meta: REF_DIR + '/' + h + '.json' }
}

async function findReferenceCached(query) {
  try { mkdirSync(REF_DIR, { recursive: true }) } catch {}
  const { file, meta } = refPath(query)
  try {
    if (existsSync(file) && existsSync(meta)) {
      const m = JSON.parse(readFileSync(meta, 'utf8'))
      if (Date.now() - m.at < REF_TTL) return { buf: readFileSync(file), type: m.type || 'image/jpeg', url: m.url, cached: true }
    }
  } catch {}
  const r = await findReference(query)
  try {
    writeFileSync(file, r.buf)
    writeFileSync(meta, JSON.stringify({ at: Date.now(), url: r.url, type: r.type, query }))
  } catch {}
  return { ...r, cached: false }
}

// ---------- 画作索引（编号 → 文件）----------
const INDEX_FILE = DSH + '/plugins-data/aurabot/modules-data/image-studio/pictures.json'

function readIndex() {
  try { const j = JSON.parse(readFileSync(INDEX_FILE, 'utf8')); if (Array.isArray(j.items)) return j } catch {}
  return { seq: 0, items: [] }
}
function saveIndex(idx) { try { mkdirSync(INDEX_FILE.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 1)) } catch {} }
function addToIndex(file, prompt, model, costUsd, imageTokens) {
  const idx = readIndex()
  idx.seq = (idx.seq || 0) + 1
  idx.items = [...(idx.items || []), { n: idx.seq, file, prompt: String(prompt).slice(0, 120), model, at: Date.now(), ...(costUsd === null || costUsd === undefined ? {} : { costUsd }), ...(imageTokens ? { imageTokens } : {}) }].slice(-500)
  saveIndex(idx)
  return idx.seq
}
function findByNumber(num) {
  const idx = readIndex()
  const items = idx.items || []
  if (!num) return items[items.length - 1] || null
  const n = Number(num)
  return items.find((x) => x.n === n) || null
}


// ---------- 花钱：用中转站账单接口算这一张花了多少 ----------
const BILLING = 'https://api.openlux.ai/v1/dashboard/billing/usage'
async function openluxSpent(apiKey) {
  try {
    const r = await fetchRetry(BILLING, { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    return Number(j.total_usage) || 0
  } catch { return null }
}


// ---------- 定价表：从中转站 /api/pricing 拉，按次单价（USD）----------
let priceCache = { at: 0, map: {} }
async function loadPricing(apiKey, base, ratioOpt) {
  if (Date.now() - priceCache.at < 3600_000 && Object.keys(priceCache.map).length) return priceCache.map
  try {
    const root = String(base || 'https://api.openlux.ai/v1').replace(/\/v1\/?$/, '')
    const r = await fetchRetry(root + '/api/pricing', { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(20000) })
    const j = await r.json()
    const map = {}
    const ratio = Number(ratioOpt) || 0.09192
    for (const m of (j.data || [])) if (m && m.model_name && m.quota_type === 1 && Number(m.model_price) > 0) map[m.model_name] = Math.round(Number(m.model_price) * ratio * 1000000) / 1000000
    priceCache = { at: Date.now(), map }
    return map
  } catch { return priceCache.map }
}


// 带重试的 fetch：中转站偶发连接抖动，失败自动再试一次
async function fetchRetry(url, init = {}, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, init) }
    catch (e) {
      last = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
    }
  }
  throw new Error('连不上中转站（已重试 ' + tries + ' 次）：' + String((last && last.message) || last))
}


// ---------- 模型健康：连续拿不到图就自动停用 ----------
const HEALTH_FILE = DSH + '/plugins-data/aurabot/modules-data/image-studio/health.json'
function readHealth() {
  try { const j = JSON.parse(readFileSync(HEALTH_FILE, 'utf8')); if (j && typeof j === 'object') return j } catch {}
  return {}
}
function saveHealth(h) {
  try { mkdirSync(HEALTH_FILE.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 1)) } catch {}
}
function modelBlocked(model) {
  const h = readHealth()[model]
  return Boolean(h && (h.fail || 0) >= 3 && (h.ok || 0) === 0)
}
function noteModel(model, ok, err) {
  const h = readHealth()
  const cur = h[model] || { ok: 0, fail: 0, lastError: '', lastAt: 0 }
  if (ok) { cur.ok += 1; cur.lastError = '' } else { cur.fail += 1; cur.lastError = String(err || '').slice(0, 120) }
  cur.lastAt = Date.now()
  h[model] = cur
  saveHealth(h)
}


function maskSettings(s) {
  const out = { ...s }
  if (out.apiKey) out.apiKey = String(out.apiKey).slice(0, 6) + '…' + String(out.apiKey).slice(-4)
  for (const k of Object.keys(out)) if (/key|token|secret/i.test(k) && out[k]) out[k] = String(out[k]).slice(0, 6) + '…'
  return out
}


const KEY_FILE = DSH + '/plugins-data/aurabot/modules-data/image-studio/key.txt'
function readKeyFile() {
  try { const k = readFileSync(KEY_FILE, 'utf8').trim(); if (k) return k } catch {}
  return ''
}

export default {
  id: 'image-studio',
  name: '画图工坊',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '生图：默认通义千问 qwen-image-3.0，也支持 OpenAI（GPT-image）和 Gemini。带画廊。',
  defaults: { enabled: true, backend: 'openai', model: 'qwen-image-3.0', size: '1024*1024', openaiBaseUrl: 'https://api.openlux.ai/v1', openaiModel: 'gpt-image-2.6-sunburst-c', openaiModelCheap: 'muse-image', geminiModel: 'gemini-2.5-flash-image', groupRatio: 0.09192 },
  settings: [
    { key: 'backend', label: '后端', type: 'string', hint: 'dashscope / openai / gemini' },
    { key: 'model', label: '通义模型', type: 'string' },
    { key: 'size', label: '尺寸', type: 'string', hint: '如 1024*1024' },
    { key: 'openaiBaseUrl', label: 'OpenAI 兼容地址', type: 'string', hint: '留空用官方；中转站填到 /v1 为止' },
    { key: 'groupRatio', label: '分组结算倍率', type: 'number', hint: '中转站分组价格倍率，比如 0.09192；实际单价 = 基础价 × 这个倍率' },
  ],
  setup(api) {
    const settings = () => { const s = { ...api.settings() }; const k = readKeyFile(); if (k) s.apiKey = k; return s }

    const stats = { total: 0, ok: 0, fail: 0, lastMs: 0, lastError: '', lastFile: '' }

    const gallery = (limit = 24) => {
      try {
        mkdirSync(DIR, { recursive: true })
        return readdirSync(DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .map((f) => { const p = join(DIR, f); const st = statSync(p); return { file: f, size: st.size, at: st.mtimeMs } })
          .sort((a, b) => b.at - a.at).slice(0, limit)
      } catch { return [] }
    }

    async function generate(prompt, opt = {}) {
      const s = settings()
      // 配额：主人不限，其他人每天 5 张（可被授权加量）
      const key = String(opt.quotaKey || '')
      const isOwner = Boolean(opt.isOwner)
      if (!isOwner && key) {
        const q = readQuota()
        if (remainingOf(q, key) <= 0) {
          throw new Error(`今天的 ${FREE_PER_DAY} 张已经用完了，明天再来吧`)
        }
      }
      const backend = String(opt.backend || s.backend || 'dashscope')
      const t0 = Date.now()
      stats.total += 1
      const willModel = opt.model || (isOwner ? (s.openaiModel || s.model) : (s.openaiModelCheap || s.openaiModel || s.model))
      if (modelBlocked(willModel)) return { ok: false, message: `模型 ${willModel} 连续拿不到图，已自动停用；换一个模型再试` }
      let spentBefore = null
      try {
        const chosenModel = opt.model || (isOwner ? (s.openaiModel || s.model) : (s.openaiModelCheap || s.openaiModel || s.model))
        const common = { model: chosenModel, size: opt.size || s.size, baseUrl: opt.baseUrl || s.openaiBaseUrl, apiKey: opt.apiKey || s.apiKey }
        let refInfo = null
        let r
        if (backend === 'openai') spentBefore = await openluxSpent(s.apiKey)
        if (opt.reference) {
          const ref = await findReferenceCached(String(opt.reference))
          refInfo = { query: String(opt.reference), url: ref.url, bytes: ref.buf.length, cached: Boolean(ref.cached) }
          const finalPrompt = prompt + '（参考提供的图片，保持人物/对象的主要特征，按描述重新创作）'
          const buf = backend === 'openai' ? await viaEdits(finalPrompt, ref.buf, common) : await viaDashscope(finalPrompt, common)
          r = { buf, model: (opt.model || s.openaiModel) + ' + 参考图' }
        } else {
          r = backend === 'openai' ? await viaOpenai(prompt, common)
            : backend === 'gemini' ? await viaGemini(prompt, { model: opt.model || s.geminiModel })
            : await viaDashscope(prompt, common)
        }
        mkdirSync(DIR, { recursive: true })
        const file = `${stamp()}-${safeName(prompt)}.png`
        writeFileSync(join(DIR, file), r.buf)
        let costUsd = null
        if (backend === 'openai') {
          const prices = await loadPricing(s.apiKey, s.openaiBaseUrl, s.groupRatio)
          const key2 = String(r.model || '').replace(' + 参考图', '')
          if (prices[key2]) costUsd = prices[key2]
        }
        const num = addToIndex(file, prompt, r.model, costUsd, r.imageTokens)
        noteModel(String(r.model || '').replace(' + 参考图', ''), true)
        stats.ok += 1; stats.lastMs = Date.now() - t0; stats.lastFile = file
        let left = null
        if (!isOwner && key) left = consumeQuota(key)
        return { ok: true, file, number: num, costUsd, bytes: r.buf.length, ms: stats.lastMs, model: r.model, backend, ...(refInfo ? { reference: refInfo } : {}), ...(left === null ? {} : { remaining: left }) }
      } catch (error) {
        noteModel(willModel, false, error && (error.message || error))
        stats.fail += 1; stats.lastError = String(error.message || error).slice(0, 160); stats.lastMs = Date.now() - t0
        throw error
      }
    }

    api.tool(({ chat, sessionId }) => api.defineTool({
      name: 'draw_picture',
      description: '画一张图。别人要图、想看你画的东西时用。提示词尽量具体（主体、风格、颜色、背景）。',
      properties: {
        prompt: { type: 'string', description: '画面描述' },
        size: { type: 'string', description: '可选，如 1024*1024' },
        reference: { type: 'string', description: '可选。要画真实存在的人/物/角色时，填搜索关键词（如「梁文锋」「初音未来」）。会先上网找参考图，再据此生成，长得像的概率高很多' },
      },
      required: ['prompt'],
      execute: async ({ prompt, size, reference }) => {
        try {
          let owner = false
          try { owner = api.core.hub.turnHasOwner(sessionId) === true } catch {}
          if (chat.kind === 'private' && String(chat.userId) === String(api.config().ownerQQ)) owner = true
          const quotaKey = chat.kind === 'private' ? String(chat.userId || '') : String(chat.chatId || '')
          const r = await generate(String(prompt || ''), { ...(size ? { size } : {}), ...(reference ? { reference } : {}), quotaKey, isOwner: owner })
          const path = join(DIR, r.file)
          try { await api.sendImage(chat.chatId, path) } catch (e) {}
          return { ok: true, message: `画好了（${r.model}，${Math.round(r.ms / 1000)} 秒）${r.remaining === undefined ? '' : '，今天还能画 ' + r.remaining + ' 张'}，已经发到聊天里。` }
        } catch (error) {
          return { ok: false, message: '没画出来：' + String(error.message || error).slice(0, 140) }
        }
      },
    }))

    api.command({ name: '画', desc: '/画 提示词 —— 画一张图', run: async (arg) => {
      if (!arg) return '要画什么？'
      try { const r = await generate(String(arg)); return `画好了（${r.model}，${Math.round(r.ms / 1000)}秒）` }
      catch (e) { return '没画出来：' + String(e.message || e).slice(0, 120) }
    } })

    // 授权：/加图 YOUR_QQ  → 该 QQ 今天的额度 +5
    api.command({
      name: '加图',
      desc: '/加图 <QQ号> —— 给这个人今天的额度加 5 张',
      run: async (arg) => {
        const qq = String(arg || '').replace(/\D/g, '')
        if (!/^\d{5,12}$/.test(qq)) return '要一个 QQ 号，比如 /加图 YOUR_QQ'
        const left = grantQuota(qq, 5)
        return `好，${qq} 今天还能画 ${left} 张`
      },
    })

    // 主人说「QQ号为 xxx 的人可以继续生成图片」时也能自动加 5 张
    api.on('message', async (msg) => {
      try {
        const cfg = api.config()
        if (!msg || String(msg.userId) !== String(cfg.ownerQQ)) return false
        const t = String(msg.text || '')
        if (!/(qq|QQ)\s*号|(?:^|\s)\d{5,12}(?:\s|$)/.test(t)) return false
        if (!/可以|允许|继续|加|给/.test(t)) return false
        if (!/生成图片|生图|画图|画一张|图片/.test(t)) return false
        const m = t.match(/(\d{5,12})/)
        if (!m) return false
        const left = grantQuota(m[1], 5)
        api.log.info?.(`按主人吩咐：${m[1]} 的今日生图额度 +5（剩 ${left}）`)
        try { await api.send(msg.chatId, `好，${m[1]} 今天还能画 ${left} 张`) } catch (e) {}
      } catch (e) {}
      return false
    })


    const isOwnerCtx = (chat) => { const o = String(api.config().ownerQQ); if (!chat) return false; if (chat.userId) return String(chat.userId) === o; return String(chat.chatId || '') === 'private:' + o }

    // 目标解析：这里 / 主人 / 群号 / QQ号
    function resolveTarget(to, chat) {
      const t = String(to || '').trim()
      const owner = String(api.config().ownerQQ)
      const groups = (((api.config().allow || {}).groups) || []).map(String)
      const speaker = String((chat && chat.userId) || '')
      const ownerCtx = speaker === owner
      if (/我|自己/.test(t) && !/主人/.test(t)) return speaker ? 'private:' + speaker : chat.chatId
      if (!t || /这里|本群|当前|这个群|这边/.test(t)) return chat.chatId
      if (/主人/.test(t)) return 'private:' + owner
      if (!ownerCtx) return chat.chatId
      const gg = t.match(/群\D*(\d{5,12})/)
      if (gg) return groups.includes(gg[1]) ? 'group:' + gg[1] : chat.chatId
      const mm = t.match(/(\d{5,12})/)
      if (mm) return groups.includes(mm[1]) ? 'group:' + mm[1] : 'private:' + mm[1]
      return chat.chatId
    }

    api.tool(({ chat, level }) => api.defineTool({
      name: 'send_picture',
      description: '把已经画好的图发到指定地方。用户说「把这张图发到鱼群」「把第 3 张发给 xxx」时用它。不给编号就是最近画的那张。',
      properties: {
        to: { type: 'string', description: '发到哪：这里／主人／群号／QQ号' },
        number: { type: 'number', description: '画作编号，不填就是最新一张' },
      },
      required: ['to'],
      execute: async ({ to, number }) => {
        if (level !== 'full') return { ok: false, message: '发图只有主人能用' }
        const rec = findByNumber(number)
        if (!rec) return { ok: false, message: number ? `没有编号 #${number} 的画` : '还没画过图' }
        const p = join(DIR, rec.file)
        if (!existsSync(p)) return { ok: false, message: '这张图不在硬盘上了' }
        const target = resolveTarget(to, chat)
        try {
          await api.sendImage(target, p)
          return { ok: true, message: `已把 #${rec.n}（${String(rec.prompt).slice(0, 20)}…）发到 ${target}` }
        } catch (error) {
          return { ok: false, message: '发失败：' + String(error.message || error).slice(0, 100) }
        }
      },
    }))

    api.tool(({ chat, level }) => api.defineTool({
      name: 'list_pictures',
      description: '列出最近画过的图（带编号），用户问「都画过什么」或要从里面挑一张发出去时用。',
      properties: { limit: { type: 'number', description: '默认 10' } },
      required: [],
      execute: async ({ limit }) => {
        if (level !== 'full') return { ok: false, message: '看图库只有主人能用' }
        const idx = readIndex()
        const items = (idx.items || []).slice(-(limit || 10)).reverse()
        if (!items.length) return { ok: true, message: '还没画过图' }
        return { ok: true, message: items.map((x) => `#${x.n} ${String(x.prompt).slice(0, 40)}（${new Date(x.at).toLocaleString('zh-CN')}）`).join('\n') }
      },
    }))

    api.command({ name: '发图', desc: '/发图 <目标> [编号] —— 把画好的图发出去', run: async (arg, msg) => {
      if (String((msg && msg.userId) || '') !== String(api.config().ownerQQ)) return '只有主人能发图'
      const parts = String(arg || '').trim().split(/\s+/)
      const to = parts[0] || ''
      const num = parts[1] ? Number(parts[1]) : 0
      if (!to) return '用法：/发图 鱼群   或   /发图 12345678 3'
      const rec = findByNumber(num)
      if (!rec) return num ? `没有 #${num}` : '还没画过图'
      const target = resolveTarget(to, { chatId: msg && msg.chatId, userId: msg && msg.userId, kind: msg && msg.kind, groupId: msg && msg.groupId })
      try { await api.sendImage(target, join(DIR, rec.file)); return `#${rec.n} 已发到 ${target}` }
      catch (e) { return '发失败：' + String(e.message || e).slice(0, 80) }
    } })


    // 转发「别人刚发来的图」：从 hub 的最近图片里取，转成 base64 发到目标
    api.tool(({ chat, level }) => api.defineTool({
      name: 'forward_image',
      description: '把聊天里刚收到的图片转发到别处。用户说「把刚才那张图发到鱼群」「把上面那张转给我」时用。只对最近收到的图有效。',
      properties: {
        to: { type: 'string', description: '发到哪：这里／主人／群号／QQ号' },
        which: { type: 'number', description: '第几张（1=最新），默认 1' },
      },
      required: ['to'],
      execute: async ({ to, which }) => {
        if (level !== 'full') return { ok: false, message: '转发图片只有主人能用' }
        try {
          const hub = api.core.hub
          if (!hub || typeof hub.recentMedia !== 'function') return { ok: false, message: '取不到最近的图片' }
          const list = hub.recentMedia(chat.chatId) || []
          const images = list.filter((x) => x && x.seg && x.seg.type === 'image' && !x.sticker)
          if (!images.length) return { ok: false, message: '这个聊天里最近没有收到图片' }
          const pick = images[Math.min(images.length - 1, Math.max(0, (which || 1) - 1))]
          const net = await import(DSH + '/profiles/web/node_modules/dsh-aurabot-qq/src/core/net.js')
          if (!net || typeof net.segmentBytes !== 'function') return { ok: false, message: '取图失败（内部接口变了）' }
          const buf = await net.segmentBytes(pick.seg, api.core.onebot, { maxBytes: 8 * 1024 * 1024 })
          if (!buf || buf.length < 500) return { ok: false, message: '取到的图片是空的' }
          const target = resolveTarget(to, chat)
          await api.sendSegments(target, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], '[转发图片]')
          return { ok: true, message: `已把最近那张图（${Math.round(buf.length / 1024)}KB）发到 ${target}` }
        } catch (error) {
          return { ok: false, message: '转发失败：' + String(error.message || error).slice(0, 100) }
        }
      },
    }))

    api.route('/state', async () => { const q = readQuota(); const idx = readIndex(); return { ok: true, ...stats, health: readHealth(), picturesCount: (idx.items || []).length, filesCount: gallery(9999).length, lastNumber: idx.seq || 0, settings: maskSettings(settings()), models: MODELS, gallery: gallery(6), quota: { date: q.date, free: FREE_PER_DAY, used: q.used, bonus: q.bonus }, pictures: (readIndex().items || []).slice(-10) } })
    api.route('/findref', async (req) => {
      const q = String(api.core.http.query(req).q || '').trim()
      if (!q) return { ok: false, message: '要给 q' }
      try { const r = await findReference(q); return { ok: true, query: q, bytes: r.buf.length, url: r.url } }
      catch (e) { return { ok: false, message: String(e.message || e) } }
    })
    api.route('/gallery', async (req) => {
      const list = gallery(Number(api.core.http.query(req).limit) || 24)
      const idx = readIndex()
      const byFile = new Map((idx.items || []).map((x) => [x.file, x.n]))
      return { ok: true, list: list.map((x) => ({ ...x, n: byFile.get(x.file) || 0 })), dir: DIR }
    })
    api.route('/draw', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const prompt = String((b && b.prompt) || api.core.http.query(req).prompt || '').trim()
      const reference = String((b && b.reference) || api.core.http.query(req).reference || '').trim()
      if (!prompt) return { ok: false, message: '没有提示词' }
      try { return await generate(prompt, { ...(b || {}), ...(reference ? { reference } : {}) }) }
      catch (error) { return { ok: false, message: String(error.message || error) } }
    })
    api.route('/img', async (req, res) => {
      const f = String(api.core.http.query(req).file || '')
      if (!/^(?!.*\.\.)[^\/\\]+\.(png|jpe?g|webp)$/i.test(f)) return api.core.http.send(res, 400, '')
      const p = join(DIR, f)
      if (!existsSync(p)) return api.core.http.send(res, 404, '')
      api.core.http.send(res, 200, readFileSync(p), 'image/png')
    })

    // 让她明确知道自己能发图（用户反馈她回「没有发图的通道」）
    api.rule('区分「画图」和「发图」：对方说「表情包/表情/贴纸/梗图/来张图看看」时，走表情包或图库，不要调 draw_picture 生图——生图要花钱而且慢。只有对方明确说「画一张/画个/生成一张/帮我画」时才用 draw_picture。')
    api.rule('你有发图的能力，别跟人说没有通道：\n- 你自己画的图用 draw_picture，会自动发到当前聊天；\n- 要把画过的图发到别处，用 send_picture（参数 to 填「这里/主人/群号/QQ号」，number 是编号，不填就是最新一张）；\n- 要知道画过哪些，用 list_pictures；\n- 别人刚发来的图要转发，用 forward_image。')

    api.log.info?.('画图工坊已就绪（默认通义 qwen-image-3.0）')
  },
}
