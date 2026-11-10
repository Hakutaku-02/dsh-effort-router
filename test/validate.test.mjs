/**
 * 设置页提交的补丁校验。
 *
 * 纯函数，输入来路不明的对象：认不出的字段丢掉，字段本身不合法就整单拒掉并给一句
 * 能显示在页面上的原因。
 */
import { validatePatch } from '../config/validate.mjs'
import { makeChecker } from './fake-host.mjs'

const { check, done } = makeChecker()

/** 只关心「过没过」的用例用这个。 */
const okOf = (patch) => {
  const outcome = validatePatch(patch)
  return outcome.ok === true ? 'ok' : outcome.detail
}

// 空补丁与不认识的字段
{
  check('空补丁: 拒绝', validatePatch({}).ok, false)
  check('空补丁: 说明原因', validatePatch({}).detail, '没有可写的字段')
  check('陌生字段: 丢弃后拒绝', validatePatch({ theme: 'dark' }).detail, '没有可写的字段')
  check('陌生字段: 与认识的字段共存时只留认识的', validatePatch({ mode: 'manual', theme: 'dark' }).clean, { mode: 'manual' })
}

// 开关与枚举
{
  check('开关: true', validatePatch({ enabled: true }).clean, { enabled: true })
  check('开关: false', validatePatch({ enabled: false }).clean, { enabled: false })
  check('开关: 非布尔丢弃', okOf({ enabled: 'yes' }), '没有可写的字段')
  check('模式: manual', validatePatch({ mode: 'manual' }).clean, { mode: 'manual' })
  check('模式: 不认识的丢弃', okOf({ mode: 'paused' }), '没有可写的字段')
  check('后端: jev', validatePatch({ judgeSource: 'jev' }).clean, { judgeSource: 'jev' })
  check('后端: 不认识的丢弃', okOf({ judgeSource: 'cloud' }), '没有可写的字段')
}

// 地址：只收 http(s)，接受规范化
{
  check('地址: 接受 http', validatePatch({ judgeUrl: 'http://127.0.0.1:8765/judge' }).clean.judgeUrl, 'http://127.0.0.1:8765/judge')
  check('地址: 补全尾斜杠', validatePatch({ judgeUrl: 'http://127.0.0.1:8765' }).clean.judgeUrl, 'http://127.0.0.1:8765/')
  check('地址: 拒绝 file scheme', okOf({ judgeUrl: 'file:///etc/passwd' }), 'judgeUrl 必须是 http(s) 地址')
  check('地址: 拒绝空串以外的脏值', okOf({ judgeUrl: 'not a url' }), 'judgeUrl 必须是 http(s) 地址')
  check('地址: Jev 同样只收 http(s)', okOf({ jevUrl: 'ftp://x/y' }), 'jevUrl 必须是 http(s) 地址')
}

// 提示与归属
{
  check('提示: off', validatePatch({ notify: 'off' }).clean, { notify: 'off' })
  check('提示: always', validatePatch({ notify: 'always' }).clean, { notify: 'always' })
  check('提示: 空串表示变化时提示', validatePatch({ notify: '' }).clean, { notify: '' })
  check('提示: 不认识的丢弃', okOf({ notify: 'loud' }), '没有可写的字段')
  check('归属: 布尔接受', validatePatch({ legacyOwned: false }).clean, { legacyOwned: false })
}

// 凭据名与置信度
{
  check('凭据名: 合法', validatePatch({ jevApiKeyEnv: 'TYPESAFE_API_KEY' }).clean, { jevApiKeyEnv: 'TYPESAFE_API_KEY' })
  check('凭据名: 数字开头拒绝', okOf({ jevApiKeyEnv: '2FA_KEY' }), '凭据名只能包含字母、数字、下划线，且不能以数字开头')
  check('凭据名: 带横线拒绝', okOf({ jevApiKeyEnv: 'TYPE-SAFE' }), '凭据名只能包含字母、数字、下划线，且不能以数字开头')
  check('置信度: 0 与 1 都收', [validatePatch({ jevConfidence: 0 }).clean.jevConfidence, validatePatch({ jevConfidence: 1 }).clean.jevConfidence], [0, 1])
  check('置信度: 字符串数字收', validatePatch({ jevConfidence: '0.7' }).clean.jevConfidence, 0.7)
  check('置信度: 越界拒绝', okOf({ jevConfidence: 1.5 }), 'jevConfidence 必须在 0 到 1 之间')
  check('置信度: 非数字拒绝', okOf({ jevConfidence: 'high' }), 'jevConfidence 必须在 0 到 1 之间')
}

// 档位表：只认已知强度名，只写认识的键
{
  check('档位: 单项', validatePatch({ tiers: { high: 'medium' } }).clean, { tiers: { high: 'medium' } })
  check('档位: 多项', validatePatch({ tiers: { low: 'minimal', max: 'xhigh' } }).clean, { tiers: { low: 'minimal', max: 'xhigh' } })
  check('档位: 不认识的强度名整单拒', okOf({ tiers: { max: 'turbo' } }), '档位 max 的强度名不认识：turbo')
  check('档位: 空对象不写', okOf({ tiers: {} }), '没有可写的字段')
  check('档位: 非对象丢弃', okOf({ tiers: 'max' }), '没有可写的字段')
}

// 组合：一单里既有认识的也有坏值，坏值优先报出来
{
  check('组合: 坏值让整单失败', okOf({ mode: 'manual', jevConfidence: 2 }), 'jevConfidence 必须在 0 到 1 之间')
  check('组合: 全对时一次写全', validatePatch({ mode: 'manual', notify: 'off', tiers: { low: 'low' } }).clean,
    { mode: 'manual', notify: 'off', tiers: { low: 'low' } })
}

done()
