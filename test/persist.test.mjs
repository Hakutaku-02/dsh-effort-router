/**
 * 芯片的持久化与精确匹配。
 *
 * 两条要求：重启后芯片还能显示上次的档位；多会话共存时按会话精确取，不能拿别人的。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const home = mkdtempSync(join(tmpdir(), 'effort-router-persist-'))
process.env.ROUTER_EFFORT_HOME = home
process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

let judgeTier = 'high'
const judge = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: judgeTier }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

function fakeContext() {
  const handlers = new Map()
  const routes = []
  const state = { mode: 'auto', judgeSource: 'local', judgeUrl, notify: '', tiers: {} }
  return {
    handlers,
    routes,
    state,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
      if (name === 'settings') {
        return {
          describe() { return [{ ns: 'effort-router', value: { ...state } }] },
          async update(ns, patch) { Object.assign(state, patch) },
        }
      }
      if (name === 'llm') {
        return { async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } } } }
      }
      if (name === 'sessionProjections') {
        return { stateOf: () => ({ lastUsed: { provider: 'p', model: 'm' } }) }
      }
      return undefined
    },
    inject(services, fn) {
      if (services.includes('webServer')) {
        fn({ get: () => ({ register(entry) { routes.push(entry); return () => {} } }), effect(run) { run() } })
      }
    },
    effect(fn) { fn() },
  }
}

function call(route, method, body, url = '/') {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url,
      headers: { 'content-type': 'application/json' },
      on(event, fn) { listeners[event] = fn },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ code: res.statusCode, body: text === '' || text === undefined ? undefined : JSON.parse(text) }) },
    }
    route.handler(req, res)
    if (method === 'POST') {
      if (body !== undefined) listeners.data?.(JSON.stringify(body))
      listeners.end?.()
    }
  })
}

const lastOf = (ctx) => ctx.routes.find((entry) => entry.path === '/effort-router/last')
const agentOf = (id) => ({ session: { id, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } })

async function turnOf(ctx, agent, turn) {
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '改这段代码' }] } })
  return ctx.handlers.get('agent/request')({ agent, turn, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
}

// 第一轮：产生判定并落盘
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  await turnOf(ctx, agentOf('session-alpha'), 1)

  const disk = JSON.parse(readFileSync(join(home, 'last.json'), 'utf8'))
  check('落盘: 有记录', Object.keys(disk.records).length, 1)
  check('落盘: 记的是这个会话', Object.keys(disk.records)[0], 'session-alpha')
  check('落盘: 档位与强度', [disk.records['session-alpha'].tier, disk.records['session-alpha'].effort], ['high', 'high'])
}

// 重启：新实例一启动就能读到，不用等下一次判定
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const got = await call(lastOf(ctx), 'GET', undefined, '/')
  check('重启: 芯片立即有数据', got.body.records.length, 1)
  check('重启: 会话对得上', got.body.records[0].session, 'session-alpha')
  check('重启: 档位没丢', got.body.records[0].tier, 'high')
}

// 精确匹配：前端给裸 uuid，宿主存的是带 session- 前缀的 id
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })

  await turnOf(ctx, agentOf('session-beta-one'), 1)
  await turnOf(ctx, agentOf('session-beta-two'), 1)

  const bare = await call(lastOf(ctx), 'GET', undefined, '?session=beta-one')
  check('匹配: 裸 uuid 命中带前缀的那条', bare.body.current?.session, 'session-beta-one')

  const prefixed = await call(lastOf(ctx), 'GET', undefined, '?session=session-beta-two')
  check('匹配: 带前缀也能命中', prefixed.body.current?.session, 'session-beta-two')

  check('匹配: 记录下前端传的参数', bare.body.lastQuery, 'beta-one')

  const missing = await call(lastOf(ctx), 'GET', undefined, '?session=beta-three')
  check('匹配: 没有的会话给 null', missing.body.current, null)
}

// 值没变就不重写：同一会话连续两轮判定相同，落盘的 at 保持第一次的时间
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  await turnOf(ctx, agentOf('session-dedupe'), 1)
  const first = JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records['session-dedupe'].at
  await turnOf(ctx, agentOf('session-dedupe'), 2)
  const second = JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records['session-dedupe'].at
  check('去重: 同值不重写', second, first)
}

// 多实例合并：后启动的实例只补自己那行，不把别人的记录整表抹掉
{
  const before = JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  await turnOf(ctx, agentOf('session-later'), 1)
  const after = JSON.parse(readFileSync(join(home, 'last.json'), 'utf8')).records
  check('合并: 新会话写进去了', Object.keys(after).includes('session-later'), true)
  check('合并: 老会话还在', Object.keys(after).includes('session-dedupe'), true)
  check('合并: 条数只增不减', Object.keys(after).length >= Object.keys(before).length, true)
}

// 跨档变化要留下上一档，芯片才显示得出 low → high
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const agent = agentOf('session-cross')
  const readCurrent = async () => (await call(lastOf(ctx), 'GET', undefined, '?session=session-cross')).body.current

  await turnOf(ctx, agent, 1)
  check('跨档: 首轮没有上一档', (await readCurrent()).prevTier, null)

  judgeTier = 'low'
  await turnOf(ctx, agent, 2)
  const afterChange = await readCurrent()
  check('跨档: 记下上一档', afterChange.prevTier, 'high')
  check('跨档: 当前档是新值', afterChange.tier, 'low')

  // 稳定在同一档：上一档对齐成当前，表示已经不再变化
  await turnOf(ctx, agent, 3)
  check('稳定: 上一档对齐当前', (await readCurrent()).prevTier, 'low')

  judgeTier = 'high'
}

// 同一轮里 agent/request 会多次写记录，不能把刚记下的上一档抹掉
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const agent = agentOf('session-sameturn')
  const readCurrent = async () => (await call(lastOf(ctx), 'GET', undefined, '?session=session-sameturn')).body.current

  await turnOf(ctx, agent, 1)
  judgeTier = 'low'
  await turnOf(ctx, agent, 2)
  check('同轮: 先记下跨档', (await readCurrent()).prevTier, 'high')

  // 同一 turn 再来一次，模拟工具步骤
  await turnOf(ctx, agent, 2)
  const after = await readCurrent()
  check('同轮重复: 上一档没被抹掉', after.prevTier, 'high')
  check('同轮重复: 当前档不变', after.tier, 'low')

  judgeTier = 'high'
}

// 落盘文件坏掉时，插件照样挂得上，只是历史为空
{
  writeFileSync(join(home, 'last.json'), '{ this is not json')
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const got = await call(lastOf(ctx), 'GET', undefined, '/')
  check('损坏文件: 不抛错', got.code, 200)
  check('损坏文件: 当空表', got.body.records, [])
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 200))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
