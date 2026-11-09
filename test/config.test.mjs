/**
 * 配置面：GET /effort-router/config 显示当前值，POST 写回 settings，mode 立即可热改。
 *
 * 设置面在真实宿主里由 dsh-settings 提供；这里用假 settings 记录写入参数，验证落盘路径。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

// 真判定服务太小，直接起一个：热改之后要能真的判出档位，才算“生效”。
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
  res.end(JSON.stringify({ tier: 'high' }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

function fakeContext(options = {}) {
  const handlers = new Map()
  const routes = []
  const updates = []
  const state = { mode: 'auto', judgeSource: 'local', judgeUrl, notify: '', tiers: {} }
  const withSettings = options.settings !== false
  return {
    handlers,
    routes,
    updates,
    state,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
      if (name === 'settings' && withSettings) {
        return {
          describe() { return [{ ns: 'effort-router', value: { ...state } }] },
          async update(ns, patch) {
            updates.push({ ns, patch })
            if (options.updateThrows === true) throw new Error('write refused')
            Object.assign(state, patch)
          },
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

/** 调一条已注册的路由；POST 传 JSON body。 */
function call(route, method, body, url = '/', contentType = 'application/json') {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url,
      headers: { 'content-type': contentType },
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

const routeOf = (ctx, path) => ctx.routes.find((entry) => entry.path === path)

// Config schema 覆盖了现有全部配置项，否则声明 schema 后它们会被剥掉
{
  const keys = Object.keys(Config.dict ?? Config.toJSON?.()?.dict ?? {})
  const wanted = ['mode', 'judgeSource', 'judgeUrl', 'notify', 'tiers', 'autoStart', 'servicePython', 'serviceScript', 'provision', 'layaDir', 'startupWaitMs', 'startWaitMs', 'provisionWaitMs']
  check('Config: 字段齐全', wanted.every((key) => keys.includes(key)), true)
}

// 有设置面：读、写、热生效
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })

  const got = await call(routeOf(ctx, '/effort-router/config'), 'GET')
  check('配置: GET 状态码', got.code, 200)
  check('配置: entryId', got.body.entryId, 'effort-router')
  check('配置: 可写', got.body.writable, true)
  check('配置: 初值 mode', got.body.mode, 'auto')

  const saved = await call(routeOf(ctx, '/effort-router/config'), 'POST', { mode: 'manual', notify: 'always' })
  check('配置: POST 状态码', saved.code, 200)
  check('配置: 落盘参数', ctx.updates[0], { ns: 'effort-router', patch: { mode: 'manual', notify: 'always' } })
  check('配置: 保存后回读', saved.body.config.mode, 'manual')

  // manual 立即生效：请求原样返回
  const agent = { session: { id: 'session-config', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '重构这段代码' }] } })
  const config = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
  check('配置: manual 热生效', config.reasoningEffort, 'low')

  // 切回 auto 并确认恢复改强度
  await call(routeOf(ctx, '/effort-router/config'), 'POST', { mode: 'auto' })
  const config2 = await ctx.handlers.get('agent/request')({ agent, turn: 2, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
  check('配置: auto 热生效', config2.reasoningEffort, 'high')
}

// 档位映射：能改、能拒非法值、改完立即影响强度
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })

  const before = await call(routeOf(ctx, '/effort-router/config'), 'GET')
  check('档位: 默认 high', before.body.tiers.high, 'high')

  const bad = await call(routeOf(ctx, '/effort-router/config'), 'POST', { tiers: { max: 'turbo' } })
  check('档位: 非法强度被拒', bad.code, 400)
  check('档位: 拒时不写', ctx.updates.length, 0)

  const saved = await call(routeOf(ctx, '/effort-router/config'), 'POST', { tiers: { high: 'low' } })
  check('档位: 保存成功', saved.code, 200)
  check('档位: 回读 high', saved.body.config.tiers.high, 'low')

  // 判定服务回 high，映射改成 low 之后写进请求的就该是 low
  const agent = { session: { id: 'session-tier', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '看下这段' }] } })
  const config = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }))
  check('档位: 热改生效', config.reasoningEffort, 'low')
}

// 跨站写保护与写入白名单
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const route = routeOf(ctx, '/effort-router/config')

  const plain = await call(route, 'POST', { mode: 'manual' }, '/', 'text/plain')
  check('跨站写: 非 JSON 类型被拒', plain.code, 415)
  check('跨站写: 没落盘', ctx.updates.length, 0)

  const fileUrl = await call(route, 'POST', { judgeUrl: 'file:///etc/passwd' })
  check('judgeUrl: 非 http(s) 被拒', fileUrl.code, 400)

  const badNotify = await call(route, 'POST', { notify: '随时' })
  check('notify: 非法值被拒', badNotify.code, 400)

  const good = await call(route, 'POST', { judgeUrl: 'https://example.com/judge' })
  check('judgeUrl: 合法地址接受', good.code, 200)
}

