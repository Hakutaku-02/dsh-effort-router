/**
 * 在真的 cordis 上下文里跑一遍：服务注册、事件瀑布、提示插入。
 *
 * 需要 DSH 安装目录。默认用本机安装路径，也可以用 DSH_ROOT 指定：
 *   DSH_ROOT="C:/.../DeepSeek Harness/resources/app/dsh" npm run test:cordis
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))

const root = process.env.DSH_ROOT ?? 'C:/Users/Hakutaku02/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh'
const cordisEntry = join(root, 'node_modules/@deepseek-ai/cordis/lib/index.js')
if (!existsSync(cordisEntry)) {
  console.log(`跳过：找不到 cordis（${cordisEntry}）。用 DSH_ROOT 指向 DSH 安装目录后重跑。`)
  process.exit(0)
}

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

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
ctx.provide('sessionProjections', {
  stateOf: () => ({
    lastUsed: { provider: 'cmdc-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    pending: { provider: 'minimax-m-plan', model: 'MiniMax-M3.1-Flash' },
  }),
})
ctx.plugin({ name: 'effort-router', apply }, { mode: 'auto', autoStart: false, judgeUrl })
await new Promise((resolve) => setTimeout(resolve, 100))

const agent = {
  session: {
    id: 'session-cordis',
    requestHeader: () => ({ config: { provider: 'cmdc-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } }),
  },
}
const message = { content: [{ type: 'text', text: '重构这段代码并补测试' }] }

ctx.emit('agent/inbox/claimed', { agent, message })
const config = await ctx.waterfall('agent/request', { agent, turn: 1, step: 1 },
  async () => ({ provider: 'minimax-m-plan', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low' }))
check('真 cordis: 强度抬到 max', config.reasoningEffort, 'max')
check('真 cordis: 模型不动', `${config.provider}/${config.model}`, 'minimax-m-plan/MiniMax-M3.1-Flash')

const decision = await ctx.waterfall('agent/pre-step', { agent, step: 1 },
  async () => ({ kind: 'enter', messages: [] }))
check('真 cordis: 插了一条提示', decision.messages.length, 1)
check('真 cordis: 提示用本轮模型', decision.messages[0].content[0].text,
  '[effort-router] 难度 max → 强度 max（minimax-m-plan/MiniMax-M3.1-Flash）')

// 十二条 HTTP 路由：新路径六条（judge / mode / config / models / last / seen），旧路径别名六条
check('真 cordis: 路由条数', routes.length, 12)
const paths = routes.map((route) => route.path)
check('真 cordis: 新路径都在', paths.filter((path) => path.startsWith('/effort-router/')).length, 6)
check('真 cordis: 旧别名都在', paths.filter((path) => path.startsWith('/router-effort/')).length, 6)
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
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
