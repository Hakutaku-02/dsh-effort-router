/**
 * 旧版记录（0.4.0 之前的插件写的 last.json）在新版归属判断下的行为。
 *
 * 旧记录没有 owned，也没有 baseline：插件当年每轮都写会话选择，记录的 effort 就是它写的值，
 * 所以缺 baseline 的记录按「插件自己写的」迁移。这条口径由 legacyOwned 控制，设成 false
 * 就回到「一律当用户下限」的保守行为。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, migrateRecord } from '../index.js'
import { makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = tmpdir() + '/router-effort-test.log'
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

const { check, done } = makeChecker()

let judgeTier = 'low'
const judge = createServer((req, res) => {
  if (req.url !== '/judge') {
    res.statusCode = 404
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ tier: judgeTier }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = 'http://127.0.0.1:' + judge.address().port + '/judge'

const message = {
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text: '把这段代码重构一下' }],
  source: { kind: 'user' },
}

/** 造一个只含 last.json 的插件数据目录，并把它指给本次挂载。 */
function seed(records, version = 1) {
  const home = mkdtempSync(join(tmpdir(), 'effort-router-legacy-'))
  process.env.ROUTER_EFFORT_HOME = home
  if (records !== undefined) {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'last.json'), JSON.stringify({ version, records }, null, 2))
  }
  return home
}

function diskRecords(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'last.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** 挂载插件；settings 覆盖「热改」字段，等价于设置页里的值。 */
function mount(home, settings = {}) {
  const ctx = makeContext({ settings: { tiers: {}, notify: 'off', ...settings } })
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, judgeUrl })
  return ctx
}

/** 跑一条用户消息的 hold，返回写完之后的强度。 */
async function hold(ctx, agent, id = 'm1') {
  ctx.emit('agent/inbox/inserted', { agent, message: { ...message, id } })
  await agent.settled
  return agent.model.current()?.reasoningEffort
}

/** 会话里已经记着 high（不是 agent 默认值 low），才谈得上「能不能降」。 */
const agentHigh = (id) => makeAgent({
  id,
  provider: 'p',
  model: 'm',
  reasoningEffort: 'low',
  recorded: { provider: 'p', model: 'm', reasoningEffort: 'high' },
})

const legacyRow = (over = {}) => ({
  tier: 'high',
  effort: 'high',
  provider: 'p',
  model: 'm',
  at: Date.now() - 60000,
  prevTier: null,
  ...over,
})

// 一、版本 1 记录（没有 owned）：迁移成插件自己写的，判定更低时能降
{
  const home = seed({ 'session-legacy': legacyRow(), 'session-untouched': legacyRow({ effort: 'max', tier: 'max' }) })
  const ctx = mount(home)
  judgeTier = 'low'
  const agent = agentHigh('session-legacy')
  check('旧记录: 能降档', await hold(ctx, agent), 'low')
  const body = diskRecords(home)
  const row = body.records['session-legacy']
  check('旧记录: 落盘升到版本 2', row.schemaVersion, 2)
  check('旧记录: 容器版本也是 2', body.version, 2)
  check('旧记录: 记下写之前的强度', row.baseline, 'high')
  check('旧记录: 记下判定落位', row.picked, 'low')
  check('旧记录: 归属是我们', row.owned, true)
  const untouched = body.records['session-untouched']
  check('旧记录: 没碰过的也迁移', untouched.schemaVersion, 2)
  check('旧记录: 迁移补 baseline', untouched.baseline, 'max')
  check('旧记录: 迁移补 picked', untouched.picked, 'max')
  check('旧记录: 迁移后归属是我们', untouched.owned, true)
}

// 二、新版早期写出的半残记录（有 owned: false，没有 baseline）：缺证据，按我们写的处理
{
  const home = seed({ 'session-half': legacyRow({ owned: false, tier: 'low' }) })
  const ctx = mount(home)
  judgeTier = 'low'
  const agent = agentHigh('session-half')
  check('半残记录: 能降档', await hold(ctx, agent), 'low')
}

// 三、判定本来就想要当前强度（picked === baseline）：算我们的，下一轮能降
{
  const home = seed({})
  const ctx = mount(home)
  const agent = agentHigh('session-adopt')
  judgeTier = 'high'
  check('认领: 判定与现状一致时不动值', await hold(ctx, agent, 'm1'), 'high')
  check('认领: 记成我们的', diskRecords(home).records['session-adopt'].owned, true)
  judgeTier = 'low'
  check('认领: 下一轮能降', await hold(ctx, agent, 'm2'), 'low')
}

