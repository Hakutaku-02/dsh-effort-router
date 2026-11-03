/**
 * 档位的动态读取：新加的 provider / model 第一次被选中时就要按它自己的档位工作。
 *
 * 这里盯的是缓存的三条规则：命中要有寿命、解析失败不缓存、provider 拓扑变化立刻作废。
 */
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const judge = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'high' }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

const FULL = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }]

function fakeContext(options = {}) {
  const handlers = new Map()
  const routes = []
  const state = { resolveCalls: 0, efforts: options.efforts === undefined ? FULL : options.efforts }
  return {
    handlers,
    routes,
    state,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
      if (name === 'llm') {
        return {
          async resolveModelInfo(provider, model) {
            state.resolveCalls += 1
            state.lastKey = `${provider}/${model}`
            return state.efforts === null ? {} : { reasoning: { efforts: state.efforts } }
          },
        }
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

function agentOf(id, provider = 'p', model = 'm') {
  return { session: { id, requestHeader: () => ({ config: { provider, model } }) } }
}

async function turnOf(ctx, agent, turn, base = {}) {
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '改这段代码' }] } })
  return ctx.handlers.get('agent/request')({ agent, turn, step: 1 },
    async () => ({ provider: base.provider ?? 'p', model: base.model ?? 'm', reasoningEffort: 'low' }))
}

/** 调一条已注册的路由；url 带查询串。 */
function call(route, method, body, url = '/') {
  return new Promise((resolve) => {
    const listeners = {}
    const req = { method, url, on(event, fn) { listeners[event] = fn }, destroy() {} }
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

// 新模型第一次出现：读到它自己的档位并改强度
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const config = await turnOf(ctx, agentOf('session-new', 'fresh-provider', 'fresh-model'), 1,
    { provider: 'fresh-provider', model: 'fresh-model' })
  check('新模型: 解析的是它自己', ctx.state.lastKey, 'fresh-provider/fresh-model')
  check('新模型: 判定 high 落到 high', config.reasoningEffort, 'high')
  check('新模型: 解析一次', ctx.state.resolveCalls, 1)
}

// 缓存命中：同一模型第二个 turn 不再解析
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const agent = agentOf('session-hit')
  await turnOf(ctx, agent, 1)
  await turnOf(ctx, agent, 2)
  check('缓存: 只解析一次', ctx.state.resolveCalls, 1)
}

// 解析不到档位：不缓存，下一轮重试
{
  const ctx = fakeContext({ efforts: null })
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const agent = agentOf('session-empty')
  const first = await turnOf(ctx, agent, 1)
  check('无档位: 不改强度', first.reasoningEffort, 'low')
  await turnOf(ctx, agent, 2)
  check('无档位: 没被缓存住', ctx.state.resolveCalls, 2)

  // 模型后来注册好了，下一轮就能用上
  ctx.state.efforts = [{ id: 'low' }, { id: 'high' }]
  const third = await turnOf(ctx, agent, 3)
  check('无档位: 恢复后能用', third.reasoningEffort, 'high')
}

// provider 拓扑变化清缓存：用户在 Models 页改了档位，下一轮读新的
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const agent = agentOf('session-refresh')
  await turnOf(ctx, agent, 1)
  check('刷新: 首次解析', ctx.state.resolveCalls, 1)

  ctx.state.efforts = [{ id: 'low' }, { id: 'medium' }]
  ctx.handlers.get('llm/adapters-updated')()
  const config = await turnOf(ctx, agent, 2)
  check('刷新: 事件后重新解析', ctx.state.resolveCalls, 2)
  // 判定 high → 目标 high，新列表最高只有 medium，落到 medium
  check('刷新: 用上新档位', config.reasoningEffort, 'medium')
}

// 缓存寿命：过期后重新解析
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false, modelInfoTtlMs: 20 })
  const agent = agentOf('session-ttl')
  await turnOf(ctx, agent, 1)
  check('寿命: 首次解析', ctx.state.resolveCalls, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await turnOf(ctx, agent, 2)
  check('寿命: 过期后重新解析', ctx.state.resolveCalls, 2)
}

// 诊断接口：问出某个 model 现在解析到的档位
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const route = ctx.routes.find((entry) => entry.path === '/effort-router/models')
  const ok = await call(route, 'GET', undefined, '?provider=fresh&model=thing')
  check('诊断: 返回档位', ok.body.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  check('诊断: 回显路由', `${ok.body.provider}/${ok.body.model}`, 'fresh/thing')

  const bad = await call(route, 'GET', undefined, '?provider=fresh')
  check('诊断: 缺参数回 400', bad.code, 400)
}

// 芯片的数据源：每个会话最近一次判定
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const route = ctx.routes.find((entry) => entry.path === '/effort-router/last')

  const before = await call(route, 'GET', undefined, '/')
  check('芯片: 初始为空', before.body.records, [])

  await turnOf(ctx, agentOf('session-chip'), 1)
  const after = await call(route, 'GET', undefined, '?session=session-chip')
  check('芯片: 有本会话记录', after.body.current?.session, 'session-chip')
  check('芯片: 记的是判定档位', after.body.current?.tier, 'high')
  check('芯片: 记的是写入强度', after.body.current?.effort, 'high')
  check('芯片: 记了模型', `${after.body.current?.provider}/${after.body.current?.model}`, 'p/m')
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 200))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
