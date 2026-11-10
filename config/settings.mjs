/**
 * 配置项的名字、默认值与实时取值规则。
 *
 * 设置面热改字段之后，apply() 收到的 config 是旧快照，每轮都要把「设置面当前值」与
 * 「挂载时的快照」重新合成一次。合成规则全部收在这里，给一个纯函数：同样的输入永远
 * 得到同样的输出，不需要宿主、不碰磁盘。
 *
 * 这一层曾经散在 apply() 的 live() 里，两条已修的 bug 都出在这张合并表上：
 * judgeTimeoutMs 的 schema 默认值先填进 describe()，按后端区分的预算永远轮不到；
 * tiers.fallback 被当成手工精调，三档模型的中间档整档用不上。
 */

/** 判定后端的默认地址：本机判定服务。 */
export const DEFAULT_JUDGE = 'http://127.0.0.1:8765/judge'
/** 本地服务单次判定的上限；Jev 走公网，另算。 */
export const JUDGE_TIMEOUT_MS = 20000
/** hold 阶段等本地判定的预算：覆盖常见提问，更长的文本按兜底档放行。 */
export const JUDGE_HOLD_TIMEOUT_MS = 6000
/** hold 阶段等 Jev 的预算：公网往返加排队，仍留出超时放行的余地。 */
export const JEV_HOLD_TIMEOUT_MS = 3000

export const MODES = ['auto', 'manual']
/** 判定后端。local 走本机服务；jev 走 TypeSafe 的 System One 决策端点。 */
export const JUDGE_SOURCES = ['local', 'jev']

/** 档位到强度名的默认映射，也是页面里那四个下拉的名字。 */
export const TIER_KEYS = ['low', 'high', 'max', 'fallback']
/** 判定后端真正会回的档位。fallback 只是映射表的一个键，不是判定结果。 */
export const JUDGE_TIERS = ['low', 'high', 'max']
export const DEFAULT_TIERS = { low: 'low', high: 'high', max: 'max', fallback: 'low' }

export const DEFAULT_JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const JEV_KEY_REF = 'TYPESAFE_API_KEY'
export const DEFAULT_JEV_CONFIDENCE = 0.6
export const JEV_TIMEOUT_MS = 12000

/**
 * volatile 字段在运行时是个带 `get()` 的句柄，不是普通值。
 * 普通字段原样返回；句柄读一次拿当前值；取不到时用 fallback。
 */
export function valueOf(input, fallback) {
  try {
    if (input !== undefined && input !== null && typeof input.get === 'function') {
      const value = input.get()
      return value === undefined ? fallback : value
    }
  } catch {
    // 句柄读不出来就当作没配：把句柄对象本身透出去会让下游拿到一个看不懂的对象。
    return fallback
  }
  return input === undefined || input === null ? fallback : input
}

/** 配置里的毫秒值可能是 YAML 数字也可能是字符串；不合法时用默认值。 */
export function toMs(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/** 设置面读不到时，挂载快照里的档位表；与 DEFAULT_TIERS 合并一次。 */
function tiersOf(cfg, mounted) {
  if (mounted !== undefined && mounted.tiers !== undefined && mounted.tiers !== null) return mounted.tiers
  return { ...DEFAULT_TIERS, ...valueOf(cfg.tiers, {}) }
}

/**
 * 本轮的配置：设置面当前值优先，读不到退回挂载快照。
 *
 * `values` 是设置面那一行的 value，`mounted` 是挂载时定下的判定地址、模式与档位表。
 * 各项的取值顺序：
 * - enabled / legacyOwned：设置面给了布尔值就用它，否则看挂载快照；
 * - mode / judgeSource：只认枚举里的值，脏值退回挂载快照；
 * - judgeUrl / jevUrl / jevModel / jevApiKeyEnv：空串视为没填，退回默认值；
 * - judgeTimeoutMs：没填时按后端给预算，本地 6000、Jev 3000。
 */
export function resolveLive(values, cfg, mounted = {}) {
  const mountedUrl = typeof mounted.judgeUrl === 'string' && mounted.judgeUrl !== '' ? mounted.judgeUrl : DEFAULT_JUDGE
  const mountedMode = MODES.includes(mounted.mode) ? mounted.mode : 'auto'
  const tierRows = values?.tiers !== undefined && values.tiers !== null && typeof values.tiers === 'object'
    ? { ...tiersOf(cfg, mounted), ...values.tiers }
    : tiersOf(cfg, mounted)
  const judgeSource = JUDGE_SOURCES.includes(values?.judgeSource)
    ? values.judgeSource
    : (valueOf(cfg.judgeSource, 'local') === 'jev' ? 'jev' : 'local')
  return {
    enabled: typeof values?.enabled === 'boolean' ? values.enabled : valueOf(cfg.enabled, true) !== false,
    mode: MODES.includes(values?.mode) ? values.mode : mountedMode,
    judgeSource,
    judgeUrl: typeof values?.judgeUrl === 'string' && values.judgeUrl !== '' ? values.judgeUrl : mountedUrl,
    notify: typeof values?.notify === 'string' ? values.notify : String(valueOf(cfg.notify, '') ?? ''),
    tiers: { ...DEFAULT_TIERS, ...tierRows },
    jevUrl: typeof values?.jevUrl === 'string' && values.jevUrl !== '' ? values.jevUrl : (valueOf(cfg.jevUrl, '') || DEFAULT_JEV_URL),
    jevModel: typeof values?.jevModel === 'string' && values.jevModel !== '' ? values.jevModel : (valueOf(cfg.jevModel, '') || DEFAULT_JEV_MODEL),
    jevApiKeyEnv: typeof values?.jevApiKeyEnv === 'string' && values.jevApiKeyEnv !== '' ? values.jevApiKeyEnv : (valueOf(cfg.jevApiKeyEnv, '') || JEV_KEY_REF),
    jevConfidence: Number.isFinite(Number(values?.jevConfidence)) ? Number(values.jevConfidence) : toMs(cfg.jevConfidence, DEFAULT_JEV_CONFIDENCE),
    jevTimeoutMs: toMs(values?.jevTimeoutMs ?? cfg.jevTimeoutMs, JEV_TIMEOUT_MS),
    // 没配预算时按后端给默认值：Jev 是公网往返，本地服务是同机调用。
    judgeTimeoutMs: toMs(values?.judgeTimeoutMs ?? cfg.judgeTimeoutMs, judgeSource === 'jev' ? JEV_HOLD_TIMEOUT_MS : JUDGE_HOLD_TIMEOUT_MS),
    legacyOwned: typeof values?.legacyOwned === 'boolean' ? values.legacyOwned : valueOf(cfg.legacyOwned, true) !== false,
  }
}
