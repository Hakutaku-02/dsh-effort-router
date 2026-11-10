/**
 * 在真的 cordis 上下文里跑一遍：服务注册、事件瀑布、提示插入。
 *
 * 0.2.2 的时序：强度在 agent/inbox/inserted 的 hold 里用 agent.model.select() 写进会话选择；
 * pre-step 只补一条 model-selection 提示，模型从 payload.modelSelection 里读。所以这里先
 * emit inserted 等 hold 跑完，再走 ctx.waterfall('agent/pre-step')。
 *
 * 需要 DSH 安装目录。默认用本机安装路径，也可以用 DSH_ROOT 指定：
 *   DSH_ROOT="C:/.../DeepSeek Harness/resources/app/dsh" npm run test:cordis
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { makeAgent, makeChecker } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

// 默认按 Windows 的安装位置拼，不写死用户目录：换台机器/换个账户都能对上，对不上就跳过。
const root = process.env.DSH_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app/dsh')
const cordisEntry = join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')
if (!existsSync(cordisEntry)) {
  console.log(`跳过：找不到 cordis（${cordisEntry}）。用 DSH_ROOT 指向 DSH 安装目录后重跑。`)
  process.exit(0)
}

const { check, done } = makeChecker()
const { Context } = await import(pathToFileURL(cordisEntry).href)

const judge = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ tier: 'max' }))
  })
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

const ctx = new Context()
const routes = []
ctx.provide('webServer', {
  register(route) {
    routes.push(route)
    return () => {}
  },
})
ctx.provide('llm', {
  async resolveModelInfo() {
    return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }
  },
})
ctx.plugin({ name: 'effort-router', apply }, { mode: 'auto', autoStart: false, provision: false, judgeUrl })
await new Promise((resolve) => setTimeout(resolve, 100))

// 假 agent 与别的测试共用同一份替身：默认强度 low，判定 max 才看得出写入。
const agent = makeAgent({
  id: 'session-cordis',
  provider: 'cmdc-proxy',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: 'low',
})
const message = { id: 'm-cordis', role: 'user', content: [{ type: 'text', text: '重构这段代码并补测试' }], source: { kind: 'user' } }

// hold：inserted 里扣住本轮，判完把强度写进会话选择
ctx.emit('agent/inbox/inserted', { agent, message })
await agent.settled
check('真 cordis: 写了一次会话选择', agent.selections.length, 1)
check('真 cordis: 选择带判定强度', agent.selections[0]?.reasoningEffort, 'max')
check('真 cordis: 选择不动模型', `${agent.selections[0]?.provider}/${agent.selections[0]?.model}`, 'cmdc-proxy/deepseek-v4.1-flash')

// pre-step：走真瀑布，只补一条提示。modelSelection 是本轮快照，强度已经是 hold 写进去的。
const claimed = [message]
async function preStep(step = 1) {
  return ctx.waterfall('agent/pre-step', {
    agent,
    messages: claimed,
    turn: 1,
    step,
    signal: new AbortController().signal,
    modelSelection: agent.model.current(),
  }, async () => ({ kind: 'enter', messages: claimed }))
}
const decision = await preStep()
const added = decision.messages.slice(claimed.length)
check('真 cordis: 插了一条提示', added.length, 1)
check('真 cordis: 提示来源', added[0]?.source, { kind: 'model-selection', form: 'notice', summary: 'max → max' })
check('真 cordis: 提示用本轮模型', added[0]?.content[0]?.text,
  '[effort-router] 难度 max → 强度 max（cmdc-proxy/deepseek-v4.1-flash）')
// 中途那几步不刷屏。
const second = await preStep(2)
check('真 cordis: step 2 不重复插', second.messages.length - claimed.length, 0)

// 十八条 HTTP 路由：新路径九条（judge / mode / config / models / last / seen / probe / key / open-credentials），旧路径别名九条
check('真 cordis: 路由条数', routes.length, 18)
const paths = routes.map((route) => route.path)
check('真 cordis: 新路径都在', paths.filter((path) => path.startsWith('/effort-router/')).length, 9)
check('真 cordis: 旧别名都在', paths.filter((path) => path.startsWith('/router-effort/')).length, 9)
const judgeRoute = routes.find((route) => route.path === '/effort-router/judge')
let body = ''
judgeRoute.handler({ method: 'GET' }, {
  statusCode: 0,
  setHeader() {},
  end(text) { body = text },
})
check('真 cordis: judge 状态接口', JSON.parse(body).judgeUrl, judgeUrl)

await ctx.dispose?.()
judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 50))
done()
