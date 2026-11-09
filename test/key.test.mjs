/**
 * Key 面板：GET 报状态不回值，POST 写进宿主凭据服务，打开凭据文件不接受外部路径。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = join(tmpdir(), 'router-effort-test.log')
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

function fakeContext(options = {}) {
  const routes = []
  const writes = []
  const state = { mode: 'auto', judgeSource: 'jev', notify: '', tiers: {}, jevApiKeyEnv: 'TEST_KEY_REF' }
  let configured = options.configured === true
  const credentials = options.credentials === false ? undefined : {
    async describe(ref) {
      if (options.describeThrows === true) throw new Error('store unreadable')
      return { configured, source: configured ? 'file' : undefined, writable: true }
    },
    async set(ref, value) {
      if (options.setThrows === true) throw new Error('write refused')
      writes.push({ ref, value })
      configured = true
    },
  }
  return {
    routes,
    writes,
    state,
    on() {},
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'settings') {
        return {
          describe() { return [{ ns: 'effort-router', value: { ...state } }] },
          async update(ns, patch) { Object.assign(state, patch) },
        }
      }
      if (name === 'llm') return { async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } } } }
      if (name === 'sessionProjections') return { stateOf: () => ({ lastUsed: { provider: 'p', model: 'm' } }) }
      return undefined
    },
    inject(services, fn) {
      if (services.includes('webServer')) fn({ get: () => ({ register(entry) { routes.push(entry); return () => {} } }), effect(run) { run() } })
    },
    effect(fn) { fn() },
  }
}

function call(route, method, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url: '/',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      on(event, fn) { listeners[event] = fn },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ code: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) }) },
    }
    route.handler(req, res)
    if (method === 'POST') {
      if (body !== undefined) listeners.data?.(JSON.stringify(body))
      listeners.end?.()
    }
  })
}

const routeOf = (ctx, path) => ctx.routes.find((entry) => entry.path === path)
const mount = (ctx) => apply(ctx, { mode: 'auto', startupWaitMs: 0, provision: false })

// 状态：未配置时报未配置，且不回传值
{
  const ctx = fakeContext()
  mount(ctx)
  const got = await call(routeOf(ctx, '/effort-router/key'), 'GET')
  check('Key: 状态码', got.code, 200)
  check('Key: 未配置', got.body.configured, false)
  check('Key: 用已保存的引用名', got.body.ref, 'TEST_KEY_REF')
  check('Key: 可写', got.body.writable, true)
  check('Key: 不回传值', Object.prototype.hasOwnProperty.call(got.body, 'value'), false)
}

// 写入：空值与超长被拒，正常值写进凭据服务后状态变已配置
{
  const ctx = fakeContext()
  mount(ctx)
  const route = routeOf(ctx, '/effort-router/key')

  const empty = await call(route, 'POST', { key: '   ' })
  check('Key: 空值被拒', empty.code, 400)
  check('Key: 空值不写', ctx.writes.length, 0)

  const tooLong = await call(route, 'POST', { key: 'x'.repeat(4097) })
  check('Key: 超长被拒', tooLong.code, 400)

  const saved = await call(route, 'POST', { key: '  sk-test-value  ' })
  check('Key: 写入状态码', saved.code, 200)
  check('Key: 写入已裁剪', ctx.writes[0], { ref: 'TEST_KEY_REF', value: 'sk-test-value' })
  check('Key: 写入后已配置', saved.body.configured, true)
  check('Key: 写入后回源', saved.body.source, 'file')

  const after = await call(route, 'GET')
  check('Key: 再读已配置', after.body.configured, true)
}

// 没有凭据服务：只读状态，写入 503
{
  const ctx = fakeContext({ credentials: false })
  mount(ctx)
  const route = routeOf(ctx, '/effort-router/key')
  const got = await call(route, 'GET')
  check('Key: 无服务时不可写', got.body.writable, false)
  check('Key: 无服务时未配置', got.body.configured, false)
  const saved = await call(route, 'POST', { key: 'sk-test-value' })
  check('Key: 无服务时写入 503', saved.code, 503)
}

// 描述失败与写入失败都要有可见原因
{
  const ctx = fakeContext({ describeThrows: true })
  mount(ctx)
  const got = await call(routeOf(ctx, '/effort-router/key'), 'GET')
  check('Key: 描述失败按未配置', got.body.configured, false)
}
{
  const ctx = fakeContext({ setThrows: true })
  mount(ctx)
  const saved = await call(routeOf(ctx, '/effort-router/key'), 'POST', { key: 'sk-test-value' })
  check('Key: 写入失败 503', saved.code, 503)
  check('Key: 写入失败带原因', saved.body.detail.includes('write refused'), true)
}

// 同源检查：跨站页面写不进 Key，本页请求照常
{
  const ctx = fakeContext()
  mount(ctx)
  const route = routeOf(ctx, '/effort-router/key')
  const crossSite = await call(route, 'POST', { key: 'sk-evil' }, { 'sec-fetch-site': 'cross-site' })
  check('同源: 跨站写 Key 被拒', crossSite.code, 403)
  check('同源: 跨站不写入', ctx.writes.length, 0)

  const badOrigin = await call(route, 'POST', { key: 'sk-evil' }, { origin: 'http://evil.example', host: '127.0.0.1:5882' })
  check('同源: 外部 Origin 被拒', badOrigin.code, 403)

  const same = await call(route, 'POST', { key: 'sk-ok' }, { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:5882', host: '127.0.0.1:5882' })
  check('同源: 本页写入放行', same.code, 200)
}

// 配置里的引用名不合法：拒绝写入，别把凭据文件写坏
{
  const ctx = fakeContext()
  ctx.state.jevApiKeyEnv = 'bad-name'
  mount(ctx)
  const bad = await call(routeOf(ctx, '/effort-router/key'), 'POST', { key: 'sk-jev' })
  check('Key: 非法引用名被拒', bad.code, 400)
  check('Key: 非法引用名不写', ctx.writes.length, 0)
}

// 旧配置指向共用 key 时：写 Jev 专用名并改配置，别顶掉 provider 的 key
{
  const ctx = fakeContext()
  ctx.state.jevApiKeyEnv = 'TOKENFLUX_API_KEY'
  mount(ctx)
  const saved = await call(routeOf(ctx, '/effort-router/key'), 'POST', { key: 'sk-jev' })
  check('Key: 写入专用引用', ctx.writes[0], { ref: 'TOKENFLUX_JEV_KEY', value: 'sk-jev' })
  check('Key: 配置改成专用引用', ctx.state.jevApiKeyEnv, 'TOKENFLUX_JEV_KEY')
  check('Key: 回读已配置', saved.body.configured, true)
}

// 打开凭据文件：路径固定，文件不存在回 404，方法不对回 405
{
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'effort-router-dsh-'))
  const ctx = fakeContext()
  mount(ctx)
  const route = routeOf(ctx, '/effort-router/open-credentials')
  const missing = await call(route, 'POST', {})
  check('凭据文件: 不存在回 404', missing.code, 404)
  check('凭据文件: 提示里带路径', missing.body.detail.includes('.credentials.yaml'), true)
  const wrong = await call(route, 'GET')
  check('凭据文件: GET 回 405', wrong.code, 405)
  delete process.env.DSH_HOME
}

// 旧路径别名也在
{
  const ctx = fakeContext()
  mount(ctx)
  check('别名: key', routeOf(ctx, '/router-effort/key') !== undefined, true)
  check('别名: open-credentials', routeOf(ctx, '/router-effort/open-credentials') !== undefined, true)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)