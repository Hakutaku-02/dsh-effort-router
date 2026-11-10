/**
 * 在 0.2.2 时序上跑通 apply()：hold 阶段判定并写会话选择、pre-step 只补提示。
 *
 * 新版把模型选择在 pre-step 之前就快照了，写在 pre-step 里的强度最早下一步才生效。
 * 所以插件在 agent/inbox/inserted 里用 runMaintenance 扣住本轮唤醒，判完再放行。
 * 这组测试就盯这条链路：谁写、写什么、什么时候写、写不进去怎么办。
 *
 * 判定服务用本地临时 HTTP 服务顶替，不依赖真服务在线；失败了也能测兜底。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { makeAgent, makeChecker, makeContext } from './fake-host.mjs'

// 挂载痕迹写到测试自己的文件，宿主那份只留真实重启的记录。
process.env.ROUTER_EFFORT_LOG = tmpdir() + '/router-effort-test.log'
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
// 判定服务地址指向不可用端口时，启动探活不该把测试拖住。
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

const { check, done } = makeChecker()

let judgeCalls = 0
/** 判定服务这一轮给什么档位，测试按需改。 */
let judgeTier = 'max'
const judge = createServer((req, res) => {
  // /health 走 404：这个假服务不是真的判定服务，探活会判定为「不在线」，
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
const judgeUrl = 'http://127.0.0.1:' + judge.address().port + '/judge'
const deadJudgeUrl = 'http://127.0.0.1:1/judge'

const message = (id, text = '帮我重构这段 Go 代码并补测试') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const passThrough = (messages) => async () => ({ kind: 'enter', messages })

/** 触发一次 pre-step。payload 照 0.2.2 的形状给全，插件只读其中几项。 */
function preStep(ctx, payload, messages = []) {
  const handler = ctx.handlers.get('agent/pre-step')
  return handler(
    {
      agent: payload.agent,
      messages,
      turn: payload.turn ?? 1,
      step: payload.step ?? 1,
      signal: payload.signal ?? new AbortController().signal,
      modelSelection: payload.modelSelection ?? payload.agent.model.current(),
    },
    passThrough(messages),
  )
}

/** 挂载插件并跑完一条用户消息的 hold。 */
async function holdOnce(ctx, agent, msg) {
  ctx.emit('agent/inbox/inserted', { agent, message: msg })
  await agent.settled
}

function fresh(options = {}) {
  const ctx = makeContext(options)
  apply(ctx, { mode: options.mode ?? 'auto', autoStart: false, provision: false, judgeUrl: options.judgeUrl ?? judgeUrl, ...(options.config ?? {}) })
  return ctx
}

// hold：判 max，写进会话选择的只有强度，provider/model 原样
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-hold', provider: 'cmdc-proxy', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' })
  await holdOnce(ctx, agent, message('m1'))
  check('hold: 写了一次选择', agent.selections.length, 1)
  check('hold: 强度落到 max', agent.selections[0]?.reasoningEffort, 'max')
  check('hold: provider 不动', agent.selections[0]?.provider, 'cmdc-proxy')
  check('hold: model 不动', agent.selections[0]?.model, 'deepseek-v4.1-flash')
}

// 位置映射：模型只声明三档时，max 取最高档；high 取中间档
{
  judgeTier = 'high'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-ladder', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] })
  await holdOnce(ctx, agent, message('m1'))
  check('落位: 三档模型判 high 取中间', agent.selections[0]?.reasoningEffort, 'high')
}
{
  judgeTier = 'high'
  const ctx = fresh({ efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }] })
  const agent = makeAgent({ id: 'session-ladder5' })
  await holdOnce(ctx, agent, message('m1'))
  check('落位: 五档模型判 high 取中间', agent.selections[0]?.reasoningEffort, 'high')
}
{
  judgeTier = 'max'
  const ctx = fresh({ efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] })
  const agent = makeAgent({ id: 'session-ladder3' })
  await holdOnce(ctx, agent, message('m1'))
  check('落位: 三档模型判 max 取最高', agent.selections[0]?.reasoningEffort, 'high')
}

// manual 模式：不判、不写
{
  judgeTier = 'max'
  const before = judgeCalls
  const ctx = fresh({ mode: 'manual' })
  const agent = makeAgent({ id: 'session-manual' })
  await holdOnce(ctx, agent, message('m1'))
  check('manual: 不写选择', agent.selections.length, 0)
  check('manual: 不问判定', judgeCalls - before, 0)
}

