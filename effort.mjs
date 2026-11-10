/**
 * 判定档位到模型强度的落位规则。
 *
 * 各厂商的强度词汇与档数都不一样（deepseek 三档、gemini 三档值不同、minimax 五档），
 * 判定服务只回 low / high / max。这里负责把三档落到「当前模型自己声明的列表」上，
 * 所以换 provider、换 model 不用改任何配置。
 */
import { DEFAULT_TIERS, JUDGE_TIERS } from './config/settings.mjs'

/**
 * 强度从弱到强。各厂商词汇不同，这里只做跨厂商的粗序，认不出的强度当作未知。
 */
const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 一个强度名在 ORDER 里的位置；未知返回 undefined。 */
export function strengthOf(effort) {
  const index = ORDER.indexOf(String(effort ?? '').toLowerCase())
  return index === -1 ? undefined : index
}

/**
 * 把模型的档位列表整理成梯子：去掉 off（那是关掉思考，不是一档强度），按强弱排序。
 */
export function ladderOf(available) {
  return (available ?? [])
    .map((id) => ({ id, index: strengthOf(id) }))
    .filter((entry) => entry.index !== undefined && String(entry.id).toLowerCase() !== 'off')
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.id)
}

/**
 * 把判定的三档按相对位置落到模型自己的梯子上。
 *
 * low 取最低档，high 取中间档，max 取最高档。这样每个模型都能用满自己的范围：
 * deepseek 的三档（low/high/max）落成 low/high/max；
 * gemini 的三档（low/medium/high）落成 low/medium/high；
 * minimax 的五档（low/medium/high/xhigh/max）落成 low/high/max。
 *
 * 不按名字硬套的理由：名字套会让「没有 max 的模型」把 max 压到 high，
 * 让「有 xhigh 的模型」永远用不到 medium 与 xhigh。
 */
export function pickByLadder(available, tier) {
  const ladder = ladderOf(available)
  if (ladder.length === 0) return undefined
  const last = ladder.length - 1
  const offset = tier === 'max' ? last : tier === 'low' ? 0 : Math.round(last / 2)
  return ladder[Math.min(Math.max(offset, 0), last)]
}

/**
 * 在 `available` 里挑一个不超过 `target` 的最强档。
 *
 * 这是「按名字映射」的走法，只在用户手工改过 tiers 时用。
 * 模型全部比 target 强时给最弱那个；available 为空或全是不认识的强度名时返回 undefined。
 */
export function pickEffort(available, target) {
  const targetIndex = strengthOf(target)
  if (targetIndex === undefined) return undefined
  const known = (available ?? [])
    .map((id) => ({ id, index: strengthOf(id) }))
    .filter((entry) => entry.index !== undefined)
    .sort((left, right) => left.index - right.index)
  if (known.length === 0) return undefined
  let best
  for (const entry of known) {
    if (entry.index <= targetIndex) best = entry.id
  }
  return best ?? known[0].id
}

/**
 * 取本轮要写的强度。
 *
 * 默认走位置映射，不需要用户配置。只有用户把三个判定档的落点改成非默认值时才按那张表走，
 * 保留手工精调的口子。
 *
 * `tiers.fallback` 不参与这个判断：它说的是判定失败时用哪个档位，与「档位落到哪个强度」
 * 无关。算进去会让只改了 fallback 的配置被当成手工精调，于是低/中/高三档退化成按名字套，
 * 像 gemini 的 low/medium/high 三档就再也落不到 medium（high 与 max 都落到 high，中间那档被跳过）。
 */
export function pickForTier(available, tier, tiers) {
  const customised = JUDGE_TIERS.some((key) => (tiers?.[key] ?? DEFAULT_TIERS[key]) !== DEFAULT_TIERS[key])
  if (customised) return pickEffort(available, tiers[tier] ?? tiers.fallback)
  return pickByLadder(available, tier)
}
