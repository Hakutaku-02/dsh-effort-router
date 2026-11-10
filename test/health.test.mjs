/**
 * 判定服务的可用性状态机：拉起后要等就绪，服务后来起来了状态要跟着回来。
 *
 * 这两条是重启验证里暴露的问题：探一次就判死会把状态永久卡在 failed，
 * 服务明明健康却显示失败。判定在 hold 里跑，所以「判定生效」看的是会话选择被写成了什么。
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { callRoute, makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
delete process.env.ROUTER_EFFORT_STARTUP_WAIT_MS
delete process.env.ROUTER_EFFORT_START_WAIT_MS

const { check, done } = makeChecker()

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

/** 读状态接口。 */
async function judgeState(ctx) {
  const got = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
  return got.body
}

const message = (id, text = '重构这段代码') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** 跑一条用户消息的 hold，返回写完之后的会话强度。 */
async function heldEffort(ctx, agent, id = 'm1') {
  ctx.emit('agent/inbox/inserted', { agent, message: message(id) })
  await agent.settled
  return agent.model.current()?.reasoningEffort
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
    const value = await predicate()
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
    const ctx = makeContext()
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
    const state = await waitFor(async () => (await judgeState(ctx))?.state === 'up' ? 'up' : undefined)
    check('拉起并等待: 状态变 up', state, 'up')
    spawnedPid = Number(readFileSync(pidFile, 'utf8'))

    // 拉起之后判定能拿到档位，写进会话选择
    const agent = makeAgent({ id: 'session-health', provider: 'p', model: 'm', reasoningEffort: 'low' })
    check('拉起之后: 判定生效', await heldEffort(ctx, agent), 'high')
  }

  // 场景二：启动时服务不在线，之后起来了，判定成功要把状态刷回来
  {
    const port = await freePort()
    const ctx = makeContext()
    apply(ctx, {
      mode: 'auto',
      autoStart: false,
      provision: false,
      judgeUrl: `http://127.0.0.1:${port}/judge`,
      startupWaitMs: 0,
    })
    const down = await waitFor(async () => (await judgeState(ctx))?.state === 'down' ? 'down' : undefined, 3000)
    check('启动时不在线: 状态 down', down, 'down')

    // 服务晚到
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'max' }))
    })
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

    const agent = makeAgent({ id: 'session-late', provider: 'p', model: 'm', reasoningEffort: 'low' })
    check('服务晚到: 判定生效', await heldEffort(ctx, agent), 'max')
    check('服务晚到: 状态刷回 up', (await judgeState(ctx))?.state, 'up')
    await new Promise((resolve) => server.close(resolve))
  }
} finally {
  if (spawnedPid !== undefined && Number.isFinite(spawnedPid)) {
    try { process.kill(spawnedPid) } catch { /* 已经退出 */ }
    // 等子进程真的收尾，否则 Node 在 Windows 上退出时会报 libuv 句柄断言。
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

done()
