// 抖音私信桥：只跟白名单里的人生聊；每次发送前强制过隐私过滤器
// 登录用 douyin-im（纯 Node），不碰浏览器。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { configureLogger, createClient } from 'douyin-im'

const DIR = process.env.DY_IM_HOME || '/opt/dy-im'
const CFG = DIR + '/bridge.json'
const SMS = DIR + '/sms.txt'
const LOG = DIR + '/bridge.log'
const LOCAL_DM = process.env.DSH_DM_URL || 'http://127.0.0.1:5043/aurabot/api/ext/douyin/dm'

const cfg = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : {}
const OWNER_DY = String(cfg.ownerNick || process.env.DOUYIN_OWNER_NICK || '')
const ALLOW_UIDS = new Set((cfg.allowUids || []).map(String))

// ---------- 隐私过滤（硬规则） ----------
const RULES = [
  [/(QQ|qq|微信|wechat|群号|私聊记录|聊天记录)/g, '这个'],
  [/\b\d{5,12}\b/g, '***'],                                  // 任何长数字（QQ号/群号）
  [/\b1[3-9]\d{9}\b/g, '***'],                               // 手机号
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***'],
  [/(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+|token|api[_-]?key|密钥|密码)/gi, '***'],
  [/(服务器|后台|部署|面板|插件|模块|数据库|记忆库|日记|记忆|主人|纳普|NapCat|DSH|Aurabot|OneBot|DeepSeek|千问|qwen|token|代理|隧道|IP\s*地址)/g, '这个'],
  [/(\/root|\/var\/|\/opt\/|\.dsh|C:\\\\|D:\\\\|\d+\.\d+\.\d+\.\d+)/g, '***'],
  [/https?:\/\/\S+/g, ''],
]

export function sanitize(text) {
  let out = String(text || '')
  let hit = false
  for (const [re, rep] of RULES) {
    if (re.test(out)) { hit = true; out = out.replace(re, rep) }
    re.lastIndex = 0
  }
  out = out.replace(/\s{2,}/g, ' ').trim()
  if (!out || out.length < 2) return { ok: false, text: '这个话题我不聊啦' }
  return { ok: true, text: out, masked: hit }
}

configureLogger({ level: 'info', color: false, maskSensitive: true })
const client = createClient({ dataDir: DIR + '/data' })

function logLine(s) { try { writeFileSync(LOG, `${new Date().toISOString()} ${s}\n`, { flag: 'a' }) } catch {} }

async function waitCode(maxMs = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (existsSync(SMS)) {
      const c = readFileSync(SMS, 'utf8').trim()
      if (c) { writeFileSync(SMS, ''); return c }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return ''
}

client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
  writeFileSync(DIR + '/login.png', Buffer.from(qrcodeBase64, 'base64'), { mode: 0o600 })
  console.log('QR_SAVED')
  await account.continueLogin()
})
client.on('system.login.sms', async ({ account }) => {
  console.log('NEED_SMS')
  const code = await waitCode()
  console.log('SMS_CODE', Boolean(code))
  if (code) await account.continueLoginWithSms(code)
})
client.on('system.login.verification', async ({ account, verification }) => {
  console.log('NEED_VERIFY', (verification.methods || []).join(','))
  let url = ''
  try { url = await verification.openUrl({ openBrowser: false }); console.log('VERIFY_URL', url) } catch (e) { console.log('URLFAIL', e.message) }
  const code = await waitCode()
  if (code) { try { await account.continueLoginWithSms(code); console.log('SMS_SUBMITTED') } catch (e) { console.log('SMS_FAIL', e.message) } }
})
client.on('system.online', ({ account }) => console.log('ONLINE', account.uid, account.nickname))

client.on('message', async (event) => {
  try {
    const who = String(event.sender?.nickname || event.sender?.remark || event.senderName || '')
    const uid = String(event.sender?.uid || event.senderId || '')
    const text = String(event.text || '').trim()
    if (!text) return
    // 白名单：昵称命中 ownerNick，或 UID 在 allowUids 里；两者都没配就全部跳过（fail-closed）
    const allowed = (OWNER_DY && who.includes(OWNER_DY)) || ALLOW_UIDS.has(uid)
    if (!allowed) { logLine(`skip ${who}`); return }
    logLine(`in ${who}: ${text.slice(0, 40)}`)
    const r = await fetch(LOCAL_DM, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, who }), signal: AbortSignal.timeout(60000),
    })
    const j = await r.json().catch(() => ({}))
    const raw = String(j.reply || '')
    const s = sanitize(raw)
    if (!s.ok) { logLine('blocked empty'); return }
    await event.reply(s.text)
    logLine(`out ${s.masked ? '(masked) ' : ''}${s.text.slice(0, 60)}`)
  } catch (e) { logLine('ERR ' + (e && e.message)) }
})

await client.login()
console.log('LOGIN_DONE')
setInterval(() => {}, 1 << 30)