// 总开关关掉：连 hold 都不进
{
  const ctx = makeContext({ settings: { enabled: false } })
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, judgeUrl })
  const agent = makeAgent({ id: 'session-off' })
  await holdOnce(ctx, agent, message('m1'))
  check('关掉: 不写选择', agent.selections.length, 0)
}

// 模型没声明强度：不写，请求保持原样
{
  judgeTier = 'max'
  const ctx = fresh({ efforts: null })
  const agent = makeAgent({ id: 'session-noeffort', reasoningEffort: undefined })
  await holdOnce(ctx, agent, message('m1'))
  check('无强度: 不写选择', agent.selections.length, 0)
}

// 判定不可用：落兜底档，不空等
{
  const ctx = fresh({ judgeUrl: deadJudgeUrl })
  const agent = makeAgent({ id: 'session-fallback', reasoningEffort: 'low' })
  await holdOnce(ctx, agent, message('m1'))
  check('兜底: 写了 fallback 档', agent.selections[0]?.reasoningEffort, 'low')
}

// 判定不可用但有上一轮档位：沿用上一轮，不走 fallback
{
  judgeTier = 'high'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-reuse', reasoningEffort: 'low' })
  await holdOnce(ctx, agent, message('m1'))
  check('上一轮: 先写 high', agent.selections[0]?.reasoningEffort, 'high')
  // 换一个 ctx（等同换进程）：上一轮的档位靠落盘读回，判定失败时沿用它而不是掉到 fallback。
  const down = fresh({ judgeUrl: deadJudgeUrl })
  const agent2 = makeAgent({ id: 'session-reuse', reasoningEffort: 'low' })
  await holdOnce(down, agent2, message('m2'))
  check('上一轮: 判定失败沿用上一轮', agent2.selections[0]?.reasoningEffort, 'high')
}

// 运行中插话：inserted 不抢 hold，pre-step 补判并写
{
  judgeTier = 'high'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-busy', provider: 'tokenflux', model: 'gog/gemini-3.8-flash', reasoningEffort: 'low', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] })
  agent.setRunning()
  await holdOnce(ctx, agent, message('m1'))
  check('运行中: 不抢 hold', agent.selections.length, 0)
  const claimed = [message('m1')]
  const decision = await preStep(ctx, { agent }, claimed)
  check('运行中: pre-step 补判写入', agent.selections[0]?.reasoningEffort, 'high')
  check('运行中: 插了一条提示', decision.messages.length - claimed.length, 1)
}

// 子代理：完全不碰
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-sub', header: { origin: 'subagent' } })
  await holdOnce(ctx, agent, message('m1'))
  check('子代理: 不写选择', agent.selections.length, 0)
  const claimed = [message('m1')]
  const decision = await preStep(ctx, { agent }, claimed)
  check('子代理: 不插提示', decision.messages.length - claimed.length, 0)
}

// pre-step 复用 hold 的判定：不再问判定服务，只插一条提示
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-reuse-verdict', reasoningEffort: 'low' })
  const msg = message('m-verdict')
  await holdOnce(ctx, agent, msg)
  const before = judgeCalls
  const claimed = [msg]
  const decision = await preStep(ctx, { agent }, claimed)
  const added = decision.messages.slice(claimed.length)
  check('pre-step: 判定只问一次', judgeCalls - before, 0)
  check('pre-step: 插了一条提示', added.length, 1)
  check('pre-step: 提示角色', added[0]?.role, 'user')
  check('pre-step: 提示来源', added[0]?.source, { kind: 'model-selection', form: 'notice', summary: 'max → max' })
  check('pre-step: 提示文本', added[0]?.content[0]?.text, '[effort-router] 难度 max → 强度 max（p/m）')
  const second = await preStep(ctx, { agent, step: 2 }, claimed)
  check('pre-step: step 2 不刷屏', second.messages.length - claimed.length, 0)
}

