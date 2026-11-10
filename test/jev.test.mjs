/**
 * Jev 分支：走 System One 决策协议，不是 chat。
 *
 * 请求是 {model, state, questions}，响应是 {answers:{effort:{choice, confidence, probabilities}}}。
 * 这里用假服务验证解析、低置信度向上取、各类失败都落兜底档，以及 jev 后端不碰本地判定服务。
 * 判定在 hold 里跑，所以断言看的是「会话选择被写成了什么」。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { callRoute, makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = tmpdir() + '/router-effort-test.log'
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
const KEY_NAME = 'TEST_JEV_KEY'
process.env[KEY_NAME] = 'test-key-value'

const { check, done } = makeChecker()

/** 假 Jev：按 scenario 决定回什么，同时记下收到的请求体。 */
let scenario = { status: 200, body: { answers: { effort: { choice: 'high', confidence: 0.9 } } } }
let seenBody
let seenAuth
const jev = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    seenBody = raw === '' ? undefined : JSON.parse(raw)
    seenAuth = req.headers.authorization
    res.statusCode = scenario.status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(scenario.body))
  })
})
await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve))
const jevUrl = 'http://127.0.0.1:' + jev.address().port + '/v1/systemone'

const message = (id, text = '重构这个模块并补测试') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

function fresh(state = {}, credentialValues) {
  const settings = { judgeSource: 'jev', judgeUrl: 'http://127.0.0.1:1/judge', notify: '', tiers: {}, jevUrl, jevApiKeyEnv: KEY_NAME, ...state }
  const ctx = makeContext({ settings, credentials: credentialValues })
  apply(ctx, { mode: 'auto', startupWaitMs: 0, provision: false })
  return ctx
}

/** 跑一条用户消息的 hold，返回写完之后的强度。agent 默认强度给 high，掉到 low 才看得出来。 */
async function effortOf(ctx, id, options = {}) {
  const agent = makeAgent({ id, provider: 'p', model: 'm', reasoningEffort: options.reasoningEffort ?? 'high' })
  ctx.emit('agent/inbox/inserted', { agent, message: message(options.messageId ?? 'm1') })
  await agent.settled
  return agent.model.current()?.reasoningEffort
}

// 正常一次：解析 choice，写进会话选择
{
  scenario = { status: 200, body: { answers: { effort: { choice: 'high', confidence: 0.91 } } } }
  const ctx = fresh()
  check('Jev: 判定生效', await effortOf(ctx, 'session-jev-ok'), 'high')
  check('Jev: 请求带模型名', seenBody?.model, 'jev-latest')
  check('Jev: 请求带原文', seenBody?.state, '重构这个模块并补测试')
  check('Jev: 问的是 choice', seenBody?.questions?.effort?.type, 'choice')
  check('Jev: criteria 三档齐全', Object.keys(seenBody?.questions?.effort?.criteria ?? {}), ['low', 'high', 'max'])
  check('Jev: 带 Bearer 头', seenAuth, 'Bearer test-key-value')
}

// 低置信度：在概率最高的两档里取更强的
{
  scenario = {
    status: 200,
    body: { answers: { effort: { choice: 'low', confidence: 0.31, probabilities: { low: 0.45, high: 0.4, max: 0.15 } } } },
  }
  const ctx = fresh()
  check('Jev: 低置信度向上取', await effortOf(ctx, 'session-jev-low'), 'high')
}

// 置信度够高就听它的，即使概率分布里有更强的档
{
  scenario = {
    status: 200,
    body: { answers: { effort: { choice: 'low', confidence: 0.88, probabilities: { low: 0.88, high: 0.1, max: 0.02 } } } },
  }
  const ctx = fresh()
  check('Jev: 高置信度照它说的', await effortOf(ctx, 'session-jev-confident'), 'low')
}

