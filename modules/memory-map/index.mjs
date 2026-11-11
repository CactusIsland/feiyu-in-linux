// 记忆图谱 —— 用户模块（Aurabot 扩展接口 v1）
//
// 把长期记忆整理成一张给自己和主人看的图：
//  - 人物节点：她记得哪些人、什么关系、记得多少事、最近一次是什么时候；
//  - 关系边：大肥鱼 → 每个人，边上是关系类型和记忆条数；
//  - 分区：人物、约定、最近事件、偏好、快忘记；
//  - 权重：never / slow / normal / fast，never 的会被 memory-compact 跳过，不再压缩/遗忘。
//
// 这里只做展示和权重判断；真正「记什么」还是她自己用 remember / self_note 决定。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86400_000

function whenText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const now = new Date()
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return md
  return `${d.getFullYear()}-${md}`
}

function parseIds(text) {
  return new Set(String(text || '').split(/[\s,，;；]+/).map((x) => String(x).trim()).filter(Boolean))
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'memory-map',
  name: '记忆图谱',
  version: '1.0.0',
  api: 1,
  description: '她记得谁、什么关系、哪些永不遗忘、哪些快忘了；给记忆压缩带提供保护名单',
  panel: true,
  tab: 'mood',

  defaults: {
    enabled: true,
    ownerNeverForget: true,
    protectPanelImport: true,
    raiseNeverImportance: true,
    pinIds: '',
    includeDiary: true,
    maxPeople: 24,
    maxItemsPerSection: 12,
  },

  settings: [
    { key: 'enabled', label: '开启记忆图谱', type: 'switch' },
    { key: 'ownerNeverForget', label: '关于主人的重要记忆永不遗忘', type: 'switch', hint: '重要度 ≥ 0.8 的主人记忆' },
    { key: 'protectPanelImport', label: '面板手写/导入的记忆永不遗忘', type: 'switch' },
    { key: 'raiseNeverImportance', label: '把 auto 的永不遗忘条目抬到 0.6', type: 'switch', hint: '内置每日整理会删掉“auto 且重要度 <0.6”的旧记忆；抬到 0.6 才能真正挡住' },
    { key: 'pinIds', label: '手动保护的记忆 id', type: 'textarea', hint: '一行一个或用逗号分隔；面板里点「保护」也会写到这里' },
    { key: 'includeDiary', label: '把日记/经历算进图谱', type: 'switch' },
    { key: 'maxPeople', label: '最多显示几个人', type: 'number', min: 1, max: 60, step: 1 },
    { key: 'maxItemsPerSection', label: '每个分区最多几条', type: 'number', min: 1, max: 30, step: 1 },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const mapFile = () => join(dir, 'memory-map.json')
    const overridesFile = () => join(dir, 'overrides.json')

    let cache = { at: 0, map: null, protectedIds: new Set() }
    let overrides = {}
    try { overrides = JSON.parse(readFileSync(overridesFile(), 'utf8')) || {} } catch (error) { overrides = {} }
    const saveOverrides = () => {
      try { writeFileSync(overridesFile(), JSON.stringify(overrides, null, 2)) } catch (error) { api.log.warn('关系覆盖写入失败：' + error.message) }
    }

    const memory = () => api.use('memory')
    const ownerQQ = () => String(api.config().ownerQQ || '')
    const ownerName = () => String(api.config().ownerName || '主人')
    const isOwnerMemory = (m) => String(m?.about || '') === ownerQQ() || String(m?.aboutName || '') === ownerName()

    function retention(m, now) {
      const cfg = api.config().ext?.['memory-compact'] || {}
      const halfLife = Number(cfg.halfLifeDays) || 21
      const last = Math.max(Number(m.at) || 0, Number(m.lastHit) || 0)
      const days = Math.max(0, (now - last) / DAY)
      const strength = 1 + Math.min(10, Number(m.hitDays) || 0)
      const importance = Math.max(0.05, Math.min(1, Number(m.importance) || 0.5))
      const tau = halfLife * strength * (0.5 + importance)
      return Math.exp(-days / tau)
    }

    function weightOf(m, pinIds) {
      const s = api.settings()
      if (pinIds.has(String(m.id))) return 'never'
      if (s.protectPanelImport && (String(m.source) === 'panel' || String(m.source) === 'import')) return 'never'
      if (s.ownerNeverForget && isOwnerMemory(m) && Number(m.importance) >= 0.8) return 'never'
      const text = String(m.text || '')
      if (/第一次|初次|最初|约定|答应|说好|以后|下次|不要忘|发誓|保证/.test(text)) return 'never'
      if (/吵架|生气|道歉|对不起|和好|误会|冷战/.test(text)) return 'slow'
      if (isOwnerMemory(m)) return 'slow'
      if (['event', 'diary'].includes(String(m.source)) || (m.tags || []).includes('经历')) return 'slow'
      if (Number(m.importance) >= 0.6) return 'normal'
      if (text.length < 12 || Number(m.importance) < 0.35) return 'fast'
      return 'normal'
    }

    function build(force = false) {
      const now = Date.now()
      if (!force && cache.map && now - cache.at < 20_000) return cache.map
      const store = memory()
      if (!store || typeof store.list !== 'function') {
        const empty = { ok: true, generatedAt: now, stats: { total: 0, live: 0, people: 0, never: 0, fading: 0, outdated: 0 }, people: [], edges: [], events: [], promises: [], preferences: [], fading: [], recent: [], weights: { never: 0, slow: 0, normal: 0, fast: 0 }, policy: [] }
        cache = { at: now, map: empty, protectedIds: new Set() }
        return empty
      }

      const items = store.list('') || []
      const live = items.filter((m) => !m.invalidAt)
      const pinIds = parseIds(api.settings().pinIds)
      const weights = { never: 0, slow: 0, normal: 0, fast: 0 }
      const protectedIds = new Set()
      const scored = live.map((m) => {
        const w = weightOf(m, pinIds)
        weights[w] = (weights[w] || 0) + 1
        if (w === 'never') protectedIds.add(String(m.id))
        return { ...m, weight: w, retention: Number(retention(m, now).toFixed(4)) }
      })

      const profiles = new Map()
      try {
        for (const p of (store.profiles?.() || [])) profiles.set(String(p.qq), p)
      } catch (error) {}
      const insights = new Map()
      try {
        for (const x of (store.insights?.() || [])) insights.set(String(x.key), x)
      } catch (error) {}

      // 内置每日整理只跳过 source != auto 或重要度 >= 0.6 的条目。
      // 把 auto 的 never 条目抬到 0.6，才能让“永不遗忘”真的挡在 shouldForget 前面。
      let raised = 0
      if (api.settings().raiseNeverImportance && typeof store.update === 'function') {
        for (const m of scored) {
          if (m.weight !== 'never') continue
          if (String(m.source || '') !== 'auto') continue
          if (Number(m.importance) >= 0.6) continue
          try {
            const r = store.update(m.id, { importance: 0.6 })
            if (r && r.ok !== false) { m.importance = 0.6; raised++ }
          } catch (error) {}
        }
        if (raised) api.log.info(`把 ${raised} 条永不遗忘的 auto 记忆抬到 0.6，挡住内置整理`)
      }

      const peopleMap = new Map()
      for (const m of scored) {
        const owner = isOwnerMemory(m)
        const qq = owner ? ownerQQ() : String(m.about || '').trim()
        const name = String(m.aboutName || '').trim()
        if (!qq && !name) continue
        const key = owner ? `owner:${ownerQQ()}` : (qq || `name:${name}`)
        const ov = owner ? null : (overrides[key] || (qq ? overrides[qq] : null) || null)
        if (!peopleMap.has(key)) {
          peopleMap.set(key, {
            key,
            qq,
            name: owner ? ownerName() : (String(ov?.name || '') || name || qq || '某人'),
            kind: owner ? '主人' : (String(ov?.kind || '') || (String(m.chatId || '').startsWith('group:') ? '群友' : '熟人')),
            note: String(ov?.note || ''),
            count: 0,
            maxImportance: 0,
            lastAt: 0,
            lastText: '',
            weight: 'fast',
            profile: qq ? (profiles.get(qq)?.text || '') : '',
            insight: '',
            samples: [],
          })
        }
        const p = peopleMap.get(key)
        p.count++
        p.maxImportance = Math.max(p.maxImportance, Number(m.importance) || 0)
        if (Number(m.at) >= p.lastAt) { p.lastAt = Number(m.at) || 0; p.lastText = String(m.text || '') }
        if (['never', 'slow', 'normal', 'fast'].indexOf(m.weight) < ['never', 'slow', 'normal', 'fast'].indexOf(p.weight)) p.weight = m.weight
        if (p.samples.length < 3) p.samples.push({ id: m.id, text: String(m.text || ''), at: m.at, weight: m.weight })
      }
      for (const p of peopleMap.values()) {
        if (p.qq) {
          const ins = insights.get(`qq:${p.qq}`)
          if (ins?.list?.length) p.insight = ins.list.map((x) => x.text).join('；')
        }
      }
      const maxPeople = Math.max(1, Number(api.settings().maxPeople) || 24)
      const peopleCount = peopleMap.size
      const people = [...peopleMap.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, maxPeople)
      const edges = people.map((p) => ({ from: '大肥鱼', to: p.name, label: p.kind, value: p.count, qq: p.qq }))

      const match = (re) => scored.filter((m) => re.test(String(m.text || '')))
      const section = (list, n) => list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, n).map((m) => ({
        id: m.id,
        text: String(m.text || ''),
        at: m.at,
        when: whenText(m.at),
        about: m.aboutName || m.about || '',
        importance: m.importance,
        weight: m.weight,
        retention: m.retention,
        source: m.source,
      }))

      const maxItems = Math.max(1, Number(api.settings().maxItemsPerSection) || 12)
      const events = api.settings().includeDiary
        ? section(scored.filter((m) => ['event', 'diary'].includes(String(m.source)) || (m.tags || []).includes('经历')), maxItems)
        : []
      const promises = section(match(/约定|答应|说好|以后|下次|不要忘|发誓|保证|第一次|初次|最初/), maxItems)
      const preferences = section(match(/喜欢|讨厌|爱吃|最怕|最爱|不吃|忌口|白米饭/), maxItems)
      const fadingAll = scored.filter((m) => m.weight !== 'never' && m.retention < 0.25)
      const fading = fadingAll
        .sort((a, b) => a.retention - b.retention)
        .slice(0, maxItems)
        .map((m) => ({ id: m.id, text: String(m.text || ''), at: m.at, when: whenText(m.at), about: m.aboutName || m.about || '', importance: m.importance, weight: m.weight, retention: m.retention, source: m.source }))
      const recent = section(scored, maxItems)

      const map = {
        ok: true,
        generatedAt: now,
        stats: {
          total: items.length,
          live: live.length,
          people: peopleCount,
          never: weights.never,
          fading: fadingAll.length,
          outdated: items.length - live.length,
        },
        weights,
        pinnedIds: [...pinIds],
        overrides,
        people,
        edges,
        events,
        promises,
        preferences,
        fading,
        recent,
        policy: [
          { key: 'never', label: '永不遗忘', rule: '面板手写/导入、主人高重要度、第一次/初次、约定/承诺、手动保护' },
          { key: 'slow', label: '慢慢淡', rule: '关于主人、吵架/道歉/和好、经历与日记' },
          { key: 'normal', label: '正常', rule: '一般关系事件、重要度 ≥ 0.6' },
          { key: 'fast', label: '可以忘', rule: '很短、重要度 < 0.35、一次性寒暄' },
        ],
      }
      cache = { at: now, map, protectedIds }
      try { writeFileSync(mapFile(), JSON.stringify(map, null, 2)) } catch (error) { api.log.warn('记忆图谱写入失败：' + error.message) }
      return map
    }

    function isProtected(id) {
      const key = String(id || '')
      if (!key) return true                       // 空 id 也不能被当成"可忘"
      if (!cache.map || Date.now() - cache.at > 20_000) {
        try { build(true) } catch { return true }  // 图谱没建起来 → 一律当受保护
      }
      if (!cache.protectedIds || typeof cache.protectedIds.has !== 'function') return true
      return cache.protectedIds.has(key)
    }

    function pin(id, pinned) {
      const current = parseIds(api.settings().pinIds)
      if (pinned) current.add(String(id))
      else current.delete(String(id))
      api.saveSettings({ pinIds: [...current].join('\n') })
      build(true)
      return { ok: true, pinned: Boolean(pinned), id: String(id), count: current.size }
    }

    api.route('/map', async () => build(true))
    api.route('/dashboard', async (req, res) => {
      try {
        const html = readFileSync(join(api.dir, 'dashboard.html'), 'utf8')
        return api.core.http.send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        return api.core.http.send(res, 500, 'dashboard.html 读不到：' + error.message, 'text/plain; charset=utf-8')
      }
    })
    api.route('/rebuild', async () => build(true))
    api.route('/protected', async () => {
      build(true)
      return { ok: true, ids: [...cache.protectedIds] }
    })
    api.route('/pin', async (req) => {
      const b = await api.core.http.body(req)
      return pin(String(b?.id || ''), Boolean(b?.pinned))
    })
    api.route('/person', async (req) => {
      const b = await api.core.http.body(req)
      const key = String(b?.key || '').trim()
      if (!key || key.startsWith('owner:')) return { ok: false, message: '主人关系不能改' }
      const kind = String(b?.kind || '').trim()
      if (!['熟人', '群友', '陌生人', '主人'].includes(kind)) return { ok: false, message: '关系只能是 熟人/群友/陌生人/主人' }
      overrides[key] = {
        ...(overrides[key] || {}),
        ...(b?.name ? { name: String(b.name).slice(0, 20) } : {}),
        kind,
        ...(b?.note ? { note: String(b.note).slice(0, 80) } : {}),
      }
      saveOverrides()
      build(true)
      return { ok: true, key, override: overrides[key] }
    })

    api.tool((where) => {
      if (where.level !== 'full') return []
      return api.defineTool({
        name: 'memory_people',
        description: '看看你记得哪些人、和他们是什么关系、最近记得什么。别人问“你还记得谁”时用。',
        properties: {},
        execute: async () => {
          const map = build(false)
          if (!map.people.length) return { ok: true, message: '记忆里还没有别人。' }
          return {
            ok: true,
            message: map.people.map((p) => `${p.name}（${p.kind}，${p.count} 条${p.lastText ? '，最近：' + String(p.lastText).slice(0, 60) : ''}）`).join('\n'),
          }
        },
      })
    })

    api.command({
      name: '图谱',
      desc: '看看她记得哪些人、哪些记忆永不遗忘、哪些快忘了',
      run: async () => {
        const map = build(true)
        return `记忆图谱：${map.stats.live} 条有效记忆，${map.stats.people} 个人；永不遗忘 ${map.stats.never} 条，快忘记 ${map.stats.fading} 条。`
      },
    })

    api.rule((kind) => (kind === 'private'
      ? '你想知道自己记得哪些人、和谁关系怎么样时，可以用 memory_people；不要没事把整张图谱念出来。'
      : ''))

    api.every(10 * 60_000, () => { try { build(true) } catch (error) { api.log.warn('刷新记忆图谱失败：' + error.message) } }, '记忆图谱')
    api.on('module/start', (id) => { if (String(id) === 'memory') { try { build(true) } catch (error) {} } })
    build(true)
    api.log.info('记忆图谱已挂上（人物/关系/约定/偏好/快忘记 + 永不遗忘保护）')

    return { build, isProtected, pin, map: () => build(false) }
  },
}