// 四、记录说「当年被下限挡住」：仍然只升不降，直到判定高过它
{
  const floored = {
    schemaVersion: 2,
    tier: 'low',
    picked: 'low',
    baseline: 'high',
    effort: 'high',
    provider: 'p',
    model: 'm',
    at: Date.now() - 60000,
    prevTier: 'high',
    owned: false,
    floor: 'high',
  }
  const home = seed({ 'session-floor': floored }, 2)
  const ctx = mount(home)
  const agent = agentHigh('session-floor')
  judgeTier = 'low'
  check('下限: 判低不降', await hold(ctx, agent, 'm1'), 'high')
  const row = diskRecords(home).records['session-floor']
  check('下限: 记下挡住的值', row.floor, 'high')
  check('下限: 仍不算我们的', row.owned, false)
  judgeTier = 'high'
  await hold(ctx, agent, 'm2')
  check('下限: 判定与现状一致后认领', diskRecords(home).records['session-floor'].owned, true)
  judgeTier = 'low'
  check('下限: 认领之后能降', await hold(ctx, agent, 'm3'), 'low')
}

// 五、用户在插件写过之后手动改过强度：只升不降，floor 跟着变成新值
{
  const home = seed({ 'session-user': legacyRow({ effort: 'max', tier: 'max' }) })
  const ctx = mount(home)
  judgeTier = 'low'
  const agent = makeAgent({
    id: 'session-user',
    provider: 'p',
    model: 'm',
    reasoningEffort: 'low',
    recorded: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
  check('用户改过: 判低不降', await hold(ctx, agent), 'high')
  const row = diskRecords(home).records['session-user']
  check('用户改过: 挡住的值记成当前值', row.floor, 'high')
  check('用户改过: 不算我们的', row.owned, false)
}

// 六、legacyOwned: false：回到保守口径，旧记录一律当用户下限
{
  const home = seed({ 'session-conservative': legacyRow() })
  const ctx = mount(home, { legacyOwned: false })
  judgeTier = 'low'
  const agent = agentHigh('session-conservative')
  check('保守口径: 判低不降', await hold(ctx, agent), 'high')
  const row = diskRecords(home).records['session-conservative']
  check('保守口径: 迁移后仍不是我们的', row.owned, false)
  check('保守口径: 仍然落版本 2', row.schemaVersion, 2)
}

// 七、回退读：版本 2 记录里旧字段名与语义都还在，0.4.0 的解析认得
{
  const home = seed({ 'session-fallback': legacyRow() })
  const ctx = mount(home)
  judgeTier = 'low'
  await hold(ctx, agentHigh('session-fallback'))
  const row = diskRecords(home).records['session-fallback']
  // 0.4.0 只读这六个字段，多出来的字段会被忽略
  const oldView = {
    tier: row.tier,
    effort: row.effort,
    provider: row.provider,
    model: row.model,
    at: row.at,
    prevTier: row.prevTier,
  }
  check('回退: 旧字段齐全', Object.keys(oldView).filter((key) => oldView[key] === undefined), [])
  check('回退: 档位可读', typeof row.tier, 'string')
  check('回退: 强度可读', typeof row.effort, 'string')
}

// 八、迁移函数本身：幂等，且不改旧字段
{
  const legacy = { tier: 'high', effort: 'high', provider: 'p', model: 'm', at: 1, prevTier: null }
  const once = migrateRecord(legacy, true)
  const twice = migrateRecord(once, true)
  check('迁移: 幂等', twice, once)
  check('迁移: 旧字段原样', [once.tier, once.effort, once.provider, once.model, once.at], ['high', 'high', 'p', 'm', 1])
  check('迁移: 没 baseline 时按插件写的', once.owned, true)
  check('迁移: 保守口径给我用户下限', migrateRecord(legacy, false).owned, false)
  check('迁移: 有 baseline 时看原 owned', migrateRecord({ ...legacy, schemaVersion: 1, baseline: 'high', owned: false }, true).owned, false)
  check('迁移: 已是版本 2 原样返回', migrateRecord({ schemaVersion: 2, tier: 'low' }, true), { schemaVersion: 2, tier: 'low' })
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 50))
done()