// 失败路径：都落兜底档（hold 已经扣住本轮，不放行就是卡住用户）
{
  scenario = { status: 500, body: { error: 'boom' } }
  const ctx = fresh()
  check('Jev: HTTP 500 落兜底', await effortOf(ctx, 'session-jev-500'), 'low')
}
{
  scenario = { status: 200, body: { answers: { effort: { choice: 'turbo', confidence: 0.9 } } } }
  const ctx = fresh()
  check('Jev: 未知档位落兜底', await effortOf(ctx, 'session-jev-unknown'), 'low')
}
{
  scenario = { status: 200, body: { answers: {} } }
  const ctx = fresh()
  check('Jev: 没有答案落兜底', await effortOf(ctx, 'session-jev-empty'), 'low')
}

// 没有凭据：不发请求，落兜底
{
  delete process.env[KEY_NAME]
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  seenBody = undefined
  const ctx = fresh()
  check('Jev: 没 key 落兜底', await effortOf(ctx, 'session-jev-nokey'), 'low')
  check('Jev: 没 key 不发请求', seenBody, undefined)
  process.env[KEY_NAME] = 'test-key-value'
}

// 凭据只在宿主凭据服务里：resolve 返回 {value, source}，不是裸字符串
{
  delete process.env[KEY_NAME]
  const CRED_NAME = 'CRED_JEV_KEY'
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  const ctx = fresh({ jevApiKeyEnv: CRED_NAME }, { [CRED_NAME]: 'cred-value' })
  check('Jev: 凭据服务返回对象也能用', await effortOf(ctx, 'session-jev-credential'), 'max')
  check('Jev: 用的是凭据服务里的值', seenAuth, 'Bearer cred-value')
  process.env[KEY_NAME] = 'test-key-value'
}

// 凭据库优先于环境变量：面板写进凭据库的值必须真正生效
{
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  const ctx = fresh({}, { [KEY_NAME]: 'from-store' })
  check('Jev: 凭据库优先时判定照常', await effortOf(ctx, 'session-jev-precedence'), 'max')
  check('Jev: 凭据库优先', seenAuth, 'Bearer from-store')
}

// 超时：端点不回话时 hold 必须自己放开，落兜底
{
  const hang = createServer(() => { /* 永不响应 */ })
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve))
  const ctx = fresh({
    jevUrl: 'http://127.0.0.1:' + hang.address().port + '/v1/systemone',
    judgeTimeoutMs: 150,
  })
  const started = Date.now()
  check('Jev: 超时落兜底', await effortOf(ctx, 'session-jev-hang'), 'low')
  const cost = Date.now() - started
  check('Jev: 超时不拖住 hold', cost < 2000, true)
  hang.closeAllConnections?.()
  hang.close()
}

// 地址不可达
{
  const ctx = fresh({ jevUrl: 'http://127.0.0.1:1/v1/systemone' })
  check('Jev: 不可达落兜底', await effortOf(ctx, 'session-jev-down'), 'low')
}

// 用 jev 时不该去探本地判定服务：探活与部署都是白做，状态还会显示成「部署失败」
{
  const ctx = fresh({ jevUrl })
  const status = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
  check('状态: 报当前后端', status.body.backend, 'jev')
  check('状态: 端点报 jev 地址', status.body.judgeUrl, jevUrl)
  check('状态: 没有本地部署日志字段', status.body.setupLog, undefined)
}

// 探活不接受调用方指定凭据名：否则任何本地进程都能借它把别的 key 发出去
{
  const ctx = fresh()
  process.env.PROBE_KEY = 'probe-value'
  seenAuth = undefined
  const probe = await callRoute(ctx, '/effort-router/probe', { judgeSource: 'jev', jevApiKeyEnv: 'PROBE_KEY' })
  check('探活: 仍能连通', probe.body.ok, true)
  check('探活: 用的是已保存的凭据', seenAuth, 'Bearer test-key-value')
  delete process.env.PROBE_KEY
}

// 测 jev 时，本地判定地址改没改与本次无关
{
  const ctx = fresh()
  const probe = await callRoute(ctx, '/effort-router/probe', {
    judgeSource: 'jev',
    judgeUrl: 'http://example.invalid/judge',
  })
  check('探活: 只比当前后端的地址', probe.body.ok, true)
}

jev.closeAllConnections?.()
jev.close()
await new Promise((resolve) => setTimeout(resolve, 200))
done()