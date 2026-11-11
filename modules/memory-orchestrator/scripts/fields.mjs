// 记忆字段推断规则 —— 迁移脚本（scripts/migrate.mjs）和模块的定时补齐共用这一份，
// 避免两处各写一套、慢慢漂移。
//
// 只做纯数据判断，不碰文件系统。

export const TYPES = ['fact', 'preference', 'event', 'promise', 'conjecture']
export const DEFAULT_CONFIDENCE = 0.6

export const STRONG_RE = /约定|发誓|答应|第一次/
const PROMISE_RE = /约定|发誓|答应|说好|保证|承诺|许诺/
const PREFERENCE_RE = /喜欢|讨厌|最爱|不喜欢|偏好|爱吃|忌口/
const CONJECTURE_RE = /^\s*(?:我)?猜|推测|说不定/
const FACT_TAG_RE = /事实|信息|身份|资料|档案|画像|设置|能力清单|索引/
// 身份/资料类：QQ 号、昵称、称呼、微信、某人是谁
const FACT_TEXT_RE = /(?:QQ|qq)\s*(?:号)?\s*[:：]?\s*\d{5,}|昵称|称呼是|名字是|微信是|有一个叫|群里有个叫|的QQ号|QQ号是|是(?:个|一个)?[^，。]{0,10}(?:学生|老师|医生|程序员|上班族)/

export const tagTextOf = (tags) => (Array.isArray(tags) ? tags.join(' ') : '')
export const isStrong = (text, tags) => STRONG_RE.test(String(text || '')) || STRONG_RE.test(tagTextOf(tags))

export const isValidType = (v) => TYPES.includes(v)
export const isValidConfidence = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1
export const isValidScope = (v) => typeof v === 'string' && (v === 'owner' || v === 'global' || /^group:\d+$/.test(v))
export const hasTimestamp = (v) => Number.isFinite(Number(v)) && Number(v) > 0

export function inferType(text, tags, about = '', source = '') {
  const t = String(text || '')
  const g = tagTextOf(tags)
  if (PROMISE_RE.test(t) || PROMISE_RE.test(g)) return 'promise'
  if (PREFERENCE_RE.test(t) || PREFERENCE_RE.test(g)) return 'preference'
  if (CONJECTURE_RE.test(t) || /猜想|猜测|推测/.test(g)) return 'conjecture'
  if (FACT_TAG_RE.test(g) || FACT_TEXT_RE.test(t) || (String(about || '') && source === 'profile')) return 'fact'
  return 'event'
}

export const inferConfidence = (text, tags) => (isStrong(text, tags) ? 0.9 : DEFAULT_CONFIDENCE)

export function inferScope(chatId, ownerQQ = '') {
  const id = String(chatId || '')
  if (id.startsWith('group:')) return id
  if (id.startsWith('private:')) {
    const qq = id.slice('private:'.length)
    return String(ownerQQ || '') && qq === String(ownerQQ) ? 'owner' : 'global'
  }
  return 'global'
}

/** 一条记忆该有的 protected 取值。 */
export function inferProtected(it) {
  const importance = Number(it.importance)
  return (Number.isFinite(importance) && importance >= 0.85) || isStrong(it.text, it.tags)
}

/**
 * 就地补齐一条记忆的字段，返回这次补了哪些字段（空数组 = 本来就不缺，没动）。
 * 已有的合法值一律保留；原有字段一个不删。
 */
export function patchItem(it, { at = Date.now(), ownerQQ = '' } = {}) {
  const filled = []
  if (!isValidType(it.type)) {
    it.type = inferType(it.text, it.tags, it.about, it.source)
    filled.push('type')
  }
  if (!isValidConfidence(it.confidence)) {
    it.confidence = inferConfidence(it.text, it.tags)
    filled.push('confidence')
  }
  if (!isValidScope(it.scope)) {
    it.scope = inferScope(it.chatId, ownerQQ)
    filled.push('scope')
  }
  if (typeof it.protected !== 'boolean') {
    it.protected = inferProtected(it)
    filled.push('protected')
  }
  if (!hasTimestamp(it.updatedAt)) {
    it.updatedAt = Number(it.at) || Number(it.lastHit) || at
    filled.push('updatedAt')
  }
  return filled
}
