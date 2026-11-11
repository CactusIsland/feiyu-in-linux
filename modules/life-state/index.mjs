// 作息 / 精力 / 饥饿 —— 用户模块（Aurabot 扩展接口 v1）
//
// 给她一副会累、会饿、会睡的身体：
//  - 精力：醒着慢慢掉，睡觉慢慢回；
//  - 饥饿：时间越久越饿，吃饭就饱；
//  - 作息：默认 23:30 睡、09:00 醒，到点自动切换状态（不会拦她回话，只影响语气）；
//  - 每轮只注入一句很短的“身体状态”，不报数字，不额外烧 token。
//
// 面板可调作息和衰减速度；主人可以用 /身体 /喂饭 /睡觉 /起床。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOUR = 3600_000

function clockMinutes(text, fallback) {
  const m = String(text || '').match(/(\d{1,2})[:：](\d{1,2})/)
  if (!m) return fallback
  return Math.min(23, Math.max(0, Number(m[1]))) * 60 + Math.min(59, Math.max(0, Number(m[2])))
}

function inSleepWindow(now, startText, endText) {
  const start = clockMinutes(startText, 23 * 60 + 30)
  const end = clockMinutes(endText, 9 * 60)
  const mins = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  return start < end ? (mins >= start && mins < end) : (mins >= start || mins < end)
}

