/**
 * 判定服务的进程生命周期：随 DSH 启动而启动，随 DSH 被结束而结束。
 *
 * 这里用「硬杀」验证：taskkill /F 打掉假 DSH，不给它跑任何退出钩子的机会。
 * 判定服务必须在这个窗口里消失，否则就是会一直占着端口和内存的孤儿进程。
 * 判定服务与假 DSH 都是 node 进程，但走的是插件真实的拉起路径（apply → startService → supervisor.mjs）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { callRoute, makeChecker, makeContext } from './fake-host.mjs'

const workdir = mkdtempSync(join(tmpdir(), 'effort-router-lifecycle-'))
const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
/** 本进程的状态目录也在这里：不隔离的话，第三个用例会读到真实 DSH 写的 service.pid。 */
const effortHome = join(workdir, 'home')
process.env.ROUTER_EFFORT_HOME = effortHome
process.env.ROUTER_EFFORT_LOG = join(workdir, 'trace.log')

const { check, done } = makeChecker()

/** 假判定服务：写自己的 pid，占住端口，然后一直活着。 */
const serviceScript = join(workdir, 'fake-service.mjs')
writeFileSync(serviceScript, [
  'import { createServer } from "node:http"',
  'import { writeFileSync } from "node:fs"',
  'const i = process.argv.indexOf("--port")',
  'writeFileSync(' + JSON.stringify(join(workdir, 'service.pid')) + ', String(process.pid))',
  'createServer((req, res) => res.end("ok")).listen(Number(process.argv[i + 1]), "127.0.0.1")',
].join('\n'))

/** 假 DSH：像宿主那样 apply 插件（judgeSource=local），写自己的 pid，然后一直活着。 */
const judgePort = await freePort()
const dshScript = join(workdir, 'fake-dsh.mjs')
writeFileSync(dshScript, [
  'import { writeFileSync } from "node:fs"',
  'import { apply } from ' + JSON.stringify('file:///' + join(repoRoot, 'index.js').replaceAll('\\', '/')) ,
  'import { makeContext } from ' + JSON.stringify('file:///' + join(repoRoot, 'test', 'fake-host.mjs').replaceAll('\\', '/')),
  'writeFileSync(' + JSON.stringify(join(workdir, 'dsh.pid')) + ', String(process.pid))',
  'const ctx = makeContext({ settings: { judgeSource: "local" } })',
  'apply(ctx, {',
  '  mode: "auto",',
  '  autoStart: true,',
  '  provision: false,',
  '  servicePython: process.execPath,',
  '  serviceScript: ' + JSON.stringify(serviceScript) + ',',
  '  judgeUrl: "http://127.0.0.1:" + ' + JSON.stringify(String(judgePort)) + ' + "/judge",',
  '  startupWaitMs: 0,',
  '  startWaitMs: 5000,',
  '})',
  'setInterval(() => {}, 1000)',
].join('\n'))

async function freePort() {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dsh = spawn(process.execPath, [dshScript], {
  cwd: repoRoot,
  stdio: 'ignore',
  env: { ...process.env, ROUTER_EFFORT_HOME: effortHome, ROUTER_EFFORT_LOG: join(workdir, 'trace.log') },
})
dsh.unref()
const dshPid = dsh.pid

let servicePid
try {
  const spawned = await waitFor(() => existsSync(join(workdir, 'service.pid')))
  check('判定服务被拉起', spawned, true)
  servicePid = Number(readFileSync(join(workdir, 'service.pid'), 'utf8'))
  check('判定服务活着', alive(servicePid), true)
  check('假 DSH 活着', alive(dshPid), true)

  const portOpen = (port) => new Promise((resolve) => {
    const socket = new Socket()
    socket.setTimeout(800)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.on('error', () => resolve(false))
    socket.connect(port, '127.0.0.1')
  })
  const listening = await waitFor(async () => (await portOpen(judgePort)) ? true : undefined, 5000)
  check('判定服务占着端口', listening, true)

  // 只杀假 DSH 自己，不带 /T：Windows 上结束父进程不会连带子进程，
  // 这正是真实场景（任务管理器结束 DSH、崩溃退出）。判定服务能不能跟着走，
  // 取决于看门人对父 pid 的轮询，而不是操作符给我们顺手清子树。
  const killedAt = Date.now()
  spawnSync('taskkill', ['/PID', String(dshPid), '/F'], { windowsHide: true })

  // 看门人每秒轮询一次，DSH 死掉后判定服务应当在这个窗口内消失
  const gone = await waitFor(() => !alive(servicePid), 8000)
  check('DSH 被硬杀后判定服务跟着死', gone, true)
  console.log('   DSH 到判定服务消失：' + (Date.now() - killedAt) + 'ms')
  check('端口被释放', await portOpen(judgePort), false)


} finally {
  for (const pid of [servicePid, dshPid]) {
    if (Number.isFinite(pid) && alive(pid)) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    }
  }
}

