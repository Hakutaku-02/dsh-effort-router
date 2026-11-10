/**
 * 配置面：GET /effort-router/config 显示当前值，POST 写回 settings，热改立即生效。
 *
 * 0.2.2 起强度只在 agent/inbox/inserted 的 hold 里写，所以「配置生效」统一看 hold
 * 之后会话选择被写成了什么；「落盘」看 settings.update 的入参。判定后端用假服务顶替。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../index.js'
import { callRoute, makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
// judgeSource 热改成 jev 之后要能解析凭据：走环境变量这条路，与真实宿主一致。
const JEV_KEY_NAME = 'CONFIG_TEST_JEV_KEY'
process.env[JEV_KEY_NAME] = 'config-key'

const { check, done } = makeChecker()

let judgeCalls = 0
const judge = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health') {
    res.end(JSON.stringify({ protocol: 'finetuned' }))
    return
  }
  // 探活要能识破「连得上但回的档位不认识」。
  if (req.url === '/odd') {
    res.end(JSON.stringify({ tier: 'turbo' }))
    return
  }
  judgeCalls += 1
  res.end(JSON.stringify({ tier: 'high' }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

/** 假 Jev：judgeSource 热改成 jev 之后 hold 必须问它，而不是本地判定服务。 */
const jev = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ answers: { effort: { choice: 'max', confidence: 0.9 } } }))
})
await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve))
const jevUrl = `http://127.0.0.1:${jev.address().port}/v1/systemone`

const defaultSettings = () => ({ mode: 'auto', judgeSource: 'local', judgeUrl, notify: '', tiers: {} })

const message = (id, text = '帮我重构这段代码并补测试') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/**
 * 造上下文并挂插件。
 *
 * fake-host 的假设置面只改内存、不记账，这里包一层把 update 入参记下来：断言落盘要看它。
 */
function fresh(options = {}) {
  const ctx = makeContext(options)
  const updates = []
  const base = ctx.get.bind(ctx)
  ctx.get = (service) => {
    const settings = base(service)
    if (service !== 'settings' || settings === undefined) return settings
    return {
      describe: () => settings.describe(),
      async update(ns, patch) {
        updates.push({ ns, patch })
        if (options.updateThrows === true) throw new Error('write refused')
        return settings.update(ns, patch)
      },
    }
  }
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, judgeUrl, startupWaitMs: 0, ...(options.config ?? {}) })
  return { ctx, updates }
}

/** 跑一条用户消息的 hold：0.2.2 的写入点在这里。 */
async function holdOnce(ctx, agent, id = 'm1') {
  ctx.emit('agent/inbox/inserted', { agent, message: message(id) })
  await agent.settled
}

/** 触发一次 pre-step：notify 的效果只能从这里看。 */
function preStep(ctx, agent, messages = []) {
  const handler = ctx.handlers.get('agent/pre-step')
  return handler(
    {
      agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      modelSelection: agent.model.current(),
    },
    async () => ({ kind: 'enter', messages }),
  )
}

// Config schema 覆盖了现有全部配置项，否则声明 schema 后它们会被剥掉
{
  const keys = Object.keys(Config.dict ?? Config.toJSON?.()?.dict ?? {})
  const wanted = ['mode', 'judgeSource', 'judgeUrl', 'notify', 'tiers', 'autoStart', 'servicePython', 'serviceScript', 'provision', 'layaDir', 'startupWaitMs', 'startWaitMs', 'provisionWaitMs']
  check('Config: 字段齐全', wanted.every((key) => keys.includes(key)), true)
}

// 有设置面：读、写、热生效
{
  const { ctx, updates } = fresh({ settings: defaultSettings() })

  const got = await callRoute(ctx, '/effort-router/config', undefined, { method: 'GET', headers: {} })
  check('配置: GET 状态码', got.code, 200)
  check('配置: entryId', got.body.entryId, 'effort-router')
  check('配置: 可写', got.body.writable, true)
  check('配置: 初值 mode', got.body.mode, 'auto')
  check('配置: Jev 默认网关', got.body.jevUrl, 'https://api.typesafe.ai/v1/systemone')

  const saved = await callRoute(ctx, '/effort-router/config', { mode: 'manual', notify: 'always' })
  check('配置: POST 状态码', saved.code, 200)
  check('配置: 落盘参数', updates[0], { ns: 'effort-router', patch: { mode: 'manual', notify: 'always' } })
  check('配置: 保存后回读', saved.body.config.mode, 'manual')

  // manual 立即生效：hold 不抢唤醒、不写选择、不问判定
  const quiet = makeAgent({ id: 'session-config-manual', reasoningEffort: 'low' })
  const before = judgeCalls
  await holdOnce(ctx, quiet)
  check('配置: manual 热生效', quiet.selections.length, 0)
  check('配置: manual 不问判定', judgeCalls - before, 0)

  // 切回 auto：下一条用户消息恢复改强度
  const back = await callRoute(ctx, '/effort-router/config', { mode: 'auto' })
  check('配置: 切回 auto 回读', back.body.config.mode, 'auto')
  const autoAgent = makeAgent({ id: 'session-config-auto', reasoningEffort: 'low' })
  await holdOnce(ctx, autoAgent)
  check('配置: auto 热生效', autoAgent.model.current()?.reasoningEffort, 'high')
}

