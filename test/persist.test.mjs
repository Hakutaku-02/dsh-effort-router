/**
 * 芯片的持久化与精确匹配。
 *
 * 两条要求：重启后芯片还能显示上次的档位；多会话共存时按会话精确取，不能拿别人的。
 * 0.2.2 起判定在 hold 里跑，一条用户消息对应一次 hold、一条记录；轮次号要到 pre-step
 * 补判时才拿得到，所以落盘里 turn 只在补判记录上有值。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { makeAgent, makeChecker, makeContext } from './fake-host.mjs'

const home = mkdtempSync(join(tmpdir(), 'effort-router-persist-'))
process.env.ROUTER_EFFORT_HOME = home
process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

const { check, done } = makeChecker()

let judgeTier = 'high'
let judgeCalls = 0
const judge = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health') {
    res.end(JSON.stringify({ protocol: 'finetuned' }))
    return
  }
  judgeCalls += 1
  res.end(JSON.stringify({ tier: judgeTier }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

const fresh = () => {
  const ctx = makeContext()
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, judgeUrl, startupWaitMs: 0 })
  return ctx
}

const agentOf = (id, options = {}) => makeAgent({ id, provider: 'p', model: 'm', reasoningEffort: 'low', ...options })

let seq = 0
const newMessage = (text = '改这段代码') => {
  seq += 1
  return { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 跑一条用户消息的 hold；返回这条消息，pre-step 复用判定时要用同一个 id。 */
async function holdOf(ctx, agent, message = newMessage()) {
  ctx.emit('agent/inbox/inserted', { agent, message })
  await agent.settled
  return message
}

/** 触发一次 pre-step。 */
function preStep(ctx, agent, messages, turn = 1) {
  const handler = ctx.handlers.get('agent/pre-step')
  return handler(
    {
      agent,
      messages,
      turn,
      step: 1,
      signal: new AbortController().signal,
      modelSelection: agent.model.current(),
    },
    async () => ({ kind: 'enter', messages }),
  )
}

/**
 * 调一条路由并把查询串带上。
 * fake-host 的 callRoute 把 path 同时当路由键和 req.url，带 ?session= 就找不到路由。
 */
function getRoute(ctx, path, url = path) {
  const handler = ctx.routes.get(path)
  if (handler === undefined) throw new Error('没有注册路由 ' + path)
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolve({ code: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) })
      },
    }
    handler({ method: 'GET', url, headers: {} }, res)
  })
}

const lastOf = async (ctx, session) => {
  const query = session === undefined ? '/effort-router/last' : `/effort-router/last?session=${session}`
  return (await getRoute(ctx, '/effort-router/last', query)).body
}
const diskRow = (key) => JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records[key]
const diskRecords = () => JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records

// 第一轮：产生判定并落盘，字段齐全
{
  const ctx = fresh()
  await holdOf(ctx, agentOf('session-alpha'))

  const records = diskRecords()
  const row = diskRow('session-alpha')
  check('落盘: 有记录', Object.keys(records).length, 1)
  check('落盘: 记的是这个会话', Object.keys(records)[0], 'session-alpha')
  check('落盘: 档位与强度', [row.tier, row.effort], ['high', 'high'])
  check('落盘: 强度是我们写的', row.owned, true)
  check('落盘: 带时间戳', typeof row.at, 'number')
  check('落盘: 首轮没有上一档', row.prevTier, null)
  // hold 阶段还不知道轮次号：turn 由 pre-step 补判时才有
  check('落盘: hold 记录没有轮次号', row.turn, undefined)
}

// 重启：新实例一启动就能读到，不用等下一次判定
{
  const ctx = fresh()
  const got = await lastOf(ctx)
  check('重启: 芯片立即有数据', got.records.length, 1)
  check('重启: 会话对得上', got.records[0].session, 'session-alpha')
  check('重启: 档位没丢', got.records[0].tier, 'high')
  check('重启: 强度没丢', got.records[0].effort, 'high')
}

// 精确匹配：前端给裸 uuid，宿主存的是带 session- 前缀的 id
{
  const ctx = fresh()

  await holdOf(ctx, agentOf('session-beta-one'))
  await holdOf(ctx, agentOf('session-beta-two'))

  const bare = await lastOf(ctx, 'beta-one')
  check('匹配: 裸 uuid 命中带前缀的那条', bare.current?.session, 'session-beta-one')

  const prefixed = await lastOf(ctx, 'session-beta-two')
  check('匹配: 带前缀也能命中', prefixed.current?.session, 'session-beta-two')

  check('匹配: 记录下前端传的参数', bare.lastQuery, 'beta-one')

  const missing = await lastOf(ctx, 'beta-three')
  check('匹配: 没有的会话给 null', missing.current, null)
}