// 总开关：关掉之后完全不改请求，打开恢复
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const route = routeOf(ctx, '/effort-router/config')

  const off = await call(route, 'POST', { enabled: false })
  check('开关: 保存成功', off.code, 200)
  check('开关: 回读为关', off.body.config.enabled, false)

  const agent = { session: { id: 'session-switch', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '重构这段代码' }] } })
  const closed = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
  check('开关: 关掉后不改强度', closed.reasoningEffort, 'low')

  await call(route, 'POST', { enabled: true })
  const opened = await ctx.handlers.get('agent/request')({ agent, turn: 2, step: 1 },
    async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
  check('开关: 打开后恢复', opened.reasoningEffort, 'high')
}

// 没有设置面：只读，mode 退回内存开关
{
  const ctx = fakeContext({ settings: false })
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })

  const got = await call(routeOf(ctx, '/effort-router/config'), 'GET')
  check('无设置面: 不可写', got.body.writable, false)

  const saved = await call(routeOf(ctx, '/effort-router/config'), 'POST', { mode: 'manual' })
  check('无设置面: 保存落内存', saved.body.persisted, false)
}

// 探活接口：设置页的「测试」按钮靠它，用户不该只能靠发消息才知道配错
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const probe = await call(routeOf(ctx, '/effort-router/probe'), 'POST', {})
  check('探活: 本地判定可用', probe.body.ok, true)
  check('探活: 标注后端', probe.body.backend, 'local')
  check('探活: 带耗时', typeof probe.body.ms, 'number')
}

{
  const ctx = fakeContext()
  ctx.state.judgeUrl = 'http://127.0.0.1:1/judge'
  apply(ctx, { mode: 'auto', judgeUrl: 'http://127.0.0.1:1/judge', startupWaitMs: 0, provision: false })
  const probe = await call(routeOf(ctx, '/effort-router/probe'), 'POST', {})
  check('探活: 连不上时 ok 为假', probe.body.ok, false)
  check('探活: 失败要说原因', probe.body.detail !== '' && typeof probe.body.detail === 'string', true)
}

// 回了个不认识的档位：连得上也不算能用
{
  const oddUrl = `${judgeUrl.slice(0, judgeUrl.lastIndexOf('/'))}/odd`
  const ctx = fakeContext()
  ctx.state.judgeUrl = oddUrl
  apply(ctx, { mode: 'auto', judgeUrl: oddUrl, startupWaitMs: 0, provision: false })
  const probe = await call(routeOf(ctx, '/effort-router/probe'), 'POST', {})
  check('探活: 未知档位不算连通', probe.body.ok, false)
  check('探活: 说明档位不认识', /档位不认识/.test(probe.body.detail || ''), true)
}

// 改过的地址必须先保存：否则任何页面都能借这个接口把凭据发到别处
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const guarded = await call(routeOf(ctx, '/effort-router/probe'), 'POST', { judgeUrl: 'http://example.invalid/judge' })
  check('探活: 改地址未保存时拒绝', guarded.body.ok, false)
  check('探活: 说明要先保存', /先保存/.test(guarded.body.detail || ''), true)
}

// 地址守卫按规范化后的 URL 比：换个大小写不是「改过地址」
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const upper = judgeUrl.replace(/^http:\/\//, 'HTTP://')
  const probe = await call(routeOf(ctx, '/effort-router/probe'), 'POST', { judgeSource: 'local', judgeUrl: upper })
  check('探活: 地址大小写不算改动', probe.body.ok, true)
}

// 凭据名填错时的提示要说得清哪里错，不能只回一句「没有可写的字段」
{
  const ctx = fakeContext()
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const bad = await call(routeOf(ctx, '/effort-router/config'), 'POST', { jevApiKeyEnv: 'my key!' })
  check('凭据名: 拒绝非法字符', bad.body.ok, false)
  check('凭据名: 校验失败回 400', bad.code, 400)
  check('凭据名: 提示点名凭据名', /凭据名/.test(bad.body.detail || ''), true)
}

// 写入被拒：状态码 503，detail 带上宿主给的原因，且确实调过一次 update
{
  const ctx = fakeContext({ updateThrows: true })
  apply(ctx, { mode: 'auto', judgeUrl, startupWaitMs: 0, provision: false })
  const saved = await call(routeOf(ctx, '/effort-router/config'), 'POST', { mode: 'manual' })
  check('写入被拒: 状态码', saved.code, 503)
  check('写入被拒: 带原因', saved.body.detail, 'write refused')
  check('写入被拒: 确实调了 update', ctx.updates.length, 1)
}

judge.closeAllConnections?.()
judge.closeAllConnections?.()
judge.close()
// 等句柄真的关掉，否则 Node 在 Windows 上退出时会报 libuv 断言。
await new Promise((resolve) => setTimeout(resolve, 200))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
