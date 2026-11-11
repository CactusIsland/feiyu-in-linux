import { writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { configureLogger, createClient } from 'douyin-im'

configureLogger({ level: 'info', color: false, maskSensitive: true })
const client = createClient({ dataDir: '/opt/dy-im/data' })
const SMS_FILE = '/opt/dy-im/sms.txt'

async function waitCode(maxMs = 300000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (existsSync(SMS_FILE)) {
      const code = (await readFile(SMS_FILE, 'utf8')).trim()
      if (code) { await rm(SMS_FILE, { force: true }); return code }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return ''
}

client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
  await writeFile('/opt/dy-im/login.png', Buffer.from(qrcodeBase64, 'base64'), { mode: 0o600 })
  console.log('QR_SAVED')
  await account.continueLogin()
})
client.on('system.login.sms', async ({ account }) => {
  console.log('NEED_SMS')
  const code = await waitCode()
  console.log('SMS_CODE_RECEIVED', Boolean(code))
  if (code) await account.continueLoginWithSms(code)
})
client.on('system.login.verification', async ({ account, verification }) => {
  console.log('NEED_VERIFY', (verification.methods || []).join(','))
  try {
    const url = await verification.openUrl({ openBrowser: false })
    console.log('VERIFY_URL', url)
  } catch (e) { console.log('VERIFY_OPEN_FAIL', e.message) }
  console.log('WAITING_SMS')
  const code = await waitCode()
  console.log('SMS_CODE_RECEIVED', Boolean(code))
  if (code) {
    try { await account.continueLoginWithSms(code); console.log('SMS_SUBMITTED') } catch (e) { console.log('SMS_FAIL', e.message) }
  }
})
client.on('system.online', ({ account }) => console.log('ONLINE', account.uid, account.nickname))
client.on('message', async (event) => console.log('MSG', String(event.text || '').slice(0, 60)))
client.on('system.login.error', ({ error }) => console.log('LOGIN_ERROR', error?.message || error))

await client.login()
console.log('LOGIN_DONE')
setInterval(() => {}, 1 << 30)
