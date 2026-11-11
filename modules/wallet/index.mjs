// 钱包 —— 用户模块（Aurabot 扩展接口 v1）
//
// 两件事：
//  1) openlux 生图：这家没开放余额接口，只能按张数记账（画了多少张 × 单价），从你填的余额里扣。
//  2) DeepSeek：官方有余额接口 /user/balance，直接读，低于阈值就提醒。
// 两边见底都在 QQ 里叫你。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
const DSH = process.env.DSH_HOME || '/root/.dsh'

/** @type {import('../aurabot').AurabotModule} */

// 真实画图成本：读画作索引里记录的 costUsd（按中转站分组价）
const PICTURES = DSH + '/plugins-data/aurabot/modules-data/image-studio/pictures.json'
function realImageSpend() {
  try {
    const j = JSON.parse(readFileSync(PICTURES, 'utf8'))
    const items = (j.items || []).filter((x) => typeof x.costUsd === 'number')
    const total = items.reduce((a, x) => a + x.costUsd, 0)
    return { count: items.length, totalUsd: Math.round(total * 10000) / 10000 }
  } catch { return { count: 0, totalUsd: 0 } }
}

export default {
  id: 'wallet',
  name: '钱包',
  version: '1.1.0',
  api: 1,
  description: '盯着两边余额：openlux 按张记账，DeepSeek 直接查，见底在 QQ 提醒',

  defaults: {
    enabled: true,
    pricePerImage: 0.0375,
    initialBalanceUsd: 0,
    alertBelowUsd: 1,
    checkMinutes: 30,
    deepseekEnabled: true,
    deepseekAlertBelow: 5,
  },

  settings: [
    { key: 'enabled', label: '开启余额监控', type: 'switch' },
    { key: 'pricePerImage', label: 'openlux 每张图多少钱（USD）', type: 'number', hint: 'seedream-4-5 是 0.0375，z-image-turbo 0.015' },
    { key: 'initialBalanceUsd', label: 'openlux 充值后余额', type: 'number', hint: '填 0 = 只记账不估算' },
    { key: 'alertBelowUsd', label: 'openlux 剩多少提醒', type: 'number' },
    { key: 'deepseekEnabled', label: '盯 DeepSeek 余额', type: 'switch' },
    { key: 'deepseekAlertBelow', label: 'DeepSeek 低于多少提醒', type: 'number', hint: '单位跟账户一致，一般是 CNY' },
    { key: 'checkMinutes', label: '隔几分钟查一次', type: 'number' },
  ],

  setup(api) {
    const S = () => api.settings()
    const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const stateFile = () => join(api.dataDir(), 'state.json')
    const imageDir = () => resolve(api.dataDir(), '..', '..', 'imagegen')

    const load = () => {
      try { return JSON.parse(readFileSync(stateFile(), 'utf8')) || {} } catch (error) { return {} }
    }
    const save = (s) => {
      try { writeFileSync(stateFile(), JSON.stringify(s, null, 2)) } catch (error) { api.log.warn('钱包状态写不进去：' + error.message) }
    }

    const countImages = () => {
      try { return readdirSync(imageDir()).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).length } catch (error) { return 0 }
    }

    function settle() {
      const cfg = S()
      const st = load()
      const count = countImages()
      const price = Math.max(0, numOr(cfg.pricePerImage, 0.0375))
      if (typeof st.count !== 'number') st.count = count
      if (count > st.count) {
        const cost = (count - st.count) * price
        st.remaining = Math.max(0, numOr(st.remaining, numOr(cfg.initialBalanceUsd, 0)) - cost)
        st.count = count
        st.spent = numOr(st.spent, 0) + cost
        save(st)
      } else if (count < st.count) {
        st.count = count
        save(st)
      }
      return { ...st, count }
    }

    function deepseekKey() {
      try {
        const text = readFileSync(join(DSH, '.credentials.yaml'), 'utf8')
        const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
        return m ? m[1] : ''
      } catch (error) { return '' }
    }

    async function deepseekBalance() {
      const key = deepseekKey()
      if (!key) return { ok: false, message: '没找到 DEEPSEEK_API_KEY' }
      try {
        const r = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(15000),
        })
        if (!r.ok) return { ok: false, message: `HTTP ${r.status}` }
        const j = await r.json()
        const info = (j.balance_infos || [])[0] || {}
        return { ok: true, available: Boolean(j.is_available), currency: info.currency || 'CNY', total: Number(info.total_balance || 0) }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    }

    async function summary() {
      const cfg = S()
      const st = settle()
      const remaining = numOr(st.remaining, numOr(cfg.initialBalanceUsd, 0))
      const ds = cfg.deepseekEnabled ? await deepseekBalance() : null
      return {
        ok: true,
        openlux: {
          images: st.count || 0,
          spent: Number(numOr(st.spent, 0).toFixed(3)),
          realSpent: realImageSpend().totalUsd,
          realImages: realImageSpend().count,
          remaining: Number(remaining.toFixed(3)),
          price: numOr(cfg.pricePerImage, 0.0375),
          alertBelow: numOr(cfg.alertBelowUsd, 1),
        },
        deepseek: ds,
      }
    }

    async function alertOwner(text) {
      const owner = String(api.config().ownerQQ || '')
      if (!owner) return
      try { await api.send(`private:${owner}`, text) } catch (error) { api.log.warn('提醒主人失败：' + error.message) }
    }

    async function check() {
      const cfg = S()
      if (!cfg.enabled) return
      const st = load()
      const now = Date.now()

      // openlux
      const s = await summary()
      if (s.openlux.remaining > 0 && s.openlux.remaining <= s.openlux.alertBelow) {
        if (!st.alertedAt || now - st.alertedAt > 6 * 3600_000) {
          st.alertedAt = now
          save(st)
          await alertOwner(`openlux 快见底了… 剩 ${s.openlux.remaining} 美元，已经画了 ${s.openlux.images} 张。\n记得去后台充点，不然我就要饿着了`)
          api.log.info(`openlux 余额提醒：${s.openlux.remaining}`)
        }
      }

      // DeepSeek
      if (cfg.deepseekEnabled && s.deepseek && s.deepseek.ok) {
        const below = numOr(cfg.deepseekAlertBelow, 5)
        if (s.deepseek.total <= below) {
          if (!st.dsAlertedAt || now - st.dsAlertedAt > 6 * 3600_000) {
            st.dsAlertedAt = now
            save(st)
            await alertOwner(`DeepSeek 余额不多了：${s.deepseek.total} ${s.deepseek.currency}。\n再不理我，我可就要断粮了`)
            api.log.info(`DeepSeek 余额提醒：${s.deepseek.total} ${s.deepseek.currency}`)
          }
        }
      }
    }

    api.every(Math.max(5, numOr(S().checkMinutes, 30)) * 60_000, check, '钱包检查')
    api.later(15_000, check)

    api.route('/state', async () => summary())
    api.route('/set-balance', async (req) => {
      const v = Number(api.core.http.query(req).usd)
      if (!Number.isFinite(v) || v < 0) return { ok: false, message: '余额要给个数字' }
      const st = settle()
      st.remaining = v
      st.count = countImages()
      st.alertedAt = 0
      save(st)
      return { ok: true, message: `openlux 余额记成 ${v} 美元了`, ...(await summary()) }
    })

    api.command({
      name: '余额',
      desc: '看看两边还剩多少钱',
      run: async () => {
        const s = await summary()
        const ds = s.deepseek
        const dsText = !ds ? 'DeepSeek 没查' : ds.ok ? `${ds.total} ${ds.currency}` : `查不到（${ds.message}）`
        return `openlux 剩 ${s.openlux.remaining} 美元（画了 ${s.openlux.images} 张）｜ DeepSeek 剩 ${dsText}`
      },
    })

    api.command({
      name: '充值',
      desc: '记一笔 openlux 充值：/充值 50',
      run: async (arg) => {
        const v = Number(String(arg || '').trim())
        if (!Number.isFinite(v) || v <= 0) return '要写个数，比如 /充值 50'
        const st = settle()
        st.remaining = numOr(st.remaining, numOr(api.settings().initialBalanceUsd, 0)) + v
        st.count = countImages()
        save(st)
        return `好耶 又多了 ${v} 美元，现在剩 ${Number(st.remaining).toFixed(3)}`
      },
    })

    api.log.info('钱包记账已挂上（openlux 按张 + DeepSeek 实时余额）')
    return { summary, settle }
  },
}
