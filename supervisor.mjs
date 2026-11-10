/**
 * 判定服务的看门人：把 Python 服务挂在自己下面跑，DSH 一没了就把它一起带走。
 *
 * 为什么需要这一层：Windows 不会因为父进程退出就杀掉子进程。直接 detached 拉起的 python 会
 * 一直占着 8765 和约 2GB 内存，DSH 关掉、甚至被任务管理器结束之后它还活着，只能手动清。
 *
 * 做法：插件拉起本脚本时把 DSH 的 pid 传进来（--parent）。本脚本每秒看一次那个 pid 还在不在，
 * 不在了就用 taskkill /T 结束 python 子进程，然后自己退出。
 * /T 是必要的：venv 的 pythonw.exe 只是个转发器，真正的解释器是它的子进程，只杀父进程会留下孤儿。
 *
 * 判定服务自己退出时（端口被别人占着、权重缺失），本脚本跟着退出，不重拉。要不要再拉由插件决定。
 */
import { spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const python = option('--python')
const script = option('--script')
const port = option('--port') ?? '8765'
const model = option('--model')
const parent = Number(option('--parent'))
/** 看父进程的间隔。1 秒意味着 DSH 死掉后判定服务最多多活 1 秒。 */
const POLL_MS = 1000

if (!python || !script) {
  process.stderr.write('[supervisor] 缺少 --python 或 --script\n')
  process.exit(1)
}

const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
if (typeof model === 'string' && model !== '') env.LAYA_MODEL = model

const child = spawn(python, [script, '--http', '--port', port], {
  stdio: ['ignore', 'ignore', 'inherit'],
  windowsHide: true,
  env,
})

/** 判定服务的 stderr 与 stdout 都进本进程的 stderr，也就是插件给的那个日志句柄。 */
function log(message) {
  process.stderr.write('[supervisor] ' + message + '\n')
}

log('启动 ' + python + '（pid ' + (child.pid ?? '?') + '），看父进程 ' + parent)

child.on('error', (error) => {
  log('拉起失败：' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})

child.on('exit', (code, signal) => {
  log('判定服务退出（code ' + code + '，signal ' + signal + '）')
  process.exit(code === null ? 0 : code)
})

/** 父进程还在不在。pid 被系统复用时会误判为活着，代价是判定服务多留一会儿。 */
function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let stopping = false
function stop(reason) {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  log(reason + '，结束判定服务')
  if (child.pid !== undefined) {
    if (process.platform === 'win32') {
      // /T 带上子进程：venv 的 pythonw.exe 之下还有真正的解释器。
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  }
  process.exit(0)
}

const timer = setInterval(() => {
  if (!alive(parent)) stop('父进程 ' + parent + ' 已退出')
}, POLL_MS)

// DSH 主动结束本进程（正常退出路径）时也要带走服务。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop('收到 ' + signal))
}
process.on('exit', () => {
  if (!stopping && child.pid !== undefined && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
})
