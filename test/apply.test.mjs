/**
 * 用一个假 ctx 跑通 apply()：验证请求钩子会改 reasoningEffort、manual 模式不动配置、
 * 每轮提示会插一条可见消息，并且一次 turn 只问判定服务一次。
 * 判定服务用本地临时 HTTP 服务顶替，不依赖真服务在线。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

// 挂载痕迹写到测试自己的文件，宿主那份只留真实重启的记录。
process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
// 判定服务地址指向不可用端口时，启动探活不该把测试拖住。
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

let judgeCalls = 0
/** 判定服务这一轮给什么档位，测试按需改。 */
let judgeTier = 'max'
const judge = createServer((req, res) => {
  // /health 走 404：这个假服务不是真的判定服务，插件探活会判定为“不在线”，
  // 计数只统计真正打到 /judge 的判定请求。
  if (req.url !== '/judge') {
    res.statusCode = 404
    res.end()
    return
  }
  judgeCalls += 1
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ tier: judgeTier }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

/**
 * 假上下文。
 * @param options.selection - 模型选择投影的 state；给了才有 sessionProjections 服务。
 * @param options.efforts - resolveModelInfo 返回的强度列表；null 表示模型没有强度。
 */
function fakeContext(options = {}) {
  const handlers = new Map()
  const { selection, onSelect, efforts = [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } = options
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            return efforts === null ? {} : { reasoning: { efforts } }
          },
        }
      }
      if (name === 'sessionProjections' && selection !== undefined) {
        return { stateOf: () => selection }
      }
      if (name === 'sessionController' && onSelect !== undefined) {
        return {
          selectForNextRequest(agent, next) { onSelect(agent, next) },
        }
      }
      return undefined
    },
    inject() { /* 没有 webServer，跳过开关路由 */ },
    effect(fn) { fn() },
  }
}

const message = { content: [{ type: 'text', text: '帮我重构这段 Go 代码并补测试' }] }
const staleConfig = { provider: 'cmdc-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }
function fakeAgent(config = staleConfig) {
  return { session: { id: 'session-test', requestHeader: () => ({ config }) } }
}
const passThrough = async (messages) => ({ kind: 'enter', messages })
const request = (base) => ({ provider: 'minimax-m-plan', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low', ...base })

// auto 模式：判 max -> 抬到 max，provider/model 不动
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const result = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => request())
  check('auto: 强度抬到 max', result.reasoningEffort, 'max')
  check('auto: provider 不动', result.provider, 'minimax-m-plan')
  check('auto: model 不动', result.model, 'MiniMax-M3.1-Flash')
}

// manual 模式：原样返回，也不插提示
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'manual', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const base = request({ provider: 'p', model: 'm' })
  check('manual: 请求原样', await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => base), base)
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('manual: 不插提示', decision.messages.length, 0)
}

// 每轮提示：step 1 插一条，内容是档位与强度；同一步的请求复用这次判定
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  const before = judgeCalls
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('提示: 插了一条', decision.messages.length, 1)
  const notice = decision.messages[0]
  check('提示: 角色', notice.role, 'user')
  check('提示: 来源', notice.source, { kind: 'model-selection', form: 'notice', summary: 'max → max' })
  check('提示: 文本', notice.content[0].text, '[effort-router] 难度 max → 强度 max（cmdc-proxy/deepseek-v4.1-flash）')
  const result = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => request())
  check('提示轮: 请求仍然升到 max', result.reasoningEffort, 'max')
  check('提示轮: 判定只问一次', judgeCalls - before, 1)
}

