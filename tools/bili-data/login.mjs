// B站扫码登录：生成二维码 → 轮询 → 保存 Cookie
// 不把登录二维码 URL 发给第三方图片服务；本地生成 PNG。
import { writeFileSync, mkdirSync } from 'node:fs'
import QRCode from 'qrcode'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
const DIR = process.env.BILI_DATA_DIR || '/opt/bili-data'
mkdirSync(DIR, { recursive: true })

const gen = await (await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
  headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
})).json()

if (gen.code !== 0) {
  console.log('GEN_FAIL', JSON.stringify(gen).slice(0, 200))
  process.exit(1)
}
const key = gen.data.qrcode_key
const url = gen.data.url
console.log('QR_URL', url)

const png = await QRCode.toBuffer(url, { width: 420, margin: 2 })
writeFileSync(DIR + '/login.png', png, { mode: 0o600 })
console.log('QR_SAVED', DIR + '/login.png')

for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + key, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
  })
  const j = await r.json()
  const code = j.data?.code
  if (code === 0) {
    const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
    writeFileSync(DIR + '/cookies.txt', cookies, { mode: 0o600 })
    console.log('LOGIN_OK', cookies.length, 'chars')
    console.log('COOKIE_KEYS', cookies.split('; ').map((x) => x.split('=')[0]).join(','))
    process.exit(0)
  }
  if (code === 86038) { console.log('EXPIRED'); process.exit(2) }
  if (code === 86090) { if (i % 5 === 0) console.log('SCANNED_WAIT_CONFIRM') }
  if (code === 86101) { if (i % 10 === 0) console.log('WAIT_SCAN') }
}
console.log('TIMEOUT')
