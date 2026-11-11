#!/usr/bin/env node
// 记忆编排器 · 一次性迁移脚本（幂等，可重复执行）
//
// 用法（在服务器上）：
//   node /root/.dsh/plugins-data/aurabot/modules/memory-orchestrator/scripts/migrate.mjs
//   node .../migrate.mjs --dry      # 只看会改什么，不写盘
//
// 做的事：
//   1. 把 memories.json 备份到 /opt/fish/backup/memories-before-orchestrator.json
//   2. 给每条记忆补齐 type / confidence / scope / protected / updatedAt（缺才补）
//      规则和模块的定时补齐共用 scripts/fields.mjs，不会两处漂移
//   3. 原有字段一律不动，条数不变；原子写回（tmp + rename，0640）
//
// 只读 config.json 的 ownerQQ 用来判断 scope=owner，不写它。

import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { TYPES, isValidConfidence, isValidType, patchItem } from './fields.mjs'

const DSH = process.env.DSH_HOME || '/root/.dsh'
const MEM_FILE = join(DSH, 'plugins-data', 'aurabot', 'memories.json')
const CONFIG_FILE = join(DSH, 'plugins-data', 'aurabot', 'config.json')
const BACKUP_FILE = '/opt/fish/backup/memories-before-orchestrator.json'
const DRY = process.argv.includes('--dry')

const ownerQQ = (() => {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return String(cfg.ownerQQ || '').trim()
  } catch (error) {
    return ''
  }
})()

const clip = (text, n) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function writeAtomic(file, text, mode = 0o640) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o750 })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function main() {
  if (!existsSync(MEM_FILE)) fail(`找不到 ${MEM_FILE}`)
  const st = statSync(MEM_FILE)
  const raw = readFileSync(MEM_FILE, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`memories.json 不是合法 JSON：${error.message}`)
  }

  const isArray = Array.isArray(parsed)
  const list = isArray ? parsed : parsed?.items
  if (!Array.isArray(list)) fail('memories.json 结构不认识（既不是数组也没有 items 数组）')

  const beforeCount = list.length
  const at = Date.now()
  const stats = { type: 0, confidence: 0, scope: 0, protected: 0, updatedAt: 0 }
  const byType = Object.fromEntries(TYPES.map((t) => [t, 0]))
  let protectedCount = 0
  let lowCount = 0

  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    for (const field of patchItem(it, { at, ownerQQ })) stats[field] = (stats[field] || 0) + 1
    byType[it.type] = (byType[it.type] || 0) + 1
    if (it.protected) protectedCount += 1
    if (Number(it.confidence) <= 0.5) lowCount += 1
  }

  const afterCount = list.length
  if (afterCount !== beforeCount) fail(`条数变了：${beforeCount} → ${afterCount}`)

  const missing = list.filter((it) => it && typeof it === 'object' && (!isValidType(it.type) || !isValidConfidence(it.confidence))).length
  if (missing) fail(`还有 ${missing} 条缺 type/confidence`)

  const out = JSON.stringify(isArray ? list : parsed, null, 2) + (raw.endsWith('\n') ? '\n' : '')
  const changed = Object.values(stats).some((n) => n > 0)

  console.log('【记忆编排器 · 迁移】')
  console.log(`  文件：${MEM_FILE}（${st.size} 字节，${new Date(st.mtimeMs).toISOString()}）`)
  console.log(`  结构：${isArray ? '数组' : `对象（顶层键 ${Object.keys(parsed).join(', ')}）`}`)
  console.log(`  条数：迁移前 ${beforeCount} → 迁移后 ${afterCount}（${afterCount === beforeCount ? '一致 ✓' : '不一致 ✗'}）`)
  console.log(`  本次补齐：type ${stats.type}，confidence ${stats.confidence}，scope ${stats.scope}，protected ${stats.protected}，updatedAt ${stats.updatedAt}`)
  console.log(`  类型分布：${TYPES.map((t) => `${t}=${byType[t] || 0}`).join('  ')}`)
  console.log(`  受保护：${protectedCount} 条；低置信度(≤0.5)：${lowCount} 条`)
  if (ownerQQ) console.log(`  主人 QQ（只读 config.json）：${ownerQQ}`)

  if (DRY) {
    console.log('  [--dry] 没有写盘，也没有做备份。')
    return
  }

  if (!existsSync(BACKUP_FILE)) {
    writeAtomic(BACKUP_FILE, raw)
    console.log(`  备份：${BACKUP_FILE}（已创建，${statSync(BACKUP_FILE).size} 字节）`)
  } else {
    console.log(`  备份：${BACKUP_FILE}（已存在，保留最早那份不覆盖，${statSync(BACKUP_FILE).size} 字节）`)
  }

  if (!changed) {
    console.log('  没有字段需要补，文件未改写（幂等 ✓）')
    return
  }

  writeAtomic(MEM_FILE, out)
  const after = statSync(MEM_FILE)
  console.log(`  写回：${MEM_FILE}（${after.size} 字节，mode ${(after.mode & 0o777).toString(8)}）`)
  console.log('  样例：')
  for (const it of list.slice(0, 3)) {
    console.log(`    - [${it.type}|${it.confidence}|${it.scope}|${it.protected ? 'protected' : '-'}] ${clip(it.text, 50)}`)
  }
  console.log('  完成 ✓（再跑一次不会改动任何字段）')
}

main()
