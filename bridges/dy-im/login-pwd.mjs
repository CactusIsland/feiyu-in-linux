import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { configureLogger, createClient } from 'douyin-im'

configureLogger({ level: 'info', color: false, maskSensitive: true })
const PWD_FILE = '/opt/dy-im/.pwd'
const MOBILE = process.env.DY_MOBILE || ''
const password = existsSync(PWD_FILE) ? readFileSync(PWD_FILE, 'utf8').trim() : ''
try { unlinkSync(PWD_FILE) } catch {}
if (!MOBILE || !password) { console.log('NO_CRED'); process.exit(1) }

const client = createClient({ dataDir: '/opt/dy-im/data' })
client.createAccount({ login: { method: 'password', mobile: MOBILE, password } })

client.on('system.login.sms-required', async ({ account }) => {
  console.log('SMS_REQUIRED')
  try { await account.requestLoginSmsCode(); console.log('SMS_REQUESTED') } catch (e) { console.log('SMS_REQ_FAIL', e.message) }
})
client.on('system.login.sms', async ({ account }) => {
  console.log('SMS_INPUT_NEEDED')
})
client.on('system.login.accounts', async ({ account, accounts }) => {
  console.log('MULTI_ACCOUNT', JSON.stringify(accounts).slice(0, 200))
})
client.on('system.login.verification', async ({ verification }) => {
  console.log('NEED_VERIFY', (verification.methods||[]).join(','))
  try { const u = await verification.openUrl({ openBrowser: false }); console.log('VERIFY_URL', u) } catch (e) { console.log('URLFAIL', e.message) }
})
client.on('system.online', ({ account }) => console.log('ONLINE', account.uid, account.nickname))
client.on('message', async (e) => console.log('MSG', String(e.text || '').slice(0, 50)))
client.on('system.login.error', ({ error }) => console.log('ERROR', error?.message || error))
await client.login()
console.log('DONE')
setInterval(() => {}, 1 << 30)