function clockText(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'life-state',
  name: '作息与身体',
  version: '1.0.0',
  api: 1,
  description: '精力、饥饿、作息：会累会饿会睡，只影响语气，不拦回话',

  defaults: {
    enabled: true,
    energyStart: 80,
    hungerStart: 40,
    sleepStart: '23:30',
    sleepEnd: '09:00',
    energyDecayPerHour: 2.5,
    energySleepGainPerHour: 10,
    hungerGainPerHour: 3.5,
    hungerSleepGainPerHour: 1.2,
    feedHunger: 25,
    feedEnergy: 8,
    feedGif: true,
  },

  settings: [
    { key: 'enabled', label: '开启作息与身体', type: 'switch' },
    { key: 'energyStart', label: '初始精力', type: 'number', min: 0, max: 100, step: 5 },
    { key: 'hungerStart', label: '初始饥饿', type: 'number', min: 0, max: 100, step: 5 },
    { key: 'sleepStart', label: '几点睡', type: 'text', hint: '例如 23:30；跨午夜会自动处理' },
    { key: 'sleepEnd', label: '几点醒', type: 'text', hint: '例如 09:00' },
    { key: 'energyDecayPerHour', label: '醒着每小时掉多少精力', type: 'number', min: 0, max: 20, step: 0.5 },
    { key: 'energySleepGainPerHour', label: '睡觉每小时回多少精力', type: 'number', min: 0, max: 30, step: 0.5 },
    { key: 'hungerGainPerHour', label: '醒着每小时增加多少饥饿', type: 'number', min: 0, max: 20, step: 0.5 },
    { key: 'hungerSleepGainPerHour', label: '睡觉每小时增加多少饥饿', type: 'number', min: 0, max: 10, step: 0.5 },
    { key: 'feedHunger', label: '喂一次降多少饥饿', type: 'number', min: 0, max: 100, step: 5 },
    { key: 'feedEnergy', label: '喂一次回多少精力', type: 'number', min: 0, max: 50, step: 1 },
    { key: 'feedGif', label: '喂饭时发吃白饭 GIF', type: 'switch' },
  ],

  setup(api) {
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const file = () => join(dir, 'state.json')
    const cfg = () => api.settings()
    const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0))

    let state = {
      version: 1,
      at: Date.now(),
      lastTick: 0,
      energy: Number(cfg().energyStart) || 80,
      hunger: Number(cfg().hungerStart) || 40,
      asleep: false,
      sleepSince: 0,
      lastWake: 0,
      lastMeal: 0,
      lastMoodNudge: 0,
    }
    try { state = { ...state, ...(JSON.parse(readFileSync(file(), 'utf8')) || {}) } } catch (error) {}
    const save = () => {
      state.at = Date.now()
      try { writeFileSync(file(), JSON.stringify(state, null, 2)) } catch (error) { api.log.warn('身体状态写入失败：' + error.message) }
    }

    const petAnim = (text, anim) => {
      try {
        api.use('pet')?.dispatch?.({ text, anim, via: 'pet', noFallback: true, force: true, purpose: 'life' }).catch?.(() => {})
      } catch (error) {}
    }

    let pendingHunger = 0
    let pendingEnergy = 0
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'in' || !String(a.text || '').trim()) return
        // 干活/聊天也会消耗：每条消息一点点，10 分钟内封顶，避免群里刷屏把饥饿拉爆
        pendingHunger = Math.min(0.5, pendingHunger + 0.02)
        pendingEnergy = Math.min(0.2, pendingEnergy + 0.01)
      } catch (error) {}
    })

    function catchUp() {
      const now = Date.now()
      const hours = state.lastTick ? Math.max(0, Math.min(72, (now - state.lastTick) / HOUR)) : 0
      const asleepNow = inSleepWindow(new Date(now), cfg().sleepStart, cfg().sleepEnd)
      if (hours > 0) {
        if (asleepNow) {
          state.energy = clamp(state.energy + (Number(cfg().energySleepGainPerHour) || 10) * hours)
          state.hunger = clamp(state.hunger + (Number(cfg().hungerSleepGainPerHour) || 1.2) * hours)
        } else {
          state.energy = clamp(state.energy - (Number(cfg().energyDecayPerHour) || 2.5) * hours)
          state.hunger = clamp(state.hunger + (Number(cfg().hungerGainPerHour) || 3.5) * hours)
        }
      }
      if (asleepNow !== Boolean(state.asleep)) {
        state.asleep = asleepNow
        if (asleepNow) {
          state.sleepSince = now
          petAnim('困了，先眯一会儿', '原地小憩沉眠')
          api.log.info('进入睡觉状态')
        } else {
          state.lastWake = now
          petAnim('醒了，伸个懒腰', '超大伸懒腰')
          api.log.info('醒来')
        }
      }
      state.lastTick = now
      if (pendingHunger || pendingEnergy) {
        state.hunger = clamp(state.hunger + pendingHunger)
        state.energy = clamp(state.energy - pendingEnergy)
        pendingHunger = 0
        pendingEnergy = 0
      }
      // 饿到 85 以上、两小时没推过心情：轻轻推到低落
      if (state.hunger > 85 && now - (Number(state.lastMoodNudge) || 0) > 2 * HOUR) {
        state.lastMoodNudge = now
        try { api.use('mood')?.nudge?.(-0.15, '饿了') } catch (error) {}
      }
      save()
    }

    function label() {
      const e = Number(state.energy) || 0
      const h = Number(state.hunger) || 0
      const energy = e >= 80 ? '精神很好' : e >= 60 ? '还行' : e >= 35 ? '有点累' : '快撑不住了'
      const hunger = h <= 25 ? '刚吃饱' : h <= 60 ? '有点想吃东西' : h <= 85 ? '肚子饿了' : '饿得慌'
      return { energy, hunger }
    }

    function contextLine() {
      if (!cfg().enabled) return ''
      const l = label()
      return `（你现在的身体状态：${l.energy}，${l.hunger}，${state.asleep ? '正在睡觉、迷迷糊糊' : '醒着'}。这会自然影响语气，别主动报数值。）`
    }

    api.context(({ chat }) => (chat?.kind === 'system' ? '' : contextLine()))

    api.rule(() => '你困的时候话会变少、句子更短；饿的时候容易想到吃的；不要主动报精力/饥饿数值。')

    function feed(chatId) {
      state.hunger = clamp(state.hunger - (Number(cfg().feedHunger) || 25))
      state.energy = clamp(state.energy + (Number(cfg().feedEnergy) || 8))
      state.lastMeal = Date.now()
      save()
      try { api.use('mood')?.nudge?.(0.2, '吃到白米饭') } catch (error) {}
      petAnim('开饭！白米饭！', '吃白饭')
      if (cfg().feedGif) {
        try { api.use('pet-shot')?.sendGif?.(chatId, '吃白饭').catch?.(() => {}) } catch (error) {}
      }
      return `吃饱了：精力 ${Math.round(state.energy)}/100，肚子 ${Math.round(state.hunger)}/100。`
    }

    function sleep(chatId) {
      state.asleep = true
      state.sleepSince = Date.now()
      save()
      petAnim('我先睡了，晚安', '原地小憩沉眠')
      return `睡了。作息：${cfg().sleepStart} - ${cfg().sleepEnd}。`
    }

    function wake(chatId) {
      state.asleep = false
      state.lastWake = Date.now()
      save()
      petAnim('醒了，伸个懒腰', '超大伸懒腰')
      return `醒了。精力 ${Math.round(state.energy)}/100，肚子 ${Math.round(state.hunger)}/100。`
    }

    function statusText() {
      const l = label()
      return `精力 ${Math.round(state.energy)}/100（${l.energy}），肚子 ${Math.round(state.hunger)}/100（${l.hunger}），现在${state.asleep ? '在睡' : '醒着'}；作息 ${cfg().sleepStart} - ${cfg().sleepEnd}。`
    }

    api.command({
      name: '身体',
      desc: '看她的精力、饥饿和作息',
      run: async () => statusText(),
    })
    api.command({
      name: '喂饭',
      desc: '喂她一顿白米饭；会降饥饿、回精力，可能发一张吃白饭 GIF',
      run: async (arg, msg) => feed(msg?.chatId),
    })
    api.command({
      name: '睡觉',
      desc: '让她去睡',
      run: async (arg, msg) => sleep(msg?.chatId),
    })
    api.command({
      name: '起床',
      desc: '让她起床',
      run: async (arg, msg) => wake(msg?.chatId),
    })

    api.route('/state', async () => ({ ok: true, ...state, labels: label(), sleepWindow: [cfg().sleepStart, cfg().sleepEnd] }))
    api.route('/feed', async (req) => feed(String(api.core.http.query(req).chat || `private:${api.config().ownerQQ || ''}`)))
    api.route('/sleep', async () => sleep())
    api.route('/wake', async () => wake())

    api.every(10 * 60_000, catchUp, '作息与身体')
    api.later(60_000, catchUp)
    catchUp()
    api.log.info('作息与身体已挂上（精力/饥饿/睡眠，只影响语气）')

    return { state: () => state, feed, sleep, wake, catchUp, statusText }
  },
}