// 用户这一轮换了模型：提示里的模型名要用投影里的本轮选择，不是上一轮请求头
{
  const selection = {
    lastUsed: { provider: 'cmdc-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    pending: { provider: 'minimax-m-plan', model: 'MiniMax-M3.1-Flash' },
  }
  const ctx = fakeContext({ selection })
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('切换模型: 提示用新模型', decision.messages[0].content[0].text,
    '[effort-router] 难度 max → 强度 max（minimax-m-plan/MiniMax-M3.1-Flash）')
}

// 投影里没有 pending 时用 lastUsed
{
  const selection = { lastUsed: { provider: 'qwen', model: 'qwen3-max', reasoningEffort: 'medium' }, pending: null }
  const ctx = fakeContext({ selection })
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('无 pending: 用 lastUsed', decision.messages[0].content[0].text,
    '[effort-router] 难度 max → 强度 max（qwen/qwen3-max）')
}

// 强度没变化时不插提示（请求头里的强度已经是 max）
{
  const ctx = fakeContext()
  const agent = fakeAgent({ ...staleConfig, reasoningEffort: 'max' })
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('无变化: 不插提示', decision.messages.length, 0)
}

// notify: always 每轮都写
{
  const ctx = fakeContext()
  const agent = fakeAgent({ ...staleConfig, reasoningEffort: 'max' })
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl, notify: 'always' })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('notify always: 仍然插提示', decision.messages.length, 1)
}

// 判定服务挂了：原样返回，不抛错
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl: 'http://127.0.0.1:1/judge' })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const base = request({ provider: 'p', model: 'm' })
  check('判定失败: 请求原样', await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => base), base)
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('判定失败: 不插提示', decision.messages.length, 0)
}

// 模型不支持任何强度：原样返回
{
  const ctx = fakeContext({ efforts: null })
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const base = request({ provider: 'p', model: 'm', reasoningEffort: undefined })
  delete base.reasoningEffort
  check('无强度词汇: 请求原样', await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => base), base)
}

// 一步内第二跳不插提示
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctx.handlers.get('agent/pre-step')({ agent, step: 2 }, () => passThrough([]))
  check('step 2: 不插提示', decision.messages.length, 0)
}

// 前序监听器拒绝本轮：原样返回
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const reject = { kind: 'reject' }
  check('reject: 原样返回',
    await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, async () => reject), reject)
}

// 选“默认”档（请求里没有 reasoningEffort）时，插件照样按判定结果写进去
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  judgeTier = 'low'
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  const base = { provider: 'minimax-m-plan', model: 'MiniMax-M3.1-Flash' }
  const result = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => base)
  check('默认档: 判定 low 时写入 low', result.reasoningEffort, 'low')
  judgeTier = 'max'
}

// 用户显式选了强度时只升不降
{
  const ctx = fakeContext()
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  judgeTier = 'max'
  await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => request())
  judgeTier = 'low'
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '1+1等于几' }] } })
  const pinned = await ctx.handlers.get('agent/request')({ agent, turn: 2, step: 1 },
    async () => request({ reasoningEffort: 'high' }))
  check('用户选了 high: 判定 low 时不降', pinned.reasoningEffort, 'high')
  judgeTier = 'max'
}

// pre-step 必须把强度写进会话选择：不写的话 model-selection 会把强度剥掉，
// 请求里连 thinking 参数都不会出现（实测抓包确认）。
{
  const calls = []
  const ctx = fakeContext({ onSelect: (agent, next) => calls.push({ id: agent.session.id, ...next }) })
  const agent = fakeAgent()
  apply(ctx, { mode: 'auto', autoStart: false, judgeUrl })
  judgeTier = 'max'
  ctx.handlers.get('agent/inbox/claimed')({ agent, message })
  await ctx.handlers.get('agent/pre-step')({ agent, step: 1 }, () => passThrough([]))
  check('选择: 写入了 provider', calls[0]?.provider, 'cmdc-proxy')
  check('选择: 写入了 model', calls[0]?.model, 'deepseek-v4.1-flash')
  check('选择: 写入了强度', calls[0]?.reasoningEffort, 'max')
  check('选择: 只写一次', calls.length, 1)

  // notify 关掉也要写选择，只是不插提示
  const quiet = []
  const ctxQuiet = fakeContext({ onSelect: (agent, next) => quiet.push(next) })
  apply(ctxQuiet, { mode: 'auto', autoStart: false, judgeUrl, notify: 'off' })
  ctxQuiet.handlers.get('agent/inbox/claimed')({ agent, message })
  const decision = await ctxQuiet.handlers.get('agent/pre-step')({ agent, step: 2 }, () => passThrough([]))
  check('选择: notify off 时不插提示', decision.messages.length, 0)
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 50))
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
