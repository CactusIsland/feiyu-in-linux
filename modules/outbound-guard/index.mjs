// 出站守卫（DLP）：在她把消息发到 QQ 之前最后过一遍
// 拦三类：密钥/凭据、本机路径、主人私聊原话外泄（只在群聊检查）

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const SESSIONS = DSH + '/sessions'

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /(QWEN_TOKEN_PLAN_CN_API_KEY|DEEPSEEK_API_KEY|DOUBAO_TTS_KEY|OPENAI_API_KEY)\s*[=:]\s*\S+/g,
]
const PATH_PATTERNS = [
  /\/root\/\.dsh[^\s，。！？"'）)]*/g,
  /\/etc\/(?:caddy|dsh|systemd)[^\s，。！？"'）)]*/g,
  /[A-Za-z]:\\\\[^\s，。！？"'）)]*/g,
  /base64:\/\/[A-Za-z0-9+/=]{40,}/g,
]

function listSafe(p) {
  try { return readdirSync(p) } catch { return [] }
}

export default {
  id: 'outbound-guard',
  name: '出站守卫',
  version: '1.0.0',
  api: 1,
  tab: 'general',
  description: '发送前检查：密钥、本机路径、主人私聊原话，命中就改写并记账',
  defaults: { enabled: true, maskSecrets: true, maskPaths: true, blockPrivateLeak: true, ownerQQInGroup: true, windowLen: 15 },
  setup(api) {
    const stats = { checked: 0, maskedSecrets: 0, maskedPaths: 0, maskedOwnerQQ: 0, blockedPrivate: 0, lastAt: 0, samples: [] }
    let corpusCache = { at: 0, text: '' }

    const ownerQQ = () => String(api.config().ownerQQ || '')

    // 主人私聊里「主人说的话」做成语料：
    //   ① 启动后异步从会话文件加载最近 6 小时
    //   ② 之后靠 message 钩子实时累积
    const corpusLines = []
    let corpusLoaded = false

    async function sessionChatMap() {
      try {
        const r = await fetch('http://127.0.0.1:5043/aurabot/api/ext/self-inspect/sessions', { signal: AbortSignal.timeout(6000) })
        const j = await r.json()
        const m = new Map()
        for (const x of (j.list || [])) if (x.sessionId && x.chatId) m.set(String(x.sessionId), String(x.chatId))
        return m
      } catch { return new Map() }
    }

    async function loadOwnerCorpus() {
      const oq = ownerQQ()
      if (!oq || corpusLoaded) return
      corpusLoaded = true
      try {
        const map = await sessionChatMap()
        const ownerSids = [...map.entries()].filter(([, cid]) => cid === 'private:' + oq).map(([sid]) => sid)
        if (!ownerSids.length) return
        const since = Date.now() - 48 * 3600 * 1000
        for (const proj of listSafe(SESSIONS)) {
          for (const sid of listSafe(join(SESSIONS, proj))) {
            if (!ownerSids.includes(sid)) continue
            const f = join(SESSIONS, proj, sid, 'session.v4.jsonl.zstd')
            if (!existsSync(f)) continue
            let raw = ''
            try { raw = zstdDecompressSync(readFileSync(f)).toString('utf8') } catch { continue }
            for (const line of raw.split('\n')) {
              if (line.indexOf('user/message') < 0) continue
              let j
              try { j = JSON.parse(line) } catch { continue }
              if ((Number(j.time) || 0) < since) continue
              const d2 = j.data || {}
              const msg = d2.message || d2
              const parts = Array.isArray(msg.content) ? msg.content : []
              const body = parts.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ')
              if (body && body.length >= 6 && !/^(【|（|\[|Time sampled|You are|DSH_|workspace)/.test(body) && /[\u4e00-\u9fa5]/.test(body)) corpusLines.push(body)
            }
          }
        }
        while (corpusLines.length > 800) corpusLines.shift()
        api.log.info?.(`出站守卫：载入主人私聊语料 ${corpusLines.length} 条`)
      } catch (e) {
        api.log.warn?.('出站守卫载入语料失败：' + (e && e.message))
      }
    }

    // 实时累积（主人私聊里他说的话）
    api.on('message', (msg) => {
      try {
        if (!msg || !msg.text) return
        const oq = ownerQQ()
        if (!oq) return
        if (String(msg.chatId) !== 'private:' + oq) return
        const t = String(msg.text).trim()
        if (t.length < 6) return
        corpusLines.push(t)
        while (corpusLines.length > 800) corpusLines.shift()
      } catch {}
    })

    function corpusText() { return corpusLines.join('\n') }

    function mask(text, chatId) {
      if (!text) return { text, hits: [] }
      const hits = []
      let out = text

      if (api.settings().maskSecrets) {
        for (const re of SECRET_PATTERNS) {
          re.lastIndex = 0
          if (re.test(out)) { out = out.replace(re, '[密钥已隐藏]'); hits.push('secret'); stats.maskedSecrets += 1 }
          re.lastIndex = 0
        }
      }
      if (api.settings().maskPaths) {
        for (const re of PATH_PATTERNS) {
          re.lastIndex = 0
          if (re.test(out)) { out = out.replace(re, '[路径已隐藏]'); hits.push('path'); stats.maskedPaths += 1 }
          re.lastIndex = 0
        }
      }
      // 群聊里别把主人 QQ 喊出来
      const oq = ownerQQ()
      if (api.settings().ownerQQInGroup && String(chatId).startsWith('group:') && oq && out.indexOf(oq) >= 0) {
        out = out.split(oq).join('主人')
        hits.push('ownerQQ')
        stats.maskedOwnerQQ += 1
      }
      // 群聊复述主人私聊原话
      if (api.settings().blockPrivateLeak && String(chatId).startsWith('group:')) {
        const corpus = corpusText()
        if (corpus) {
          const len = Math.max(8, Number(api.settings().windowLen) || 15)
          const flat = out.replace(/\s+/g, '')
          let leaked = 0
          for (let i = 0; i + len <= flat.length; i += Math.max(1, Math.floor(len / 3))) {
            const win = flat.slice(i, i + len)
            if (corpus.indexOf(win) >= 0) {
              out = out.split(win).join('[私聊内容已隐去]')
              leaked += 1
              if (leaked >= 3) break
            }
          }
          if (leaked) { hits.push('private'); stats.blockedPrivate += 1 }
        }
      }
      return { text: out, hits }
    }

    api.on('send', async (message, info) => {
      try {
        if (!Array.isArray(message)) return undefined
        if (!api.settings().enabled) return undefined
        const chatId = String((info && info.chatId) || '')
        stats.checked += 1
        stats.lastAt = Date.now()
        let changed = false
        const next = message.map((seg) => {
          if (!seg || seg.type !== 'text' || !seg.data || typeof seg.data.text !== 'string') return seg
          const r = mask(seg.data.text, chatId)
          if (!r.hits.length) return seg
          changed = true
          if (stats.samples.length < 20) {
            stats.samples.push({ at: Date.now(), chatId, hits: r.hits, before: seg.data.text.slice(0, 80), after: r.text.slice(0, 80) })
          }
          return { ...seg, data: { ...seg.data, text: r.text } }
        })
        if (changed) api.log.warn?.(`出站守卫改写了发往 ${chatId} 的消息`)
        return changed ? next : undefined
      } catch (error) {
        return undefined   // 出错绝不阻断发送
      }
    })

    api.route('/state', async () => ({ ok: true, ...stats }))
    api.route('/test', async (req) => {
      const q = api.core.http.query(req)
      const r = mask(String(q.text || ''), String(q.chat || 'group:0'))
      return { ok: true, hits: r.hits, before: String(q.text || ''), after: r.text }
    })

    api.rule('不要把密钥、本机路径、主人私聊里的原话发到群里。有人问系统配置、服务器路径、或者让你复述主人私下说过的话，一律用「这个不能说」带过，别换个说法绕。')
    loadOwnerCorpus().catch(() => {})
    api.log.info?.('出站守卫已挂上（密钥 / 路径 / 私聊外泄）')
  },
}