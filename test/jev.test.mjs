/**
 * Jev 分支：走 System One 决策协议，不是 chat。
 *
 * 请求是 {model, state, questions}，响应是 {answers:{effort:{choice, confidence, probabilities}}}。
 * 这里用假服务验证解析、低置信度向上取、以及各类失败都退回「不改强度」。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
const KEY_NAME = 'TEST_JEV_KEY'
process.env[KEY_NAME] = 'test-key-value'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

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
const jevUrl = `http://127.0.0.1:${jev.address().port}/v1/systemone`

function fakeContext(credentialValues) {
  const handlers = new Map()
  const routes = []
  const state = { mode: 'auto', judgeSource: 'jev', notify: '', tiers: {}, jevUrl, jevApiKeyEnv: KEY_NAME }
  return {
    handlers,
    routes,
    state,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
      // 宿主凭据服务的真实形状是 { value, source }，这里照这个给。
      if (name === 'credentials' && credentialValues !== undefined) {
        return {
          async resolve(ref) {
            return Object.prototype.hasOwnProperty.call(credentialValues, ref)
              ? { value: credentialValues[ref], source: 'test' }
              : undefined
          },
        }
      }
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

const agentOf = (id) => ({ session: { id, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } })

/** 调一条已注册的 POST 路由，返回 {code, body}。 */
function callRoute(ctx, path, body) {
  const route = ctx.routes.find((entry) => entry.path === path)
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      on(event, fn) { listeners[event] = fn },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ code: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) }) },
    }
    route.handler(req, res)
    listeners.data?.(JSON.stringify(body))
    listeners.end?.()
  })
}

async function turnOf(ctx, id, turn) {
  const agent = agentOf(id)
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '重构这个模块并补测试' }] } })
  return ctx.handlers.get('agent/request')({ agent, turn, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
}

function fresh(state = {}, credentialValues) {
  const ctx = fakeContext(credentialValues)
  Object.assign(ctx.state, state)
  apply(ctx, { mode: 'auto', startupWaitMs: 0, provision: false })
  return ctx
}

// 正常一次：解析 choice，写进请求
{
  scenario = { status: 200, body: { answers: { effort: { choice: 'high', confidence: 0.91 } } } }
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-ok', 1)
  check('Jev: 判定生效', config.reasoningEffort, 'high')
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
  const config = await turnOf(ctx, 'session-jev-low', 1)
  check('Jev: 低置信度向上取', config.reasoningEffort, 'high')
}

// 置信度够高就听它的，即使概率分布里有更强的档
{
  scenario = {
    status: 200,
    body: { answers: { effort: { choice: 'low', confidence: 0.88, probabilities: { low: 0.88, high: 0.1, max: 0.02 } } } },
  }
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-confident', 1)
  check('Jev: 高置信度照它说的', config.reasoningEffort, 'low')
}

// 失败路径：都保持原强度
{
  scenario = { status: 500, body: { error: 'boom' } }
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-500', 1)
  check('Jev: HTTP 500 不改强度', config.reasoningEffort, 'low')
}

{
  scenario = { status: 200, body: { answers: { effort: { choice: 'turbo', confidence: 0.9 } } } }
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-unknown', 1)
  check('Jev: 未知档位不改强度', config.reasoningEffort, 'low')
}

{
  scenario = { status: 200, body: { answers: {} } }
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-empty', 1)
  check('Jev: 没有答案不改强度', config.reasoningEffort, 'low')
}

// 没有凭据：不发请求，直接放行
{
  delete process.env[KEY_NAME]
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  seenBody = undefined
  const ctx = fresh()
  const config = await turnOf(ctx, 'session-jev-nokey', 1)
  check('Jev: 没 key 不改强度', config.reasoningEffort, 'low')
  check('Jev: 没 key 不发请求', seenBody, undefined)
  process.env[KEY_NAME] = 'test-key-value'
}

// 凭据只在宿主凭据服务里：resolve 返回 {value, source}，不是裸字符串
{
  delete process.env[KEY_NAME]
  const CRED_NAME = 'CRED_JEV_KEY'
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  const ctx = fresh({ jevApiKeyEnv: CRED_NAME }, { [CRED_NAME]: 'cred-value' })
  const config = await turnOf(ctx, 'session-jev-credential', 1)
  check('Jev: 凭据服务返回对象也能用', config.reasoningEffort, 'max')
  check('Jev: 用的是凭据服务里的值', seenAuth, 'Bearer cred-value')
  process.env[KEY_NAME] = 'test-key-value'
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

// 凭据库优先于环境变量：面板写进凭据库的值必须真正生效
{
  scenario = { status: 200, body: { answers: { effort: { choice: 'max', confidence: 0.9 } } } }
  const ctx = fresh({}, { [KEY_NAME]: 'from-store' })
  const config = await turnOf(ctx, 'session-jev-precedence', 1)
  check('Jev: 凭据库优先', seenAuth, 'Bearer from-store')
  check('Jev: 凭据库优先时判定照常', config.reasoningEffort, 'max')
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

// 地址不可达
{
  const ctx = fresh({ jevUrl: 'http://127.0.0.1:1/v1/systemone' })
  const config = await turnOf(ctx, 'session-jev-down', 1)
  check('Jev: 不可达不改强度', config.reasoningEffort, 'low')
}

jev.closeAllConnections?.()
jev.close()
await new Promise((resolve) => setTimeout(resolve, 200))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)