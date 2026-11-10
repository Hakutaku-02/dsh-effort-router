/**
 * 浏览器半边的显示规则：路由开关关掉时，输入框旁的档位芯片整个不出现。
 *
 * 这里不起 DOM，也不装 react：client.js 是 client module system 的工厂 bundle，
 * 用假的 __ModuleLoader__ 拿到工厂、给个最小 react 替身，只测 chipView 这个纯函数。
 */
import { DEFAULT_TIERS as HOST_DEFAULT_TIERS, TIER_KEYS as HOST_TIER_KEYS } from '../config/settings.mjs'
import { strengthOf } from '../effort.mjs'
import { makeChecker } from './fake-host.mjs'

const { check, done } = makeChecker()

// 假 react：chipView 不调用任何 hook，能过工厂就算够。
const React = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(input) {
      definition = input
    },
  },
}
await import('../client.js')
if (definition === undefined) throw new Error('client.js 没有注册模块')
const mod = definition.factory((name) => (name === 'react' ? React : {}))
const chipView = mod.chipView

const record = (over = {}) => ({
  session: 'session-1',
  tier: 'low',
  effort: 'low',
  provider: 'tokenflux',
  model: 'dpsk/deepseek-flash',
  prevTier: 'max',
  ...over,
})

check('导出: chipView 可用', typeof chipView, 'function')
check('导出: 名字没变', mod.name, 'effort-router-client')

// 开关关掉：一块也不渲染
check('关掉: 不显示', chipView({ enabled: false, records: [record()], current: record() }), null)
check('关掉: 没记录也不显示', chipView({ enabled: false, records: [], current: null }), null)
check('关掉: 缺 records 也不显示', chipView({ enabled: false }), null)

// 开关开着：正常显示
check('开着: 本会话记录', chipView({ enabled: true, records: [record()], current: record() }), {
  label: 'max → low',
  detail: 'low → low（tokenflux/dpsk/deepseek-flash）',
})

// 本会话没有记录时退到最近一条
check('开着: 退到最近一条', chipView({ enabled: true, records: [record({ session: 'other', tier: 'high', prevTier: 'low', effort: 'high' })], current: null }), {
  label: 'low → high',
  detail: 'high → high（tokenflux/dpsk/deepseek-flash）',
})

// 一条记录都没有：占位，位置不跳
check('空表: 显示 Default', chipView({ enabled: true, records: [], current: null }), { label: 'Default', detail: '暂无判定' })

// 上一轮没有档位
check('缺 prevTier: 左边 Default', chipView({ enabled: true, records: [], current: record({ prevTier: null }) }), {
  label: 'Default → low',
  detail: 'low → low（tokenflux/dpsk/deepseek-flash）',
})

// 老版本宿主没发 enabled：当作开着，避免升级瞬间芯片消失
check('缺 enabled: 当作开着', chipView({ records: [], current: record() }), {
  label: 'max → low',
  detail: 'low → low（tokenflux/dpsk/deepseek-flash）',
})

// 响应不是对象：不要炸
check('异常响应: 显示 Default', chipView(null), { label: 'Default', detail: '暂无判定' })

// 档位词汇两边各存一份：宿主侧在 config/settings.mjs，浏览器侧在 bundle 里。
// 任一边加了强度名而另一边没跟，这里会红。
check('两侧一致: 档位键', mod.TIER_KEYS, HOST_TIER_KEYS)
check('两侧一致: 默认落点', mod.DEFAULT_TIERS, HOST_DEFAULT_TIERS)
check('两侧一致: 强度词汇都被宿主认识', mod.EFFORTS.map((id) => strengthOf(id) !== undefined), mod.EFFORTS.map(() => true))
check('两侧一致: 强度词汇按由弱到强排', mod.EFFORTS.map((id) => strengthOf(id)), [...mod.EFFORTS.keys()])
check('两侧一致: 下拉里没有 off', mod.EFFORTS.includes('off'), true)

done()