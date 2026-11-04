/**
 * 判定服务的可用性状态机：拉起后要等就绪，服务后来起来了状态要跟着回来。
 *
 * 这两条是重启验证里暴露的问题：探一次就判死会把状态永久卡在 failed，
 * 服务明明健康却显示失败。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
delete process.env.ROUTER_EFFORT_STARTUP_WAIT_MS
delete process.env.ROUTER_EFFORT_START_WAIT_MS

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

/** 假判定服务：跑起来会写 pid 文件，方便测试收尾时杀掉它。 */
function fakeServiceSource(pidFile) {
  return `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const portIndex = process.argv.indexOf('--port')
const port = Number(process.argv[portIndex + 1])
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ protocol: 'finetuned' }))
    return
  }
  if (req.url === '/judge') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ tier: 'high' }))
    return
  }
  res.statusCode = 404
  res.end()
}).listen(port, '127.0.0.1')
`
}

/** 假上下文：带 webServer 收集路由，带 llm 给档位，带 sessionProjections 给模型。 */
function fakeContext() {
  const handlers = new Map()
  const routes = []
  return {
    handlers,
    routes,
    on(event, handler) { handlers.set(event, handler) },
    get(name) {
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
        fn({ get: () => ({ register(options) { routes.push(options); return () => {} } }), effect(run) { run() } })
      }
    },
    effect(fn) { fn() },
  }
}

function judgeState(ctx) {
  const route = ctx.routes.find((entry) => entry.path === '/effort-router/judge')
  if (route === undefined) return undefined
  let body = ''
  route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(text) { body = text } })
  return body === '' ? undefined : JSON.parse(body)
}

/** 拿一个空闲端口：起服务问内核，然后关掉。 */
async function freePort() {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'effort-router-health-'))
const scriptPath = join(workdir, 'fake-judge.mjs')
const pidFile = join(workdir, 'pid.txt')
writeFileSync(scriptPath, fakeServiceSource(pidFile))

let spawnedPid
try {
  // 场景一：按配置路径拉起，等它就绪，状态变 up
  {
    const port = await freePort()
    const ctx = fakeContext()
    apply(ctx, {
      mode: 'auto',
      autoStart: true,
      provision: false,
      servicePython: process.execPath,
      serviceScript: scriptPath,
      judgeUrl: `http://127.0.0.1:${port}/judge`,
      startupWaitMs: 0,
      startWaitMs: 8000,
    })
    const state = await waitFor(() => judgeState(ctx)?.state === 'up' ? 'up' : undefined)
    check('拉起并等待: 状态变 up', state, 'up')
    spawnedPid = Number(readFileSync(pidFile, 'utf8'))

    // 拉起之后判定能拿到档位
    const agent = { session: { id: 'session-health', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
    ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '重构这段代码' }] } })
    const config = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 },
      async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
    check('拉起之后: 判定生效', config.reasoningEffort, 'high')
  }

  // 场景二：启动时服务不在线，之后起来了，判定成功要把状态刷回来
  {
    const port = await freePort()
    const ctx = fakeContext()
    apply(ctx, {
      mode: 'auto',
      autoStart: false,
      provision: false,
      judgeUrl: `http://127.0.0.1:${port}/judge`,
      startupWaitMs: 0,
    })
    const down = await waitFor(() => judgeState(ctx)?.state === 'down' ? 'down' : undefined, 3000)
    check('启动时不在线: 状态 down', down, 'down')

    // 服务晚到
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'max' }))
    })
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

    const agent = { session: { id: 'session-late', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
    ctx.handlers.get('agent/inbox/claimed')({ agent, message: { content: [{ type: 'text', text: '再看看这段' }] } })
    const config = await ctx.handlers.get('agent/request')({ agent, turn: 1, step: 1 },
      async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }))
    check('服务晚到: 判定生效', config.reasoningEffort, 'max')
    check('服务晚到: 状态刷回 up', judgeState(ctx)?.state, 'up')
    await new Promise((resolve) => server.close(resolve))
  }
} finally {
  if (spawnedPid !== undefined && Number.isFinite(spawnedPid)) {
    try { process.kill(spawnedPid) } catch { /* 已经退出 */ }
    // 等子进程真的收尾，否则 Node 在 Windows 上退出时会报 libuv 句柄断言。
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