// 二、只看轮询机制：看门人的父进程活着，但它盯的那个 pid 死了。
//    这时不会有控制台关闭事件帮它，判定服务能不能走全看轮询。
{
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  dummy.unref()
  const serviceFile = join(workdir, 'service2.pid')
  const serviceScript2 = join(workdir, 'fake-service2.mjs')
  writeFileSync(serviceScript2, [
    'import { createServer } from "node:http"',
    'import { writeFileSync } from "node:fs"',
    'const i = process.argv.indexOf("--port")',
    'writeFileSync(' + JSON.stringify(serviceFile) + ', String(process.pid))',
    'createServer((req, res) => res.end("ok")).listen(Number(process.argv[i + 1]), "127.0.0.1")',
  ].join('\n'))

  const port = await freePort()
  const record = join(effortHome, 'service.pid')
  const supervisor = spawn(process.execPath, [
    join(repoRoot, 'supervisor.mjs'),
    '--python', process.execPath,
    '--script', serviceScript2,
    '--port', String(port),
    '--pid-file', record,
    '--parent', String(dummy.pid),
  ], { stdio: 'ignore' })

  let servicePid2
  try {
    await waitFor(() => existsSync(serviceFile), 8000)
    servicePid2 = Number(readFileSync(serviceFile, 'utf8'))
    check('轮询: 服务起得来', alive(servicePid2), true)
    check('轮询: 看门人活着', supervisor.exitCode === null, true)

    spawnSync('taskkill', ['/PID', String(dummy.pid), '/F'], { windowsHide: true })

    check('轮询: 看门人写下了 pid 记录', existsSync(record), true)
    const stopped = await waitFor(() => supervisor.exitCode !== null, 6000)
    check('轮询: 父 pid 消失后看门人自己退出', stopped, true)
    check('轮询: 服务跟着死', alive(servicePid2), false)
    // 记录抹干净了，下一次启动才不会读到「有人看管」的死记录
    const cleared = await waitFor(() => !existsSync(record), 3000)
    check('轮询: 退出时删掉 pid 记录', cleared, true)
  } finally {
    for (const pid of [servicePid2, dummy.pid, supervisor.pid]) {
      if (Number.isFinite(pid) && alive(pid)) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
}

// 三、服务在线但没有看门人时，状态接口要把这件事说出来，不然用户以为它会随 DSH 退出
{
  const port = await freePort()
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'high' }))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const ctx = makeContext({ settings: { judgeSource: 'local' } })
  apply(ctx, {
    mode: 'auto',
    autoStart: false,
    provision: false,
    judgeUrl: `http://127.0.0.1:${port}/judge`,
    startupWaitMs: 1500,
  })
  const state = await waitFor(async () => {
    const got = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
    return got.body.state === 'up' ? got.body : undefined
  }, 6000)
  check('未托管: 状态里写明不随 DSH 退出', /看门人/.test(state?.detail ?? ''), true)
  await new Promise((resolve) => server.close(resolve))
}

// 四、记录里的看门人 pid 明明活着，但本进程没拉起过它 —— 还是算没人看管。
//    这条盯的是「同一进程内看门人死后，pid 被复用/对象没回收，状态谎报有人在看管」。
{
  const port = await freePort()
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'high' }))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  // 记录里 supervisor 填一个确实活着的 pid（本进程），parent 也是本进程
  writeFileSync(join(effortHome, 'service.pid'), JSON.stringify({
    supervisor: process.pid,
    parent: process.pid,
    service: 1,
    at: Date.now(),
  }) + '\n')
  const ctx = makeContext({ settings: { judgeSource: 'local' } })
  apply(ctx, {
    mode: 'auto',
    autoStart: false,
    provision: false,
    judgeUrl: `http://127.0.0.1:${port}/judge`,
    startupWaitMs: 1500,
  })
  const state = await waitFor(async () => {
    const got = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
    return got.body.state === 'up' ? got.body : undefined
  }, 6000)
  check('残留记录: 活着的 pid 也不算看管', /看门人/.test(state?.detail ?? ''), true)
  await new Promise((resolve) => server.close(resolve))
}

// 五、跨进程的兜底：记录里的父 DSH 和看门人都活着，就算有人看管（多个 DSH 共用一个服务的场景）。
//    这条与上面第四条是同一段逻辑的两侧：那边防谎报，这边保证不误报。
{
  const port = await freePort()
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'high' }))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const otherDsh = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    writeFileSync(join(effortHome, 'service.pid'), JSON.stringify({
      supervisor: process.pid,
      parent: otherDsh.pid,
      service: 1,
      at: Date.now(),
    }) + '\n')
    const ctx = makeContext({ settings: { judgeSource: 'local' } })
    apply(ctx, {
      mode: 'auto',
      autoStart: false,
      provision: false,
      judgeUrl: `http://127.0.0.1:${port}/judge`,
      startupWaitMs: 1500,
    })
    const state = await waitFor(async () => {
      const got = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
      return got.body.state === 'up' ? got.body : undefined
    }, 6000)
    check('跨进程: 别处看管着时不报未托管', state?.detail ?? '', '')
  } finally {
    spawnSync('taskkill', ['/PID', String(otherDsh.pid), '/T', '/F'], { windowsHide: true })
    await new Promise((resolve) => server.close(resolve))
  }
}

done()