// 档位映射：能改、能拒非法值、改完立即影响写进会话的强度
{
  const { ctx, updates } = fresh({ settings: defaultSettings() })

  const before = await callRoute(ctx, '/effort-router/config', undefined, { method: 'GET', headers: {} })
  check('档位: 默认 high', before.body.tiers.high, 'high')

  const bad = await callRoute(ctx, '/effort-router/config', { tiers: { max: 'turbo' } })
  check('档位: 非法强度被拒', bad.code, 400)
  check('档位: 拒时不写', updates.length, 0)

  const saved = await callRoute(ctx, '/effort-router/config', { tiers: { high: 'low' } })
  check('档位: 保存成功', saved.code, 200)
  check('档位: 回读 high', saved.body.config.tiers.high, 'low')

  // 判定服务回 high，映射改成 low 之后写进会话的就该是 low
  const agent = makeAgent({ id: 'session-tier', reasoningEffort: 'max' })
  await holdOnce(ctx, agent)
  check('档位: 热改生效', agent.model.current()?.reasoningEffort, 'low')
}

// judgeSource：热改成 jev 之后 hold 改问 Jev，本地判定服务不再被打扰
{
  const { ctx, updates } = fresh({ settings: defaultSettings() })
  const before = judgeCalls
  const saved = await callRoute(ctx, '/effort-router/config', { judgeSource: 'jev', jevUrl, jevApiKeyEnv: JEV_KEY_NAME })
  check('后端: 保存成功', saved.code, 200)
  check('后端: 落盘参数', updates[0]?.patch, { judgeSource: 'jev', jevUrl, jevApiKeyEnv: JEV_KEY_NAME })
  check('后端: 回读 jevUrl', saved.body.config.jevUrl, jevUrl)

  const agent = makeAgent({ id: 'session-config-jev', reasoningEffort: 'low' })
  await holdOnce(ctx, agent)
  check('后端: 热改后按 Jev 判定', agent.model.current()?.reasoningEffort, 'max')
  check('后端: 本地判定没被问', judgeCalls - before, 0)

  const status = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
  check('后端: 状态接口报 jev', status.body.backend, 'jev')
  check('后端: 状态接口报 Jev 地址', status.body.judgeUrl, jevUrl)
}

// notify：只管提示，不影响写强度；提示本身在这里看得出区别
{
  const { ctx, updates } = fresh({ settings: defaultSettings() })
  const saved = await callRoute(ctx, '/effort-router/config', { notify: 'off' })
  check('提示: 落盘参数', updates[0]?.patch, { notify: 'off' })

  const quiet = makeAgent({ id: 'session-config-notify', reasoningEffort: 'low' })
  const msg = message('m-notify')
  ctx.emit('agent/inbox/inserted', { agent: quiet, message: msg })
  await quiet.settled
  check('提示: off 仍写强度', quiet.model.current()?.reasoningEffort, 'high')
  const silent = await preStep(ctx, quiet, [msg])
  check('提示: off 不插提示', silent.messages.length - 1, 0)

  // always：强度没变也提示
  const loud = await callRoute(ctx, '/effort-router/config', { notify: 'always' })
  check('提示: always 回读', loud.body.config.notify, 'always')
  const same = makeAgent({ id: 'session-config-loud', reasoningEffort: 'high' })
  const msg2 = message('m-loud')
  ctx.emit('agent/inbox/inserted', { agent: same, message: msg2 })
  await same.settled
  check('提示: 强度没变也照写', same.model.current()?.reasoningEffort, 'high')
  const shown = await preStep(ctx, same, [msg2])
  check('提示: always 强度没变也插', shown.messages.length - 1, 1)
}

// 跨站写保护与写入白名单
{
  const { ctx, updates } = fresh({ settings: defaultSettings() })

  const plain = await callRoute(ctx, '/effort-router/config', { mode: 'manual' }, { method: 'POST', headers: { 'content-type': 'text/plain' } })
  check('跨站写: 非 JSON 类型被拒', plain.code, 415)
  check('跨站写: 没落盘', updates.length, 0)

  const fileUrl = await callRoute(ctx, '/effort-router/config', { judgeUrl: 'file:///etc/passwd' })
  check('judgeUrl: 非 http(s) 被拒', fileUrl.code, 400)

  const badNotify = await callRoute(ctx, '/effort-router/config', { notify: '随时' })
  check('notify: 非法值被拒', badNotify.code, 400)

  const good = await callRoute(ctx, '/effort-router/config', { judgeUrl: 'https://example.com/judge' })
  check('judgeUrl: 合法地址接受', good.code, 200)
}

