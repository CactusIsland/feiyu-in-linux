// 记忆压缩带 —— 用户模块（Aurabot 扩展接口 v1）
//
// 像人一样记事情，也像人一样忘：
//  1) 模糊：旧记忆每隔几小时被合并压缩一次（长度 × ratio，不设代数上限，可以一直压）。
//  2) 淡化：越久没被想起、越不重要，重要度自己往下掉（想起来一次会回一点）。
//  3) 遗忘：按遗忘曲线 R = e^(-Δ天 / τ) 算「还记得多牢」，τ 随重要度和被想起来的次数变长；
//     R 掉到 forgetBelow 以下就真的忘掉（原文留在 removed.jsonl 里）。
//  4) 到顶：记忆条数一到 countCap（默认 100）就强制压到 countTarget（默认 50）。
//
// 手动加的（面板/导入）默认不参与遗忘，避免把你写的设定忘掉。

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const HOUR = 3600_000
const DAY = 86400_000

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-compact',
  name: '记忆压缩带',
  version: '3.0.0',
  api: 1,
  description: '记忆像人一样：几小时压一次、慢慢淡化、按遗忘曲线真忘；满 100 条压到 50',

  defaults: {
    enabled: true,
    // 压缩
    intervalHours: 4,
    minAgeHours: 6,
    ratio: 0.75,
    batch: 6,
    minChars: 30,
    maxGen: 0, // 0 = 不限代数
    countCap: 100,
    countTarget: 50,
    sources: 'auto,tool',
    maxGroupsPerRun: 2,
    // 遗忘
    forgetEnabled: true,
    halfLifeDays: 21, // 普通记忆的「半衰期」基准（天）
    blurBelow: 0.25, // R 低于这个开始掉重要度（越来越模糊）
    forgetBelow: 0.06, // R 低于这个就真忘
    forgetGraceHours: 12, // 刚记下的这几个小时不动
    protectSources: 'panel,import', // 这些来源不参与遗忘
    maxFadePerRun: 40,
    maxForgetPerRun: 20,
    dryRun: false,
  },

  settings: [
    { key: 'enabled', label: '开启自动压缩/遗忘', type: 'switch' },
    { key: 'intervalHours', label: '每隔几小时跑一遍', type: 'number' },
    { key: 'minAgeHours', label: '记忆至少放几小时才参与压缩', type: 'number' },
    { key: 'ratio', label: '每次压到原长度的比例', type: 'number', hint: '0.75 = 40% 压到 30%；0.6 更狠' },
    { key: 'batch', label: '一次最多合并几条', type: 'number' },
    { key: 'minChars', label: '短于多少字的不压', type: 'number' },
    { key: 'maxGen', label: '最多压几代（0 = 不限）', type: 'number' },
    { key: 'countCap', label: '记忆条数到这个数就强制压', type: 'number' },
    { key: 'countTarget', label: '强制压到剩多少条', type: 'number' },
    { key: 'sources', label: '压哪些来源（逗号分隔）', type: 'text', hint: 'auto=每天整理出来的，tool=她自己记的' },
    { key: 'maxGroupsPerRun', label: '每轮最多压几组', type: 'number' },
    { key: 'forgetEnabled', label: '会忘事', type: 'switch' },
    { key: 'halfLifeDays', label: '遗忘半衰期（天）', type: 'number', hint: '越小忘得越快；普通记忆默认 21 天' },
    { key: 'blurBelow', label: '模糊阈值', type: 'number', hint: '记得多牢低于这个值就开始掉重要度' },
    { key: 'forgetBelow', label: '遗忘阈值', type: 'number' },
    { key: 'forgetGraceHours', label: '刚记下几小时内不淡忘', type: 'number' },
    { key: 'protectSources', label: '不参与遗忘的来源', type: 'text', hint: '手动加的 panel/import 默认保留' },
    { key: 'maxForgetPerRun', label: '每轮最多忘几条', type: 'number' },
    { key: 'dryRun', label: '只演练不真改', type: 'switch' },
  ],

  setup(api) {
    const S = () => api.settings()
    const dataFile = (name) => join(api.dataDir(), name)
    const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

    const readState = () => {
      try { return JSON.parse(readFileSync(dataFile('state.json'), 'utf8')) || {} } catch (error) { return {} }
    }
    const saveState = (s) => {
      try { writeFileSync(dataFile('state.json'), JSON.stringify(s, null, 2)) } catch (error) { api.log.warn('写压缩进度失败：' + error.message) }
    }

    const memory = () => (typeof api.use === 'function' ? api.use('memory') : null)
    // 记忆图谱判定的「永不遗忘」：不参与压缩、淡化、真正遗忘
    const mapProtected = (id) => {
      {
      const mm = api.use('memory-map')
      if (!mm || typeof mm.isProtected !== 'function') return true   // 模块没开/没注册 → 全保护
      try { return Boolean(mm.isProtected(id)) } catch (error) { return true }
    }
    }
    // 压掉/忘掉之前先冷存一份；就算后面反悔，也能从冷记忆库翻回来
    const coldArchive = (m, reason) => {
      try { api.use('memory-cold')?.archiveMemory?.(m, reason) } catch (error) {}
    }
    const liveItems = () => {
      const m = memory()
      if (!m || typeof m.list !== 'function') return null
      return m.list('').filter((x) => !x.invalidAt)
    }
    const genOf = (m) => {
      const hit = (m.tags || []).map((t) => String(t)).find((t) => /^gen:\d+$/.test(t))
      return hit ? Number(hit.split(':')[1]) : 0
    }

    let busy = false

    /** 像人一样「还记得多牢」：0~1。被想起过的、重要的，衰减得慢。 */
    function retention(m, now) {
      const last = Math.max(Number(m.at) || 0, Number(m.lastHit) || 0)
      const days = Math.max(0, (now - last) / DAY)
      const halfLife = Math.max(0.2, numOr(S().halfLifeDays, 21))
      const strength = 1 + Math.min(10, Number(m.hitDays) || 0) // 被想起来的次数越多，记得越牢
      const importance = Math.max(0.05, Math.min(1, Number(m.importance) || 0.5))
      const tau = halfLife * strength * (0.5 + importance)
      return Math.exp(-days / tau)
    }

    /** 把一组记忆合并成一条。返回 true = 真压掉了一组。 */
    async function mergeGroup(rows, cfg) {
      rows = rows.filter((m) => !mapProtected(m.id))
      if (rows.length < 2) return false
      const total = rows.reduce((n, m) => n + String(m.text || '').length, 0)
      const ratio = Math.max(0.4, Math.min(0.95, numOr(cfg.ratio, 0.75)))
      const target = Math.max(30, Math.min(200, Math.round(total * ratio)))
      const text = rows.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
      const who = rows[0].aboutName ? `这些事都是关于「${rows[0].aboutName}」的，` : ''
      const system = `你在替一个叫「大肥鱼」的角色压缩记忆。${who}把下面几条记忆合并成一段，不超过 ${target} 个字。只保留事实、约定、关系、明确的喜好和经历；丢掉细节、语气、重复和当时的情绪。主语必须保持原文里的人名，绝对不要替换成「大肥鱼」，也不要把自己写进去。不要编造，不要加评论，不要用列表。直接输出合并后的那一段。`

      let out = ''
      try {
        out = await api.ask({ system, text, maxTokens: 1200 })
        if (!String(out || '').trim()) out = await api.ask({ system, text, maxTokens: 2000 })
      } catch (error) {
        api.log.warn('压缩记忆时模型报错：' + error.message)
        return false
      }

      const merged = String(out || '')
        .replace(/^["'“”『』]+|["'“”『』]+$/g, '')
        .replace(/\s*\n+\s*/g, ' ')
        .trim()
        .slice(0, 200)
      if (merged.length < 10) {
        api.log.warn(`模型压缩结果太短，跳过（${String(out || '').length} 字）`)
        return false
      }
      if (cfg.dryRun) {
        api.log.info(`[演练] ${rows.length} 条会压成 ${merged.length} 字：${merged.slice(0, 50)}…`)
        return false
      }

      try {
        for (const m of rows) appendFileSync(dataFile('removed.jsonl'), JSON.stringify({ kind: 'merge', at: Date.now(), id: m.id, text: m.text, about: m.about || '', source: m.source, gen: genOf(m) }) + '\n')
      } catch (error) {}

      const gen = Math.max(...rows.map(genOf))
      const importance = Math.max(...rows.map((m) => Number(m.importance) || 0.5))
      const added = memory().add({
        text: merged,
        about: rows[0].about || '',
        aboutName: rows[0].aboutName || '',
        importance,
        source: 'auto',
        tags: ['压缩', `gen:${gen + 1}`],
      })
      const newId = added && (added.id || added.updated)
      let removed = 0
      for (const m of rows) {
        if (newId && m.id === newId) continue
        coldArchive(m, 'merge')
        memory().remove(m.id)
        removed++
      }
      api.log.info(`压掉一组（${rows.length} 条 → 1 条，${total} → ${merged.length} 字，第 ${gen + 1} 代）`)
      return removed > 0
    }

    /** 数量到顶：不管时间，按「不重要 + 老」优先，一路压到 countTarget。 */
    async function shrinkToTarget(cfg) {
      const cap = Math.max(2, numOr(cfg.countCap, 100))
      const target = Math.max(1, Math.min(cap - 1, numOr(cfg.countTarget, 50)))
      const batch = Math.max(2, Math.min(12, numOr(cfg.batch, 6)))
      let items = liveItems()
      if (!items || items.length < cap) return { ok: true, merged: 0, count: items ? items.length : 0 }

      let merged = 0
      let guard = 0
      while (guard++ < 60) {
        items = liveItems()
        if (!items || items.length <= target) break
        const list = items.slice().filter((m) => !mapProtected(m.id)).sort((a, b) => (Number(a.importance) || 0.5) - (Number(b.importance) || 0.5) || (a.at || 0) - (b.at || 0))
        const take = Math.min(batch, list.length, items.length - target + 1)
        if (take < 2) break
        if (!(await mergeGroup(list.slice(0, take), cfg))) break
        merged++
      }
      return { ok: true, merged, count: (liveItems() || []).length }
    }

    /** 按时间：挑最老的几组压。 */
    async function compressByAge(cfg) {
      const items = liveItems()
      if (!items) return { ok: false, merged: 0 }
      const srcOk = new Set(String(cfg.sources || 'auto,tool').split(',').map((s) => s.trim()).filter(Boolean))
      const minAge = Math.max(0, numOr(cfg.minAgeHours, 6)) * HOUR
      const maxGen = Math.max(0, numOr(cfg.maxGen, 0))
      const minChars = Math.max(0, numOr(cfg.minChars, 30))
      const batch = Math.max(2, Math.min(12, numOr(cfg.batch, 6)))
      const perRun = Math.max(1, Math.min(6, numOr(cfg.maxGroupsPerRun, 2)))
      const now = Date.now()

      const groups = new Map()
      for (const m of items) {
        if (!srcOk.has(String(m.source || ''))) continue
        const gen = genOf(m)
        if (maxGen > 0 && gen >= maxGen) continue
        if (mapProtected(m.id)) continue
        if (now - Number(m.at || 0) < minAge) continue
        if (String(m.text || '').length < minChars) continue
        const key = (m.about || m.aboutName || '') + '|' + gen
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(m)
      }

      const picked = [...groups.values()]
        .filter((list) => list.length >= 2)
        .sort((a, b) => (a[0].at || 0) - (b[0].at || 0))
        .slice(0, perRun)

      let merged = 0
      for (const list of picked) {
        const rows = list.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, batch)
        if (await mergeGroup(rows, cfg)) merged++
      }
      return { ok: true, merged }
    }

    /** 像人一样淡忘：先掉重要度（越来越模糊），再按遗忘曲线真的忘掉。 */
    function forgetPass(cfg) {
      if (!cfg.forgetEnabled) return { faded: 0, forgot: 0 }
      const mem = memory()
      const items = liveItems()
      if (!mem || !items) return { faded: 0, forgot: 0 }
      const protect = new Set(String(cfg.protectSources ?? 'panel,import').split(',').map((s) => s.trim()).filter(Boolean))
      const grace = Math.max(0, numOr(cfg.forgetGraceHours, 12)) * HOUR
      const blurBelow = Math.min(0.999, Math.max(0.01, numOr(cfg.blurBelow, 0.25)))
      const forgetBelow = Math.min(blurBelow, Math.max(0.005, numOr(cfg.forgetBelow, 0.06)))
      const maxFade = Math.max(0, numOr(cfg.maxFadePerRun, 40))
      const maxForget = Math.max(0, numOr(cfg.maxForgetPerRun, 20))
      const now = Date.now()

      let faded = 0
      let forgot = 0
      for (const m of items) {
        if (protect.has(String(m.source || ''))) continue
        if (mapProtected(m.id)) continue
        if (now - (Number(m.at) || 0) < grace) continue
        const r = retention(m, now)
        if (r < forgetBelow) {
          if (forgot >= maxForget) continue
          if (cfg.dryRun) {
            api.log.info(`[演练] 会忘掉：${m.text.slice(0, 40)}（R=${r.toFixed(3)}）`)
            forgot++
            continue
          }
          try { appendFileSync(dataFile('removed.jsonl'), JSON.stringify({ kind: 'forget', at: now, id: m.id, text: m.text, source: m.source, r: Number(r.toFixed(3)) }) + '\n') } catch (error) {}
          coldArchive(m, 'forget')
          mem.remove(m.id)
          forgot++
          api.log.info(`忘掉一条（记得多牢 ${r.toFixed(3)}）：${String(m.text).slice(0, 30)}…`)
          continue
        }
        if (r < blurBelow && faded < maxFade) {
          const imp = Number(m.importance) || 0.5
          const next = Math.round(imp * 0.92 * 100) / 100
          if (imp - next >= 0.02) {
            if (!cfg.dryRun) mem.update(m.id, { importance: Math.max(0.05, next) })
            faded++
          }
        }
      }
      return { faded, forgot }
    }

    /** 一轮：先到顶强压，再按时间压，最后淡忘。 */
    async function runOnce({ force = false } = {}) {
      if (busy) return { ok: false, message: '上一轮还在跑' }
      const cfg = S()
      if (!force && !cfg.enabled) return { ok: false, message: '没开' }
      if (!memory()) return { ok: false, message: '记忆模块没在跑' }
      busy = true
      try {
        const forced = await shrinkToTarget(cfg)
        const timed = await compressByAge(cfg)
        const f = forgetPass(cfg)
        const count = (liveItems() || []).length
        const st = readState()
        st.lastRun = Date.now()
        st.runs = (Number(st.runs) || 0) + 1
        st.lastResult = { forced: forced.merged, timed: timed.merged, faded: f.faded, forgot: f.forgot, count }
        saveState(st)
        const parts = []
        if (forced.merged) parts.push(`到顶强压 ${forced.merged} 组`)
        if (timed.merged) parts.push(`按时间压 ${timed.merged} 组`)
        if (f.forgot) parts.push(`忘掉 ${f.forgot} 条`)
        if (f.faded) parts.push(`${f.faded} 条变淡`)
        return {
          ok: true,
          merged: forced.merged + timed.merged,
          forgot: f.forgot,
          faded: f.faded,
          count,
          message: parts.length ? `这轮：${parts.join('、')}，现在 ${count} 条` : `这轮没什么变化，现在 ${count} 条`,
        }
      } finally {
        busy = false
      }
    }

    async function maybeRun() {
      const cfg = S()
      if (!cfg.enabled) return
      const gap = Math.max(1, numOr(cfg.intervalHours, 4)) * HOUR
      const st = readState()
      if (st.lastRun && Date.now() - st.lastRun < gap) return
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 90_000)))
      await runOnce()
    }

    api.every(20 * 60_000, maybeRun, '记忆压缩带')

    api.route('/run', async () => runOnce({ force: true }))
    api.route('/state', async () => {
      const cfg = S()
      const now = Date.now()
      const live = liveItems() || []
      const gens = {}
      const bands = { fresh: 0, blurring: 0, fading: 0 }
      for (const m of live) {
        gens[genOf(m)] = (gens[genOf(m)] || 0) + 1
        const r = retention(m, now)
        if (r >= numOr(cfg.blurBelow, 0.25)) bands.fresh++
        else if (r >= numOr(cfg.forgetBelow, 0.06)) bands.blurring++
        else bands.fading++
      }
      return {
        ok: true,
        ...readState(),
        settings: cfg,
        liveCount: live.length,
        generations: gens,
        bands,
        sample: live.slice(0, 20).map((m) => ({ id: m.id, source: m.source, r: Number(retention(m, now).toFixed(5)), ageH: Number(((now - (Number(m.at) || 0)) / HOUR).toFixed(2)), imp: m.importance })),
        cap: numOr(cfg.countCap, 100),
        target: numOr(cfg.countTarget, 50),
      }
    })

    api.command({
      name: '压记忆',
      desc: '立刻跑一轮：压缩 + 淡忘，看看她忘掉了什么',
      run: async () => {
        const r = await runOnce({ force: true })
        return r.message || '跑完了'
      },
    })

    api.log.info('记忆压缩带 v3 已挂上（压缩 + 淡化 + 遗忘曲线）')
    return { runOnce, state: readState }
  },
}
