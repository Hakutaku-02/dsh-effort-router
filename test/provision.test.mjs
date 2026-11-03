/**
 * 首次部署的接线测试：用一个假的 laya 包（bin/setup.mjs 只写标记再退出），
 * 验证插件确实把子进程拉起来了、环境变量和 cwd 传对了、退出码被正确处理。
 * 不需要真的 laya 包，不下载权重，不联网。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'
process.env.ROUTER_EFFORT_START_WAIT_MS = '0'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

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

function fakeContext() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler) },
    get() { return undefined },
    inject() { /* 没有 webServer */ },
    effect(fn) { fn() },
  }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// 部署成功：子进程被拉起，环境变量与 cwd 正确
{
  const { root, marker } = fakeLayaPackage(0)
  apply(fakeContext(), {
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
  }
  rmSync(root, { recursive: true, force: true })
}

// provision: false 时不部署
{
  const { root, marker } = fakeLayaPackage(0)
  apply(fakeContext(), {
    mode: 'auto',
    autoStart: false,
    provision: false,
    judgeUrl: 'http://127.0.0.1:1/judge',
    layaDir: root,
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  check('provision 关闭: 不动子进程', existsSync(marker), false)
  rmSync(root, { recursive: true, force: true })
}

// 部署失败：子进程非零退出，不抛错、不影响后续请求
{
  const { root, marker } = fakeLayaPackage(1)
  const ctx = fakeContext()
  apply(ctx, {
    mode: 'auto',
    autoStart: false,
    judgeUrl: 'http://127.0.0.1:1/judge',
    layaDir: root,
  })
  const ran = await waitFor(() => existsSync(marker))
  check('部署失败: 子进程跑过了', ran, true)
  const base = { provider: 'p', model: 'm', reasoningEffort: 'low' }
  check('部署失败: 请求原样返回', await ctx.handlers.get('agent/request')({ agent: { session: { id: 's' } }, turn: 1 }, async () => base), base)
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
