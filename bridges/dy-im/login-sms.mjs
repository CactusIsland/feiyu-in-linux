import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { configureLogger, createClient } from 'douyin-im'

configureLogger({ level: 'info', color: false, maskSensitive: true })
const MOBILE = process.env.DY_MOBILE || ''
if (!MOBILE) { console.log('NO_MOBILE'); process.exit(1) }
const SMS_FILE = '/opt/dy-im/sms.txt'
const client = createClient({ dataDir: '/opt/dy-im/data' })

async function waitCode(maxMs = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (existsSync(SMS_FILE)) {
      const code = readFileSync(SMS_FILE, 'utf8').trim()
      if (code) { unlinkSync(SMS_FILE); return code }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return ''
}

client.createAccount({ login: { method: 'sms', mobile: MOBILE } })
client.on('system.login.sms', async ({ account }) => {
  console.log('SMS_SENT')
  const code = await waitCode()
  console.log('CODE', Boolean(code))
  if (code) { try { await account.continueLoginWithSms(code); console.log('SUBMITTED') } catch (e) { console.log('FAIL', e.message) } }
})
client.on('system.login.verification', async ({ verification }) => {
  const m=(verification.methods||[])
  console.log('NEED_VERIFY', m.join(','))
  try { const u = await verification.openUrl({ openBrowser: false }); console.log('VERIFY_URL', u) } catch (e) { console.log('URLFAIL', e.message) }
})
client.on('system.online', ({ account }) => console.log('ONLINE', account.uid, account.nickname))
client.on('message', async (e) => console.log('MSG', String(e.text || '').slice(0, 50)))
client.on('system.login.error', ({ error }) => console.log('ERROR', error?.message || error))
await client.login()
console.log('DONE')
setInterval(() => {}, 1 << 30)
