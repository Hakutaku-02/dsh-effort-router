/**
 * 设置页提交的配置补丁的校验。
 *
 * 纯函数：输入一个来路不明的对象，输出能落盘的字段集合。字段本身不合法时回
 * `{ ok: false, invalid: true, detail }`，调用方按 400 回浏览器；写不进设置服务属于另一类
 * 失败（503），不在这里处理。
 *
 * 空字符串一律当「没填」：写进去会把已有配置静默还原，所以宁可不写这个字段。
 */
import { JUDGE_SOURCES, MODES, TIER_KEYS } from './settings.mjs'
import { strengthOf } from '../effort.mjs'

/** 判定地址与 Jev 地址每轮都会收到用户原文，限定成 http(s)，别的 scheme 一律拒绝。 */
function httpUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.toString()
}

function invalid(detail) {
  return { ok: false, invalid: true, detail }
}

/**
 * 把补丁裁成可落盘的字段。
 *
 * 认不出的字段直接丢掉：前端与配置文件都可能带旧字段，报错反而让人不知道该删哪个。
 */
export function validatePatch(patch) {
  const clean = {}
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
  if (MODES.includes(patch.mode)) clean.mode = patch.mode
  if (JUDGE_SOURCES.includes(patch.judgeSource)) clean.judgeSource = patch.judgeSource
  if (typeof patch.judgeUrl === 'string' && patch.judgeUrl !== '') {
    const url = httpUrl(patch.judgeUrl)
    if (url === undefined) return invalid('judgeUrl 必须是 http(s) 地址')
    clean.judgeUrl = url
  }
  if (typeof patch.legacyOwned === 'boolean') clean.legacyOwned = patch.legacyOwned
  if (patch.notify === '' || patch.notify === 'off' || patch.notify === 'always') clean.notify = patch.notify
  if (typeof patch.jevUrl === 'string' && patch.jevUrl !== '') {
    const url = httpUrl(patch.jevUrl)
    if (url === undefined) return invalid('jevUrl 必须是 http(s) 地址')
    clean.jevUrl = url
  }
  if (typeof patch.jevModel === 'string' && patch.jevModel !== '') clean.jevModel = patch.jevModel
  if (typeof patch.jevApiKeyEnv === 'string' && patch.jevApiKeyEnv !== '') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(patch.jevApiKeyEnv)) {
      return invalid('凭据名只能包含字母、数字、下划线，且不能以数字开头')
    }
    clean.jevApiKeyEnv = patch.jevApiKeyEnv
  }
  if (patch.jevConfidence !== undefined && patch.jevConfidence !== null) {
    const value = Number(patch.jevConfidence)
    if (!Number.isFinite(value) || value < 0 || value > 1) return invalid('jevConfidence 必须在 0 到 1 之间')
    clean.jevConfidence = value
  }
  if (patch.tiers !== undefined && patch.tiers !== null && typeof patch.tiers === 'object') {
    const next = {}
    for (const key of TIER_KEYS) {
      const value = patch.tiers[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || strengthOf(value) === undefined) {
        return invalid(`档位 ${key} 的强度名不认识：${String(value)}`)
      }
      next[key] = value
    }
    if (Object.keys(next).length > 0) clean.tiers = next
  }
  if (Object.keys(clean).length === 0) return invalid('没有可写的字段')
  return { ok: true, clean }
}
