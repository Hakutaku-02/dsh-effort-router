/**
 * 本地判定服务（judgeSource=local）的三条接线测试。
 *
 * 这三条都是「服务明明能用、插件却用不上」的具体成因，逐条钉住：
 * 1. 拉起时不传 LAYA_MODEL，服务会退成基座协议（/judge 没有 tier）；
 * 2. 挂载时是 jev、后来在设置页切成 local，没人再拉起服务；
 * 3. 判定输入发全文：截断会改判定结果，本地服务与 Jev 都按 MAX_TASK_CHARS 发。
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { callRoute, makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
process.env.ROUTER_EFFORT_START_WAIT_MS = '3000'

const { check, done } = makeChecker({ exit: false })

const message = (id, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 拿一个空闲端口：起服务问内核，然后关掉。 */
async function freePort() {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 假判定服务：/health 报 finetuned，/judge 回 max，并把收到的任务长度记下来。 */
function startFakeJudge(port, recordPath) {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/health') {
        res.end(JSON.stringify({ protocol: 'finetuned' }))
        return
      }
      const body = JSON.parse(raw || '{}')
      seen.push(body.task)
      writeFileSync(recordPath, JSON.stringify(seen))
      res.end(JSON.stringify({ tier: 'max' }))
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }))
  })
}

const workdir = mkdtempSync(join(tmpdir(), 'effort-router-local-'))

// 一、拉起判定服务时把权重目录作为 LAYA_MODEL 传下去
{
  const marker = join(workdir, 'spawn-env.json')
  const script = join(workdir, 'fake-judge-spawn.mjs')
  writeFileSync(script, 'import { writeFileSync } from "node:fs"\n'
    + 'writeFileSync(' + JSON.stringify(marker) + ', JSON.stringify({ model: process.env.LAYA_MODEL ?? null }))\n'
    + 'process.exit(0)\n')
  apply(makeContext(), {
    mode: 'auto',
    autoStart: true,
    provision: false,
    servicePython: process.execPath,
    serviceScript: script,
    serviceModel: 'D:\\\\weights\\\\lay a model',
    judgeUrl: `http://127.0.0.1:${await freePort()}/judge`,
  })
  const ran = await waitFor(() => existsSync(marker))
  check('拉起: 子进程跑起来了', ran, true)
  check('拉起: 权重目录当 LAYA_MODEL 传下去', JSON.parse(readFileSync(marker, 'utf8')).model, 'D:\\\\weights\\\\lay a model')
}

// 二、挂载时是 jev，用户随后切成 local：判定时要自己把服务拉起来
{
  const port = await freePort()
  // 假服务脚本：由 node 拉起来，监听端口。写 pid 是为了测试收尾能杀掉它。
  const serviceScript = join(workdir, 'fake-service.mjs')
  writeFileSync(serviceScript, 'import { createServer } from "node:http"\n'
    + 'const i = process.argv.indexOf("--port")\n'
    + 'createServer((req, res) => {\n'
    + '  let raw = ""\n'
    + '  req.on("data", (c) => { raw += c })\n'
    + '  req.on("end", () => {\n'
    + '    if (req.url === "/shutdown") { res.end(); process.exit(0); return }\n'
    + '    res.setHeader("Content-Type", "application/json")\n'
    + '    if (req.url === "/health") return res.end(JSON.stringify({ protocol: "finetuned" }))\n'
    + '    res.end(JSON.stringify({ tier: "high" }))\n'
    + '  })\n'
    + '}).listen(Number(process.argv[i + 1]), "127.0.0.1")\n')

  const ctx = makeContext({ settings: { judgeSource: 'jev', judgeUrl: `http://127.0.0.1:${port}/judge` } })
  apply(ctx, {
    mode: 'auto',
    autoStart: true,
    provision: false,
    startupWaitMs: 0,
    startWaitMs: 3000,
    servicePython: process.execPath,
    serviceScript,
    judgeUrl: `http://127.0.0.1:${port}/judge`,
  })

  // 设置面是热改的：把 judgeSource 改成 local，等价于用户在设置页切到「本地」
  ctx.state.judgeSource = 'local'
  const before = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
  check('切换后: 还没人拉起服务', before.body.state === 'up', false)

  const agent = makeAgent({ id: 'session-switch', provider: 'p', model: 'm', reasoningEffort: 'low' })
  ctx.emit('agent/inbox/inserted', { agent, message: message('m1', '把这段代码重构一下') })
  await agent.settled
  // 这一轮的判定必然落空（服务还在起），但拉起动作必须已经发生
  const up = await waitFor(async () => {
    const state = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
    return state.body.state === 'up' ? 'up' : undefined
  })
  check('切换后: 自动拉起并把状态刷回 up', up, 'up')

  // 服务就绪之后，下一轮判定生效
  const second = makeAgent({ id: 'session-switch', provider: 'p', model: 'm', reasoningEffort: 'low' })
  ctx.emit('agent/inbox/inserted', { agent: second, message: message('m2', '把这段代码重构一下') })
  await second.settled
  check('切换后: 下一轮判定生效', second.model.current()?.reasoningEffort, 'high')

  // 让假服务自己退出：从外部 process.kill 会在 Windows 上留下未关闭的句柄，进程退出时断言。
  await new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/shutdown', method: 'POST' }, () => resolve())
    request.on('error', () => resolve())
    request.end()
  })
  // 等子进程的退出事件被回收：否则 process.exit 与句柄关闭撞在一起，Windows 上会断言。
  await new Promise((resolve) => setTimeout(resolve, 500))
}

// 三、两个后端都发全文（截断会改判定结果）
{
  const port = await freePort()
  const recordPath = join(workdir, 'slice-local.json')
  const fake = await startFakeJudge(port, recordPath)
  const long = '要'.repeat(2000)
  const ctx = makeContext({ settings: { judgeSource: 'local' } })
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, startupWaitMs: 0, judgeUrl: `http://127.0.0.1:${port}/judge` })
  const agent = makeAgent({ id: 'session-slice', provider: 'p', model: 'm', reasoningEffort: 'low' })
  ctx.emit('agent/inbox/inserted', { agent, message: message('m1', long) })
  await agent.settled
  check('本地: 发全文', fake.seen[0].length, 2000)
  check('本地: 判定生效', agent.model.current()?.reasoningEffort, 'max')
  // 先掐掉连接再等 close：全局 agent 会留着 keep-alive 的 socket，句柄在进程退出时才关就会断言。
  fake.server.closeAllConnections?.()
  await new Promise((resolve) => fake.server.close(resolve))
}

{
  const port = await freePort()
  const recordPath = join(workdir, 'slice-jev.json')
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      seen.push(body.state ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ answers: { effort: { choice: 'high', confidence: 0.9 } } }))
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const long = '要'.repeat(2000)
  const ctx = makeContext({ settings: { judgeSource: 'jev', jevApiKeyEnv: 'LOCAL_TEST_KEY' }, credentials: { LOCAL_TEST_KEY: 'k' } })
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, startupWaitMs: 0, judgeUrl: 'http://127.0.0.1:1/judge', jevUrl: `http://127.0.0.1:${port}/v1/systemone` })
  const agent = makeAgent({ id: 'session-slice-jev', provider: 'p', model: 'm', reasoningEffort: 'low' })
  ctx.emit('agent/inbox/inserted', { agent, message: message('m1', long) })
  await agent.settled
  check('jev: 发全文', seen[0].length, 2000)
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

done()
