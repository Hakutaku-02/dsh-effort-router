/**
 * 首次部署的接线测试：用一个假的 laya 包（bin/setup.mjs 只写标记再退出），
 * 验证插件确实把子进程拉起来了、环境变量和 cwd 传对了、退出码被正确处理。
 * 不需要真的 laya 包，不下载权重，不联网。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { callRoute, makeAgent, makeChecker, makeContext } from './fake-host.mjs'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
process.env.ROUTER_EFFORT_START_WAIT_MS = '0'

const { check, done } = makeChecker()

/** 造一个只含 bin/setup.mjs 的假包；标记写到 pid 文件，退出码由参数决定。 */
function fakeLayaPackage(exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'fake-laya-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  const marker = join(root, 'setup-ran.json')
  writeFileSync(join(root, 'bin', 'setup.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  cwd: process.cwd(),
  judgeUrl: process.env.LAYA_ROUTER_URL,
  timeout: process.env.LAYA_START_TIMEOUT,
}))
process.exit(${exitCode})
`)
  return { root, marker }
}

const message = (id, text = '改这段代码') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

// 部署成功：子进程被拉起，环境变量与 cwd 正确
{
  const { root, marker } = fakeLayaPackage(0)
  apply(makeContext(), {
    mode: 'auto',
    autoStart: false,
    judgeUrl: 'http://127.0.0.1:1/judge',
    layaDir: root,
  })
  const ran = await waitFor(() => existsSync(marker))
  check('部署: 子进程跑起来了', ran, true)
  if (ran) {
    const seen = JSON.parse(readFileSync(marker, 'utf8'))
    check('部署: 传了判定服务地址', seen.judgeUrl, 'http://127.0.0.1:1/judge')
    check('部署: 冷启动超时给了 300 秒', seen.timeout, '300')
    check('部署: cwd 是假包目录', seen.cwd, root)
  }
  // Windows 上子进程可能还占着目录，删不掉就留给系统清，不影响断言。
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }) } catch { /* 忽略 */ }
}

// provision: false 时不部署
{
  const { root, marker } = fakeLayaPackage(0)
  apply(makeContext(), {
    mode: 'auto',
    autoStart: false,
    provision: false,
    judgeUrl: 'http://127.0.0.1:1/judge',
    layaDir: root,
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  check('provision 关闭: 不动子进程', existsSync(marker), false)
  // Windows 上子进程可能还占着目录，删不掉就留给系统清，不影响断言。
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }) } catch { /* 忽略 */ }
}

// 部署失败：子进程非零退出，不抛错、不影响后续请求
{
  const { root, marker } = fakeLayaPackage(1)
  const ctx = makeContext()
  apply(ctx, {
    mode: 'auto',
    autoStart: false,
    judgeUrl: 'http://127.0.0.1:1/judge',
    layaDir: root,
    provisionWaitMs: 0,
  })
  const ran = await waitFor(() => existsSync(marker))
  check('部署失败: 子进程跑过了', ran, true)

  // 判定服务不可用就落兜底档，但这一轮必须照常放行：会话选择保持原样，hold 不卡住
  const agent = makeAgent({ id: 'session-provision', provider: 'p', model: 'm', reasoningEffort: 'low' })
  ctx.emit('agent/inbox/inserted', { agent, message: message('m1') })
  await agent.settled
  check('部署失败: 请求原样', agent.model.current(), { provider: 'p', model: 'm', reasoningEffort: 'low' })
  check('部署失败: hold 已放开', agent.status, 'idle')

  // 状态接口把失败说清楚，不影响路由
  const status = await waitFor(async () => {
    const got = await callRoute(ctx, '/effort-router/judge', undefined, { method: 'GET', headers: {} })
    return got.body.state === 'failed' ? got.body : undefined
  })
  check('部署失败: 状态接口报 failed', status?.state, 'failed')
  check('部署失败: 带上部署日志位置', status?.setupLog !== '', true)
  check('部署失败: 说明部署失败原因', /部署脚本/.test(status?.detail || ''), true)
  // Windows 上子进程可能还占着目录，删不掉就留给系统清，不影响断言。
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }) } catch { /* 忽略 */ }
}

done()
