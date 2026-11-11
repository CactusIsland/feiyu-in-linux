// 豆包语音合成 2.0（Vivi）。
// 关键发现：该接口的 post_process.pitch / voice_modify.pitch 都不生效（实测），
// 所以网页端「音调」的听感用本地 ffmpeg 变调复刻（保持时长不变）。

import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const SPEAKER = 'zh_female_vv_uranus_bigtts'
const DEFAULT_TIMBRE = '用标准普通话，清亮甜软的十六七岁少女音，带一点奶气，声音纤巧但有圆润内核，明亮不刺耳。日常语速适中；反驳时字头利落、短句有气鼓鼓的弹性；说到自己的小心思时节奏放慢，语尾轻轻上扬，带一点懵懂和偷偷讨好的笑意。嘴上逞强，句尾要软，亲近、憨憨的，不要老练，不要播音腔。'
const FREE_QUOTA = 20000
const MAX_CHARS = 200
const SR = 24000

export default {
  id: 'tts-doubao',
  name: '豆包语音',
  version: '1.3.0',
  api: 1,
  tab: 'voice',
  description: '豆包语音合成 2.0（Vivi），语速/音量走 API，音调用本地 ffmpeg 变调复刻网页端听感。带缓存与配额统计。',
  defaults: { enabled: true, speechRate: 0, loudnessRate: 0, semitones: 5 },
  settings: [
    { key: 'enabled', label: '启用豆包语音', type: 'boolean' },
    { key: 'speechRate', label: '语速（API）', type: 'number', min: -50, max: 100 },
    { key: 'loudnessRate', label: '音量（API）', type: 'number', min: -50, max: 100 },
    { key: 'semitones', label: '音调变调（半音）', type: 'number', min: -12, max: 12, hint: '网页端音调 5 约等于 +5 半音；0 = 不变调' },
  ],
  setup(api) {
    const key = () => process.env.DOUBAO_TTS_KEY || ''
    const stats = { count: 0, chars: 0, billedChars: 0, cacheHits: 0, shifted: 0, fail: 0, lastMs: 0, lastError: '' }
    const dir = () => { const d = api.dataDir('voice'); mkdirSync(d, { recursive: true }); return d }
    const quotaFile = () => join(api.dataDir(), 'quota.json')
    const timbre = () => String(((api.config().ext || {})['tts-doubao'] || {}).voiceInstruction || DEFAULT_TIMBRE)

    const loadQuota = () => { try { return JSON.parse(readFileSync(quotaFile(), 'utf8')) } catch { return { billedChars: 0 } } }
    const addQuota = (n) => { const q = loadQuota(); q.billedChars = (q.billedChars || 0) + n; writeFileSync(quotaFile(), JSON.stringify(q)); stats.billedChars = q.billedChars; return q.billedChars }

    function params() {
      const s = api.settings()
      return {
        speaker: SPEAKER, format: 'mp3', sample_rate: SR, bit_rate: 64000,
        speech_rate: Number(s.speechRate ?? 0), loudness_rate: Number(s.loudnessRate ?? 0),
        semitones: Number(s.semitones ?? 5),
      }
    }

    // 本地变调：asetrate 抬基频，atempo 拉回时长
    function shift(srcBuf, semitones) {
      if (!semitones) return srcBuf
      const d = dir()
      const a = join(d, `tmp-in-${process.pid}.mp3`)
      const b = join(d, `tmp-out-${process.pid}.mp3`)
      writeFileSync(a, srcBuf)
      const r = Math.pow(2, semitones / 12)
      const r2 = Math.round(r * 10000) / 10000
      const t2 = Math.round((1 / r) * 10000) / 10000
      const p = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-ar', String(SR),
        '-af', `asetrate=${SR}*${r2},aresample=${SR},atempo=${t2}`, '-b:a', '64k', b], { timeout: 20000 })
      let out = srcBuf
      if (p.status === 0 && existsSync(b)) { out = readFileSync(b); stats.shifted += 1 }
      try { unlinkSync(a) } catch {}
      try { unlinkSync(b) } catch {}
      return out
    }

    async function synth(text, ov = {}) {
      const k = key()
      if (!k) throw new Error('没配 DOUBAO_TTS_KEY')
      const p = params()
      const semi = (ov.semitones === undefined ? p.semitones : Number(ov.semitones))
      const clean = String(text).slice(0, MAX_CHARS)
      const fp = JSON.stringify([p.speaker, p.speech_rate, p.loudness_rate, semi, timbre(), clean])
      const h = createHash('sha256').update(fp).digest('hex').slice(0, 24)
      const file = join(dir(), h + '.mp3')
      if (existsSync(file)) { stats.cacheHits += 1; stats.count += 1; return { file, bytes: readFileSync(file).length, cached: true, ms: 0 } }

      const body = {
        req_params: {
          text: clean, speaker: p.speaker,
          audio_params: { format: p.format, sample_rate: p.sample_rate, bit_rate: p.bit_rate, speech_rate: p.speech_rate, loudness_rate: p.loudness_rate, enable_subtitle: false },
          context_texts: [timbre()],
        },
      }
      const t0 = Date.now()
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'X-Api-Key': k, 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': crypto.randomUUID(), 'X-Control-Require-Usage-Tokens-Return': '*', 'content-type': 'application/json', connection: 'keep-alive' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 160)}`)
      const chunks = []
      let billed = 0, buf = ''
      const walk = (s) => {
        for (const line of s.split('\n')) {
          const t = line.trim(); if (!t) continue
          let j; try { j = JSON.parse(t) } catch { continue }
          if (j.code !== undefined && j.code !== 0 && j.code !== 20000000) throw new Error(`TTS ${j.code}: ${String(j.message || '').slice(0, 120)}`)
          if (typeof j.data === 'string' && j.data) chunks.push(Buffer.from(j.data, 'base64'))
          for (const key2 of ['usage', 'usage_tokens', 'total_usage', 'billing']) {
            if (j[key2] && typeof j[key2] === 'object') { const n = Number(j[key2].text_tokens || j[key2].tokens || j[key2].characters || 0); if (n > 0) billed = Math.max(billed, n) }
          }
        }
      }
      for await (const part of res.body) { buf += Buffer.from(part).toString('utf8'); const i = buf.lastIndexOf('\n'); if (i >= 0) { walk(buf.slice(0, i)); buf = buf.slice(i + 1) } }
      walk(buf + '\n')
      if (!chunks.length) throw new Error('没取到音频数据')

      const audio = shift(Buffer.concat(chunks), semi)
      writeFileSync(file, audio)
      stats.count += 1; stats.chars += clean.length; stats.lastMs = Date.now() - t0
      addQuota(billed > 0 ? billed : clean.length)
      return { file, bytes: audio.length, cached: false, ms: stats.lastMs }
    }

    async function say(chatId, text) {
      if (api.settings().enabled === false) throw new Error('豆包语音没开')
      const r = await synth(text)
      await api.sendVoiceFile(chatId, r.file, '[豆包语音]')
      return r
    }

    api.command({
      name: '语音', desc: '/语音 你好呀 —— 用豆包 Vivi 念（200 字内）',
      run: async (arg, msg) => {
        if (!arg) return '用法：/语音 要念的话（200 字以内）'
        try { const r = await say(msg.chatId, arg); return `${r.cached ? '用了缓存' : '念好了'}（${Math.round(r.bytes / 1024)}KB${r.cached ? '' : '，' + r.ms + 'ms'}）` }
        catch (e) { stats.fail += 1; stats.lastError = String(e.message || e); return '念失败了：' + stats.lastError }
      },
    })

    api.route('/state', async () => {
      const q = loadQuota()
      return { ok: true, hasKey: Boolean(key()), speaker: SPEAKER, params: params(), instruction: timbre(), ...stats, billedChars: q.billedChars || 0, freeQuota: FREE_QUOTA, remaining: Math.max(0, FREE_QUOTA - (q.billedChars || 0)) }
    })
    api.route('/test', async (req) => {
      const q = api.core.http.query(req)
      const text = String(q.text || '你好，我是大肥鱼')
      const semi = (q.semitones !== undefined && q.semitones !== '') ? Number(q.semitones) : undefined
      try {
        const r = await synth(text, semi === undefined ? {} : { semitones: semi })
        return { ok: true, ...r, semitones: semi === undefined ? api.settings().semitones : semi }
      } catch (e) { stats.fail += 1; stats.lastError = String(e.message || e); return { ok: false, message: stats.lastError } }
    })
    // 给内置「语音」模块用：GET /tts?text=... 直接回 mp3 字节
    api.route('/tts', async (req, res) => {
      const text = String(api.core.http.query(req).text || '').trim()
      if (!text) { try { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('no text') } catch {} ; return }
      try {
        const r = await synth(text)
        const buf = readFileSync(r.file)
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'no-store' })
        res.end(buf)
      } catch (e) {
        stats.fail += 1; stats.lastError = String(e.message || e)
        try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(stats.lastError) } catch {}
      }
    })

    api.route('/send', async (req) => {
      const q = api.core.http.query(req)
      const chat = String(q.chat || ('private:' + api.config().ownerQQ))
      const b = await api.core.http.body(req).catch(() => ({}))
      const text = String((b && b.text) || q.text || '')
      if (!text) return { ok: false, message: '没给文字' }
      try { return { ok: true, ...(await say(chat, text)) } }
      catch (e) { stats.fail += 1; stats.lastError = String(e.message || e); return { ok: false, message: stats.lastError } }
    })
    api.log.info?.(key() ? `豆包语音 v1.3 已挂上（变调 ${api.settings().semitones ?? 5} 半音）` : '豆包语音已挂上，但缺 DOUBAO_TTS_KEY')
  },
}
