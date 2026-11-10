/**
 * 配置实时取值：设置面当前值优先，读不到退回挂载快照。
 *
 * 纯函数，不需要宿主：喂进设置面那一行的 value 与挂载配置，比对产出的对象。
 * 两条已修的 bug 在这里钉住：judgeTimeoutMs 按后端给预算、脏值不能盖掉挂载值。
 */
import { resolveLive, valueOf } from '../config/settings.mjs'
import { makeChecker } from './fake-host.mjs'

const { check, done } = makeChecker()

/** apply() 挂载时算出来的那份快照。 */
const MOUNT = {
  judgeUrl: 'http://127.0.0.1:8765/judge',
  mode: 'auto',
  tiers: { low: 'low', high: 'high', max: 'max', fallback: 'low' },
}

// 没有设置面时，全部跟挂载配置
{
  const live = resolveLive(undefined, { enabled: false, judgeSource: 'jev', notify: 'off' }, MOUNT)
  check('挂载: enabled 跟配置', live.enabled, false)
  check('挂载: judgeSource 跟配置', live.judgeSource, 'jev')
  check('挂载: notify 跟配置', live.notify, 'off')
  check('挂载: 判定地址用挂载值', live.judgeUrl, MOUNT.judgeUrl)
  check('挂载: 模式用挂载值', live.mode, 'auto')
  check('挂载: 档位表带默认值', live.tiers, { low: 'low', high: 'high', max: 'max', fallback: 'low' })
}

// 设置面有值时盖过挂载配置
{
  const live = resolveLive({
    enabled: false,
    mode: 'manual',
    judgeSource: 'jev',
    judgeUrl: 'http://10.0.0.1:9000/judge',
    notify: 'always',
  }, {}, MOUNT)
  check('设置面: enabled', live.enabled, false)
  check('设置面: mode', live.mode, 'manual')
  check('设置面: judgeSource', live.judgeSource, 'jev')
  check('设置面: judgeUrl', live.judgeUrl, 'http://10.0.0.1:9000/judge')
  check('设置面: notify', live.notify, 'always')
}

// 脏值退回挂载配置，而不是把脏值原样透出去
{
  const live = resolveLive({ mode: 'paused', judgeSource: 'cloud', enabled: 'yes', judgeUrl: '' }, {}, MOUNT)
  check('脏值: 模式退回挂载值', live.mode, 'auto')
  check('脏值: 后端退回挂载配置', live.judgeSource, 'local')
  check('脏值: enabled 退回配置', live.enabled, true)
  check('脏值: 空地址退回挂载值', live.judgeUrl, MOUNT.judgeUrl)
}

// 判定预算：没配时按后端给，配了就按配的
{
  check('预算: 本地默认 6000', resolveLive(undefined, {}, MOUNT).judgeTimeoutMs, 6000)
  check('预算: Jev 默认 3000', resolveLive(undefined, { judgeSource: 'jev' }, MOUNT).judgeTimeoutMs, 3000)
  check('预算: 配了就按配的', resolveLive(undefined, { judgeTimeoutMs: 2000 }, MOUNT).judgeTimeoutMs, 2000)
  check('预算: 设置面写 0 也算配了', resolveLive({ judgeTimeoutMs: 0 }, {}, MOUNT).judgeTimeoutMs, 0)
  check('预算: 设置面字符串数字也认', resolveLive({ judgeTimeoutMs: '1500' }, {}, MOUNT).judgeTimeoutMs, 1500)
}

// 档位表三层：默认值 <- 挂载快照 <- 设置面
{
  const live = resolveLive({ tiers: { high: 'medium' } }, {}, MOUNT)
  check('档位: 设置面覆盖单项', live.tiers.high, 'medium')
  check('档位: 其余项保留', [live.tiers.low, live.tiers.max, live.tiers.fallback], ['low', 'max', 'low'])
}
{
  const live = resolveLive({ tiers: 'high' }, {}, MOUNT)
  check('档位: 设置面不是对象时用挂载值', live.tiers.high, 'high')
}
{
  const live = resolveLive(undefined, { tiers: { max: 'xhigh' } }, { judgeUrl: MOUNT.judgeUrl, mode: 'auto' })
  check('档位: 没有挂载档位表时按配置算', live.tiers.max, 'xhigh')
  check('档位: 缺项补默认值', live.tiers.low, 'low')
}

// Jev 那几项：空串当没填，数字字段认字符串
{
  const live = resolveLive({ jevUrl: '', jevModel: '', jevApiKeyEnv: '', jevConfidence: '0.85' }, {}, MOUNT)
  check('Jev: 空地址退回默认端点', live.jevUrl, 'https://api.typesafe.ai/v1/systemone')
  check('Jev: 空模型名退回默认', live.jevModel, 'jev-latest')
  check('Jev: 空凭据名退回默认', live.jevApiKeyEnv, 'TYPESAFE_API_KEY')
  check('Jev: 置信度接受字符串', live.jevConfidence, 0.85)
  check('Jev: 超时不配用默认', live.jevTimeoutMs, 12000)
}

// 归属口径：默认 true，设置面写 false 才改
{
  check('归属: 默认按插件写的', resolveLive(undefined, {}, MOUNT).legacyOwned, true)
  check('归属: 设置面写 false', resolveLive({ legacyOwned: false }, {}, MOUNT).legacyOwned, false)
  check('归属: 挂载配置写 false', resolveLive(undefined, { legacyOwned: false }, MOUNT).legacyOwned, false)
}

// volatile 字段在运行时是带 get() 的句柄
{
  check('句柄: 读一次拿当前值', valueOf({ get: () => 'manual' }, 'auto'), 'manual')
  check('句柄: get 返回 undefined 时用默认值', valueOf({ get: () => undefined }, 'auto'), 'auto')
  check('句柄: get 抛错时用默认值', valueOf({ get() { throw new Error('boom') } }, 'auto'), 'auto')
  check('句柄: 普通值原样返回', valueOf(3, 0), 3)
  check('句柄: 空值用默认值', valueOf(undefined, 'auto'), 'auto')
}

done()