// 总开关：关掉之后完全不写会话选择，打开恢复
{
  const { ctx } = fresh({ settings: defaultSettings() })

  const off = await callRoute(ctx, '/effort-router/config', { enabled: false })
  check('开关: 保存成功', off.code, 200)
  check('开关: 回读为关', off.body.config.enabled, false)

  const closedAgent = makeAgent({ id: 'session-switch', reasoningEffort: 'low' })
  await holdOnce(ctx, closedAgent)
  check('开关: 关掉后不写选择', closedAgent.selections.length, 0)

  const opened = await callRoute(ctx, '/effort-router/config', { enabled: true })
  check('开关: 回读为开', opened.body.config.enabled, true)
}
{
  // 同一条会话：关着时强度原样，打开后下一次 hold 就写进去了
  const { ctx } = fresh({ settings: defaultSettings() })
  await callRoute(ctx, '/effort-router/config', { enabled: false })
  const agent = makeAgent({ id: 'session-switch-same', reasoningEffort: 'low' })
  await holdOnce(ctx, agent)
  check('开关: 关掉时强度原样', agent.model.current()?.reasoningEffort, 'low')
  await callRoute(ctx, '/effort-router/config', { enabled: true })
  await holdOnce(ctx, agent, 'm2')
  check('开关: 打开后同一条会话改强度', agent.model.current()?.reasoningEffort, 'high')
}

// 没有设置面：只读，mode 退回内存开关
{
  const { ctx } = fresh({ settings: false, noSettings: true })

  const got = await callRoute(ctx, '/effort-router/config', undefined, { method: 'GET', headers: {} })
  check('无设置面: 不可写', got.body.writable, false)

  const saved = await callRoute(ctx, '/effort-router/config', { mode: 'manual' })
  check('无设置面: 保存落内存', saved.body.persisted, false)
}

// 探活接口：设置页的「测试」按钮靠它，用户不该只能靠发消息才知道配错
{
  const { ctx } = fresh({ settings: defaultSettings() })
  const probe = await callRoute(ctx, '/effort-router/probe', {})
  check('探活: 本地判定可用', probe.body.ok, true)
  check('探活: 标注后端', probe.body.backend, 'local')
  check('探活: 带耗时', typeof probe.body.ms, 'number')
}

{
  const deadUrl = 'http://127.0.0.1:1/judge'
  const { ctx } = fresh({ settings: { ...defaultSettings(), judgeUrl: deadUrl }, config: { judgeUrl: deadUrl } })
  const probe = await callRoute(ctx, '/effort-router/probe', {})
  check('探活: 连不上时 ok 为假', probe.body.ok, false)
  check('探活: 失败要说原因', probe.body.detail !== '' && typeof probe.body.detail === 'string', true)
}

// 回了个不认识的档位：连得上也不算能用
{
  const oddUrl = `${judgeUrl.slice(0, judgeUrl.lastIndexOf('/'))}/odd`
  const { ctx } = fresh({ settings: { ...defaultSettings(), judgeUrl: oddUrl }, config: { judgeUrl: oddUrl } })
  const probe = await callRoute(ctx, '/effort-router/probe', {})
  check('探活: 未知档位不算连通', probe.body.ok, false)
  check('探活: 说明档位不认识', /档位不认识/.test(probe.body.detail || ''), true)
}

// 改过的地址必须先保存：否则任何页面都能借这个接口把凭据发到别处
{
  const { ctx } = fresh({ settings: defaultSettings() })
  const guarded = await callRoute(ctx, '/effort-router/probe', { judgeUrl: 'http://example.invalid/judge' })
  check('探活: 改地址未保存时拒绝', guarded.body.ok, false)
  check('探活: 说明要先保存', /先保存/.test(guarded.body.detail || ''), true)
}

// 地址守卫按规范化后的 URL 比：换个大小写不是「改过地址」
{
  const { ctx } = fresh({ settings: defaultSettings() })
  const upper = judgeUrl.replace(/^http:\/\//, 'HTTP://')
  const probe = await callRoute(ctx, '/effort-router/probe', { judgeSource: 'local', judgeUrl: upper })
  check('探活: 地址大小写不算改动', probe.body.ok, true)
}

// 凭据名填错时的提示要说得清哪里错，不能只回一句「没有可写的字段」
{
  const { ctx } = fresh({ settings: defaultSettings() })
  const bad = await callRoute(ctx, '/effort-router/config', { jevApiKeyEnv: 'my key!' })
  check('凭据名: 拒绝非法字符', bad.body.ok, false)
  check('凭据名: 校验失败回 400', bad.code, 400)
  check('凭据名: 提示点名凭据名', /凭据名/.test(bad.body.detail || ''), true)
}

// 写入被拒：状态码 503，detail 带上宿主给的原因，且确实调过一次 update
{
  const { ctx, updates } = fresh({ settings: defaultSettings(), updateThrows: true })
  const saved = await callRoute(ctx, '/effort-router/config', { mode: 'manual' })
  check('写入被拒: 状态码', saved.code, 503)
  check('写入被拒: 带原因', saved.body.detail, 'write refused')
  check('写入被拒: 确实调了 update', updates.length, 1)
}

judge.closeAllConnections?.()
judge.close()
jev.closeAllConnections?.()
jev.close()
// 等句柄真的关掉，否则 Node 在 Windows 上退出时会报 libuv 断言。
await new Promise((resolve) => setTimeout(resolve, 200))

done()