// 值没变就不重写：同一会话连续两轮判定相同，落盘的 at 保持第一次的时间
{
  const ctx = fresh()
  const agent = agentOf('session-dedupe')
  await holdOf(ctx, agent)
  const first = diskRow('session-dedupe').at
  await holdOf(ctx, agent)
  const second = diskRow('session-dedupe').at
  check('去重: 同值不重写', second, first)
}

// 多实例合并：后启动的实例只补自己那行，不把别人的记录整表抹掉
{
  const before = diskRecords()
  const ctx = fresh()
  await holdOf(ctx, agentOf('session-later'))
  const after = diskRecords()
  check('合并: 新会话写进去了', Object.keys(after).includes('session-later'), true)
  check('合并: 老会话还在', Object.keys(after).includes('session-dedupe'), true)
  check('合并: 条数只增不减', Object.keys(after).length >= Object.keys(before).length, true)
}

// 跨档变化要留下上一档，芯片才显示得出 low → high
{
  const ctx = fresh()
  const agent = agentOf('session-cross')
  const readCurrent = async () => (await lastOf(ctx, 'session-cross')).current

  await holdOf(ctx, agent)
  check('跨档: 首轮没有上一档', (await readCurrent()).prevTier, null)

  judgeTier = 'low'
  await holdOf(ctx, agent)
  const afterChange = await readCurrent()
  check('跨档: 记下上一档', afterChange.prevTier, 'high')
  check('跨档: 当前档是新值', afterChange.tier, 'low')

  // 稳定在同一档：上一档对齐成当前，表示已经不再变化
  await holdOf(ctx, agent)
  check('稳定: 上一档对齐当前', (await readCurrent()).prevTier, 'low')

  judgeTier = 'high'
}

// 用户自己钉住的强度原样写回时不算我们的：下一轮不能因此把它降下去
{
  const ctx = fresh()
  // 会话里记下的是 high，agent 默认强度是 low：两者不同才算「用户自己拧过」。
  const agent = agentOf('session-pinned', { recorded: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  judgeTier = 'low'
  await holdOf(ctx, agent)
  const row = diskRow('session-pinned')
  check('归属: 钉住的强度没被降', agent.model.current()?.reasoningEffort, 'high')
  check('归属: 记录里档位是判定档', row.tier, 'low')
  check('归属: 记录里强度仍是用户钉的', row.effort, 'high')
  check('归属: 原样写回不算我们写的', row.owned, false)
  judgeTier = 'high'
}

// hold 已经判过的轮次：pre-step 不再重复写记录，否则同一轮的重复写会把 prevTier 抹平
{
  const ctx = fresh()
  const agent = agentOf('session-no-dup')
  const message = await holdOf(ctx, agent)
  const first = (await lastOf(ctx, 'session-no-dup')).current
  const before = judgeCalls
  // 换个档位：如果 pre-step 真的又判又写，这条记录会跟着变
  judgeTier = 'low'
  await preStep(ctx, agent, [message])
  const after = (await lastOf(ctx, 'session-no-dup')).current
  check('同轮: pre-step 不再问判定', judgeCalls - before, 0)
  check('同轮: 档位没被改写', after.tier, first.tier)
  check('同轮: 上一档没被抹平', after.prevTier, first.prevTier)
  check('同轮: 时间戳没被刷新', after.at, first.at)
  judgeTier = 'high'
}

// 运行中插话没走 hold：pre-step 补判写入，这条记录带轮次号
{
  const ctx = fresh()
  const agent = agentOf('session-turn')
  agent.setRunning()
  const message = await holdOf(ctx, agent)
  check('轮次: 运行中不抢 hold', (await lastOf(ctx, 'session-turn')).current, null)

  await preStep(ctx, agent, [message], 3)
  const row = diskRow('session-turn')
  check('轮次: 补判写入', [row.tier, row.effort], ['high', 'high'])
  check('轮次: 记下轮次号', row.turn, 3)
  check('轮次: 补判写入算我们的', row.owned, true)
}

// 落盘文件坏掉时，插件照样挂得上，只是历史为空
{
  writeFileSync(join(home, 'last.json'), '{ this is not json')
  const ctx = fresh()
  const got = await getRoute(ctx, '/effort-router/last', '/effort-router/last')
  check('损坏文件: 不抛错', got.code, 200)
  check('损坏文件: 当空表', got.body.records, [])
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 200))

done()