// notify: off 只写不提示
{
  judgeTier = 'max'
  const ctx = fresh({ config: { notify: 'off' } })
  const agent = makeAgent({ id: 'session-quiet', reasoningEffort: 'low' })
  const msg = message('m-quiet')
  await holdOnce(ctx, agent, msg)
  const claimed = [msg]
  const decision = await preStep(ctx, { agent }, claimed)
  check('notify off: 仍写选择', agent.selections.length, 1)
  check('notify off: 不插提示', decision.messages.length - claimed.length, 0)
}

// notify 默认（变化时提示）：强度没变就不插
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-same', reasoningEffort: 'max' })
  const msg = message('m-same')
  await holdOnce(ctx, agent, msg)
  const claimed = [msg]
  const decision = await preStep(ctx, { agent }, claimed)
  check('无变化: 不插提示', decision.messages.length - claimed.length, 0)
}

// 用户手拧过强度：只升不降
{
  judgeTier = 'low'
  const ctx = fresh()
  // 默认强度是 low，会话里记下的是 high：值不同才算「用户自己拧过」。
  const agent = makeAgent({ id: 'session-pinned', reasoningEffort: 'low', recorded: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  await holdOnce(ctx, agent, message('m1'))
  check('用户钉住: 判 low 不降', agent.model.current()?.reasoningEffort, 'high')
  check('用户钉住: 没写同值', agent.selections.length, 0)
}
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-pinned-up', reasoningEffort: 'low', recorded: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  await holdOnce(ctx, agent, message('m1'))
  check('用户钉住: 判 max 仍能抬', agent.model.current()?.reasoningEffort, 'max')
}

// 我们自己写的值，下一轮可以降
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-ours', reasoningEffort: 'low' })
  await holdOnce(ctx, agent, message('m1'))
  judgeTier = 'low'
  const second = makeAgent({ id: 'session-ours', reasoningEffort: 'low' })
  second.model.select({ provider: 'p', model: 'm', reasoningEffort: 'max' })
  second.selections.length = 0
  await holdOnce(ctx, second, message('m2'))
  check('我们写的: 下一轮能降回 low', second.model.current()?.reasoningEffort, 'low')
}

// 同一条消息重入：hold 只进一次
{
  judgeTier = 'max'
  const before = judgeCalls
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-reentry' })
  const msg = message('m1')
  ctx.emit('agent/inbox/inserted', { agent, message: msg })
  ctx.emit('agent/inbox/inserted', { agent, message: msg })
  await agent.settled
  check('重入: hold 只跑一次', judgeCalls - before, 1)
  check('重入: 只写一次', agent.selections.length, 1)
}

// 非用户消息不触发：定时任务、系统提示都不该被判难度
{
  const before = judgeCalls
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-system' })
  ctx.emit('agent/inbox/inserted', { agent, message: { id: 's1', role: 'user', content: [{ type: 'text', text: '定时任务' }], source: { kind: 'schedule' } } })
  await agent.settled
  check('非用户消息: 不判', judgeCalls - before, 0)
  check('非用户消息: 不写', agent.selections.length, 0)
}

// pre-step 前序监听器拒绝本轮：原样返回，不写
{
  judgeTier = 'max'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-reject', reasoningEffort: 'low' })
  agent.setRunning()
  const handler = ctx.handlers.get('agent/pre-step')
  const reject = { kind: 'reject' }
  const decision = await handler({ agent, messages: [message('m1')], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: agent.model.current() }, async () => reject)
  check('reject: 原样返回', decision, reject)
  check('reject: 不写选择', agent.selections.length, 0)
}

// 宿主收回 recordedSelection / options 时：判定只能往上抬，不许把现状压低
{
  judgeTier = 'low'
  const ctx = fresh()
  const agent = makeAgent({ id: 'session-strict', reasoningEffort: 'high', strictModel: true })
  await holdOnce(ctx, agent, message('m1'))
  check('收窄接口: 判 low 不降', agent.model.current()?.reasoningEffort, 'high')
  // 真机的 select 比的是会话记录：这里原本没有任何记录，写回原值会真的 append 一条。
  check('收窄接口: 写回的值仍是 high', agent.selections[0]?.reasoningEffort, 'high')
  judgeTier = 'max'
  const up = makeAgent({ id: 'session-strict-up', reasoningEffort: 'high', strictModel: true })
  await holdOnce(ctx, up, message('m2'))
  check('收窄接口: 判 max 仍能抬', up.model.current()?.reasoningEffort, 'max')
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 50))
done()