/**
 * effort-router —— 按任务难度调整当前模型的思考强度。
 *
 * 它只改一个字段：`reasoningEffort`。provider 和 model 保持你（或 agent 默认模型）
 * 选的那个，所以换任何厂商、任何新加的 provider 都自动适用。
 *
 * 流程：用户消息进 inbox 时把这句话发给判定服务，拿一个档位（low / high / max），
 * 把档位映射成强度名，在目标模型真正支持的强度里挑一个落位，用
 * `agent.model.select()` 写进会话选择。判定跑在 `agent.runMaintenance()` 里，本轮唤醒
 * 被扣住到写完为止——0.2.2 在 pre-step 之前就快照模型选择，晚于这个点写只对下一步生效。
 *
 * 判定服务不可用时会落兜底档位（该会话上一轮的档位，没有就用 tiers.fallback），不阻塞这一轮。
 *
 * 模块划分：
 * - `effort.mjs`：强度词汇，以及「判定档位 → 模型自己的强度」的落位规则；
 * - `config/`：配置项的名字与默认值、本轮配置的合成、设置补丁的校验；
 * - `http/`：九条插件路由，只做传输与请求校验；
 * - 本文件：判定、凭据、落位写入、落盘记录、服务生命周期与事件接线。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
// profile 提供的 peer：包落在能解析到 harness 的 node_modules 下就能裸解析。
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_JEV_CONFIDENCE,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_URL,
  DEFAULT_JUDGE,
  DEFAULT_TIERS,
  JEV_KEY_REF,
  JEV_TIMEOUT_MS,
  JUDGE_SOURCES,
  JUDGE_TIMEOUT_MS,
  JUDGE_TIERS,
  MODES,
  TIER_KEYS,
  resolveLive,
  toMs,
  valueOf,
} from './config/settings.mjs'
import { validatePatch } from './config/validate.mjs'
import { pickForTier, strengthOf } from './effort.mjs'
import { ROUTE_PREFIXES, createRoutes } from './http/routes.mjs'
// 强度词汇与落位规则在 effort.mjs；测试与外部脚本按包入口取。
export { ladderOf, pickByLadder, pickEffort, strengthOf } from './effort.mjs'

export const name = 'effort-router'

/** 拉起判定服务失败后，隔多久再自动试一次。 */
const JUDGE_START_RETRY_MS = 60000
/** 部署（装 venv、下权重）失败后的冷却：那条路每次都重跑整个脚本，不该每分钟来一次。 */
const JUDGE_DEPLOY_RETRY_MS = 30 * 60000
/** 会话级内存表的容量上限。会话数是外部输入，不设上限这两张表会一直涨。 */
const MAX_SESSION_ENTRIES = 200
/**
 * 凭据写入的重试间隔。
 *
 * 宿主用「写临时文件 + rename」提交凭据文件。Windows 上杀软扫描新文件、编辑器打开着
 * 目标文件，都会让 rename 短暂报 EPERM/EACCES/EBUSY；宿主自己只重试约 1 秒，不够。
 * 这里在调用层再补几次，用户不用知道发生了什么就存进去了。
 */
const CREDENTIAL_WRITE_RETRY_MS = [400, 900, 1800]
/** Windows 上 rename 被暂时挡住的错误码。 */
const TRANSIENT_CREDENTIAL_CODES = ['EPERM', 'EACCES', 'EBUSY']
const MAX_TASK_CHARS = 4000
const SERVICE_LOG_PATH = `${tmpdir()}/laya-router-service.log`
/** 首次部署的完整输出。pip、权重下载、服务启动日志都在这里。 */
const SETUP_LOG_PATH = `${tmpdir()}/router-effort-setup.log`
/** 挂载痕迹。宿主没有稳定的 stderr 落盘，这里记一行，重启后能确认插件到底有没有挂上。 */
const MOUNT_LOG_PATH = `${tmpdir()}/router-effort.log`
/** 最近判定的保留条数。落盘和芯片列表都用它。 */
const MAX_RECENT = 100
/**
 * 落盘记录的格式版本。
 *
 * 2 起记录带 picked / baseline / floor：判定落位值、写之前的强度、被下限挡住时挡住的值。
 * 有了这三个字段，「这个强度是谁写的」就不再靠猜。版本 1 的记录（0.4.0 之前的插件写的）
 * 只有 tier 与 effort，加载时按 migrateRecord 的规则迁移。
 */
const RECORD_SCHEMA_VERSION = 2
/** 档位没变化时，最多这么久也刷一次盘。 */
const SAVE_INTERVAL_MS = 60000
/** 模型档位缓存的容量上限，防止外部传入的端点名把这张表撑大。 */
const MAX_MODEL_CACHE = 200
/**
 * 三个档位的判定描述。
 *
 * Jev 是分类器，喂给它的 criteria 直接决定分档。用英文写：它的训练语料以英文为主，
 * 中文判别精度官方明确弱一些。用户原文仍然原样作为 state 传进去。
 */
const TIER_CRITERIA = {
  low: 'Greetings, acknowledgements, simple factual recall, formatting tweaks, single-line edits, or a question answerable at a glance.',
  high: 'Routine code writing, summaries, translation, concept explanations, simple debugging, or a single-file change.',
  max: 'Multi-file refactoring, architecture design, performance work, mathematical proofs, security analysis, or concurrency debugging.',
}

/**
 * 配置 schema。
 *
 * mode / judgeUrl / notify 标 volatile：设置页改完即时生效，不必重挂。声明 schema 之后，
 * 没有列在这里的配置字段会被剥掉，所以现有字段必须全部写上。
 */
export const Config = z.object({
  // 总开关：关掉就完全不改请求，等同 manual。
  enabled: z.boolean().default(true).volatile(),
  mode: z.union(MODES).default('auto').volatile(),
  judgeSource: z.union(JUDGE_SOURCES).default('local').volatile(),
  judgeUrl: z.string().default(DEFAULT_JUDGE).volatile(),
  // Jev 走决策协议，不是 chat：地址、模型名、凭据引用都要单独配。
  jevUrl: z.string().default(DEFAULT_JEV_URL).volatile(),
  jevModel: z.string().default(DEFAULT_JEV_MODEL).volatile(),
  jevApiKeyEnv: z.string().default(JEV_KEY_REF).volatile(),
  jevConfidence: z.number().default(DEFAULT_JEV_CONFIDENCE).volatile(),
  jevTimeoutMs: z.number().default(JEV_TIMEOUT_MS),
  /**
   * 判定预算。判定跑在 hold 里，这个值直接决定首 token 晚到多久。
   *
   * 这里不给 default：schema 默认值会被写进 describe() 的 value，按后端区分的默认预算
   * 就永远轮不到（以前本地 1200 会盖掉 Jev 的 3000）。留空由 live() 按后端决定。
   */
  judgeTimeoutMs: z.number().volatile(),
  /**
   * 旧记录缺归属标记时的口径。
   *
   * true：按「插件自己写的」处理（旧版每轮都写会话选择，记录里的强度就是它写的）。
   * false：按「用户手动设的下限」处理，回到 0.4.0 的保守行为。
   */
  legacyOwned: z.boolean().default(true).volatile(),
  notify: z.string().default('').volatile(),
  tiers: z.dict(z.string()).volatile(),
  autoStart: z.boolean(),
  servicePython: z.string(),
  serviceScript: z.string(),
  /**
   * 判定服务的权重目录，拉起时作为 LAYA_MODEL 传给 laya_router.py。
   *
   * 权重目录写在别处（别的盘、镜像目录）时在这里指路。空着时服务去 <包目录>/weights/model
   * 找权重，找不到就退成基座协议：/health 报 protocol=base，/judge 不带 tier，插件两头都用不了。
   */
  serviceModel: z.string(),
  provision: z.boolean(),
  layaDir: z.string(),
  startupWaitMs: z.number(),
  startWaitMs: z.number(),
  provisionWaitMs: z.number(),
  modelInfoTtlMs: z.number(),
})

/**
 * 痕迹文件路径。测试用 ROUTER_EFFORT_LOG 指到别处，免得测试进程的挂载行混进宿主的日志。
 * 每次调用时读环境变量，这样测试可以在 import 之后、apply 之前改。
 */
function tracePath() {
  return process.env.ROUTER_EFFORT_LOG || MOUNT_LOG_PATH
}

function trace(message) {
  try {
    appendFileSync(tracePath(), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 写不了就算了 */
  }
}

/** 一条消息里的纯文本，拼起来；没有文本时返回空串。 */
function textOf(message) {
  return (message && Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 一批消息的纯文本，逐条拼起来。判定看的是整轮输入，不是第一条。 */
function textsOf(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => textOf(message))
    .filter((text) => text !== '')
    .join('\n')
}

function sessionKeyOf(agent) {
  const session = agent && agent.session
  return (session && (session.id || session.sessionId)) || 'global'
}

function log(message) {
  process.stderr.write(`[effort-router] ${message}\n`)
}

/**
 * 本轮固定下来的模型路由。
 *
 * 0.2.2 起 `agent/pre-step` 的 payload 直接带 `modelSelection`：它在 inbox 被认领、
 * `model.current()` 快照之后才派发，必定是本轮的，且已经包含会话里写进去的强度。
 * 不再读投影，也不再退回请求头——那两条给出的都是上一轮的模型。
 */
function currentRoute(payload) {
  const selection = payload === null || payload === undefined ? undefined : payload.modelSelection
  if (selection === undefined || selection === null) return undefined
  if (!selection.provider || !selection.model) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
  }
}

/** 问判定服务要一个档位；任何失败都返回 null。成功时把 state 刷成 up。 */
async function judgeTier(url, task, signal, state, timeoutMs) {
  if (typeof task !== 'string' || task === '') return null
  const timeout = AbortSignal.timeout(toMs(timeoutMs, JUDGE_TIMEOUT_MS))
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => timeout.abort?.(), { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: task.slice(0, MAX_TASK_CHARS) }),
      signal: timeout,
    })
    if (!response.ok) {
      log(`判定服务返回 HTTP ${response.status}，本轮按兜底档处理`)
      return null
    }
    const body = await response.json()
    const answer = typeof body?.tier === 'string' ? body.tier.trim().toLowerCase() : ''
    // 只认协议里的三档。回了别的词按判定失败处理，与设置页探活的判断保持一致，
    // 否则同一个服务在探活里被拒、在判定里却被当成中间档。
    if (!JUDGE_TIERS.includes(answer)) {
      log(`判定服务的档位不认识（${answer === '' ? '空' : answer}），本轮按兜底档处理`)
      return null
    }
    if (state !== undefined && state !== null) {
      // 服务答得上话，状态就该是 up。启动阶段那一次探活失败不该永久定死状态。
      state.state = 'up'
      state.detail = ''
    }
    return answer
  } catch (error) {
    log(`判定服务不可用（${error && error.message ? error.message : error}），本轮按兜底档处理`)
    return null
  }
}

/** 判定服务的基础地址：judgeUrl 去掉尾部的 /judge。 */
function serviceBase(judgeUrl) {
  return String(judgeUrl).replace(/\/judge\/?$/, '')
}

/** 服务在线且说 finetuned 协议时才算可用。 */
async function serviceUp(base) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.protocol === 'finetuned'
  } catch {
    return false
  }
}

/**
 * 设置面里的当前值。
 *
 * volatile 字段热改之后，apply() 收到的 config 就是旧快照了，所以热改字段每次从 settings 读。
 * 读不到（没有设置面、行没登记、调用抛错）就返回 undefined，调用方退回挂载时的值。
 */
function liveSettings(ctx, entryId) {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
    const rows = settings.describe()
    const row = Array.isArray(rows)
      ? rows.find((candidate) => candidate !== undefined && candidate !== null && candidate.ns === entryId)
      : undefined
    return row === undefined || row === null ? undefined : row.value
  } catch {
    return undefined
  }
}

/** 本插件那一行的 loader id。设置面按行 id 寻址，不按包名。 */
function entryIdOf(ctx, fallback) {
  try {
    const loader = ctx.loader
    if (loader === undefined || loader === null || typeof loader.entries !== 'function') return fallback
    for (const entry of loader.entries()) {
      const options = entry && entry.options
      if (options && options.name === 'dsh-effort-router' && typeof options.id === 'string' && options.id !== '') {
        return options.id
      }
    }
  } catch {
    /* 拿不到就用默认 */
  }
  return fallback
}

/**
 * 给不接 signal 的异步调用套一个超时。
 *
 * hold 期间本轮唤醒是被扣住的，任何一步挂住都会把 agent 卡在 maintenance 里出不来。
 * 凭据服务这类调用不接受 AbortSignal，只能靠这里兜住。超时返回 undefined。
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(toMs(ms, 0), 0))
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

/** 凭据写入是否被临时挡住（Windows 上 rename 的典型失败）。 */
function isTransientCredentialError(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return TRANSIENT_CREDENTIAL_CODES.includes(code)
}

/**
 * 等判定服务就绪：每 stepMs 探一次，直到超时。
 *
 * 冷启动要加载权重，约 70 秒，所以拉起之后必须等，不能探一次就判死。
 * 服务本来就在线时第一次探活就返回，不引入延迟。
 */
async function waitForService(base, timeoutMs, stepMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await serviceUp(base)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(0, deadline - Date.now()))))
  }
}

/**
 * 子代理的判断。
 *
 * 子代理的强度由主代理决定，这里再改一遍会覆盖它。字段读不到就当不是子代理，
 * 行为与没有这段判断时一致。
 */
function isSubagent(agent) {
  try {
    const session = agent && agent.session
    const header = session && typeof session.header === 'object' ? session.header : undefined
    return header !== undefined && header !== null && header.origin === 'subagent'
  } catch {
    return false
  }
}

/**
 * 拉起本机判定服务，返回一句结果说明。失败不影响路由。
 *
 * 服务不直接挂在 DSH 下面，而是交给 supervisor.mjs 看管：那个脚本盯着 DSH 的 pid，DSH 一没了
 * 就把 python 整棵进程树结束掉。Windows 不会因为父进程退出就杀子进程，不包这一层，DSH 关掉后
 * 判定服务会一直占着端口和内存。
 *
 * `model` 有值时作为 LAYA_MODEL 传给服务，服务从那个目录读权重。权重不在包目录里
 * （放在别的盘或镜像目录）时必须传，否则服务以基座协议启动，/judge 没有 tier。
 */
function startService(base, python, script, model) {
  if (!python || !script) return '未配置判定服务路径，跳过启动'
  if (!existsSync(python) || !existsSync(script)) return `判定服务文件缺失（${python} / ${script}），跳过启动`
  const supervisor = fileURLToPath(new URL('./supervisor.mjs', import.meta.url))
  if (!existsSync(supervisor)) return `缺少看门人脚本（${supervisor}），跳过启动`
  let fd
  try {
    fd = openSync(SERVICE_LOG_PATH, 'a')
  } catch {
    fd = undefined
  }
  try {
    const port = new URL(base).port || '8765'
    const child = spawn(process.execPath, [
      supervisor,
      '--python', python,
      '--script', script,
      '--port', port,
      '--pid-file', join(provisionRoot(), 'service.pid'),
      ...(typeof model === 'string' && model !== '' ? ['--model', model] : []),
      '--parent', String(process.pid),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', fd === undefined ? 'ignore' : fd],
    })
    // 本进程拉起的看门人记在这里：判断「有没有人在看管」先看这张表里的子进程对象，
    // 光靠 pid 探测会被复用的 pid 骗过去。pid 文件由看门人自己写、退出时自己删。
    supervisors.add(child)
    child.on('exit', () => { supervisors.delete(child) })
    // unref 让看门人进程不拖住 DSH 的事件循环；它的生死由父 pid 轮询决定，不靠这里的句柄。
    child.unref()
    const weights = typeof model === 'string' && model !== '' ? '，权重 ' + model : ''
    return '已拉起判定服务（' + python + weights + '，pid ' + (child.pid ?? '?') + '，随 DSH 退出）'
  } catch (error) {
    return `拉起判定服务失败：${error && error.message ? error.message : error}`
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}

/**
 * 判定服务所在的包目录。
 *
 * 服务本体（python 源码、依赖锁、权重清单、安装脚本）在 dsh-router-laya 包里，本插件把它声明成
 * 依赖，所以从本模块的位置就能解析到。cfg.layaDir 用来指向别处的副本。
 */
function layaRoot(cfg) {
  if (typeof cfg.layaDir === 'string' && cfg.layaDir !== '') return cfg.layaDir
  try {
    return join(createRequire(import.meta.url).resolve('dsh-router-laya/package.json'), '..')
  } catch {
    return undefined
  }
}

/** 部署产物的落地目录。venv 和 846MB 权重都在这里，测试用 ROUTER_EFFORT_HOME 指到别处。 */
function provisionRoot() {
  return process.env.ROUTER_EFFORT_HOME || join(homedir(), '.dsh', 'router-effort')
}

/** 本进程拉起过的看门人。它们的存活状态以子进程对象为准，pid 文件只用来跨进程溯源。 */
const supervisors = new Set()

/** pid 还活着吗。只用于跨进程兜底：pid 会被系统复用，单独信它会把死的说成活的。 */
function alivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 当前在跑的服务有没有人看管。
 *
 * 服务在线不等于它随 DSH 生死：旧版本直接 detached 拉起 python，没有看门人；用户也可能自己
 * 起了一份。只回报事实，不去结束别人的进程。
 *
 * 判断顺序有讲究：
 * 1. 本进程拉起的看门人看子进程对象。pid 文件是过去的事实，pid 被复用或进程对象没回收时，
 *    pid 探测会把一个已经死掉的看门人报成活着。
 * 2. 记录里 parent 就是本进程时一律不认：我们拉起的看门人都在上面那张表里，表里没有它，
 *    说明这条记录是死人留下的（或者本进程复用了旧 pid）。表里没有就说明没人看管。
 * 3. 剩下的跨进程情形才读 pid：父 DSH 和看门人都活着才算有人管。看门人正常退出时会删掉
 *    这份记录，所以残留记录本身就说明它没走干净。
 */
function supervisorAlive() {
  for (const child of supervisors) {
    if (child.exitCode === null && child.signalCode === null) return true
  }
  let recorded
  try {
    recorded = JSON.parse(readFileSync(join(provisionRoot(), 'service.pid'), 'utf8'))
  } catch {
    return false
  }
  const parent = Number(recorded?.parent)
  if (parent === process.pid) return false
  return alivePid(parent) && alivePid(Number(recorded?.supervisor))
}

/** 最近判定落盘的位置。重启后芯片要能显示上一次的档位。 */
function recentPath() {
  return join(provisionRoot(), 'last.json')
}

/** 会话 id 的归一化。
 *
 * 宿主侧的 session.id 带 `session-` 前缀，前端 `sessionId` 有时给裸 uuid。
 * 两边都归一化再比，芯片才能精确对上自己的会话。
 */
function bareSession(value) {
  return String(value ?? '').replace(/^session-/, '')
}

/**
 * 把一条历史记录迁到当前格式。
 *
 * 版本 1 的记录（0.4.0 之前的插件写的）没有 owned，也没有 baseline。那一版每轮都会把强度
 * 写进会话选择，记录里的 effort 就是它写的值，所以缺 baseline 的记录按「插件自己写的」处理。
 * 新版早期也写出过没有 baseline 的 owned: false，同样缺证据，走同一条规则。
 *
 * legacyOwned 为 false 时回到保守口径：拿不准的一律当用户手动设的下限。
 */
export function migrateRecord(record, legacyOwned) {
  if (record === null || typeof record !== 'object') return record
  if (Number(record.schemaVersion) >= RECORD_SCHEMA_VERSION) return record
  const provable = typeof record.baseline === 'string'
  return {
    ...record,
    schemaVersion: RECORD_SCHEMA_VERSION,
    // 当年的判定落位值已经不可考，只能按记录里最终写下的强度补。
    picked: typeof record.picked === 'string' ? record.picked : record.effort,
    baseline: provable ? record.baseline : record.effort,
    owned: provable ? record.owned === true : legacyOwned !== false,
  }
}

/**
 * 读回上次落盘的判定。文件不存在、坏掉、结构不对都当空表；只留最新的 limit 条。
 * 读进来的记录顺手迁移到当前格式，旧数据不会因为缺字段被当成用户下限。
 */
function loadRecent(limit, legacyOwned) {
  try {
    const parsed = JSON.parse(readFileSync(recentPath(), 'utf8'))
    const rows = parsed !== null && typeof parsed === 'object' && parsed.records !== null && typeof parsed.records === 'object'
      ? parsed.records
      : {}
    return new Map(Object.entries(rows)
      .filter((entry) => entry[1] !== null && typeof entry[1] === 'object')
      .map(([key, value]) => [key, migrateRecord(value, legacyOwned)])
      .sort((left, right) => (Number(right[1]?.at) || 0) - (Number(left[1]?.at) || 0))
      .slice(0, limit))
  } catch {
    return new Map()
  }
}

/**
 * 把最近判定写回磁盘，只留最近几条。
 *
 * 三个进程共存时的做法：
 * 1. 先读回磁盘再合并，各进程只补自己新写的行；
 * 2. 临时文件名带 pid 与随机后缀，同时写不踩同一个文件；
 * 3. 写 tmp 前后各看一次目标文件的修改时间，中间被别人写过就重读合并一次再写，
 *    降低「读—改—写」窗口里丢掉对方新行的概率；两次都没抢到就放弃，下次判定再写。
 * 写失败不影响路由。
 */
function saveRecent(recent, limit, legacyOwned) {
  const target = recentPath()
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const mtimeOf = () => {
    try {
      return statSync(target).mtimeMs
    } catch {
      return 0
    }
  }
  try {
    mkdirSync(provisionRoot(), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = mtimeOf()
      const merged = loadRecent(limit, legacyOwned)
      for (const [key, value] of recent) {
        const existing = merged.get(key)
        if (existing === undefined || (Number(value?.at) || 0) >= (Number(existing?.at) || 0)) {
          merged.set(key, value)
        }
      }
      const rows = [...merged.entries()]
        .sort((left, right) => (Number(right[1]?.at) || 0) - (Number(left[1]?.at) || 0))
        .slice(0, limit)
      writeFileSync(temporary, `${JSON.stringify({ version: RECORD_SCHEMA_VERSION, records: Object.fromEntries(rows) }, null, 2)}\n`)
      if (mtimeOf() === before) {
        renameSync(temporary, target)
        return
      }
    }
  } catch {
    /* 写不了就算了，芯片最多少一条历史 */
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* 临时文件没建出来，或者已经被改名搬走 */
    }
  }
}

/**
 * 把包依赖里的 laya 镜像到部署目录。
 *
 * setup 会把 venv 和权重写在自己所在的包里。依赖目录在 node_modules 下，插件升级或 pnpm 重装
 * 会整包换掉，1.5GB 的产物跟着没了。镜像到 `~/.dsh/router-effort/laya` 就不会被清理，
 * 版本变了才重新复制。导出是为了单独测这段逻辑，插件里只有一个调用点。
 */
export function mirrorLaya(source) {
  const target = join(provisionRoot(), 'laya')
  try {
    const want = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
    let have
    try {
      have = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version
    } catch {
      have = undefined
    }
    if (have === want) return target
    mkdirSync(provisionRoot(), { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
    log(`已把判定服务包复制到 ${target}（${want}）`)
    return target
  } catch (error) {
    log(`复制判定服务包失败（${error && error.message ? error.message : error}），直接用依赖里的副本`)
    return source
  }
}

/**
 * 首次部署：跑包自带的 setup。
 *
 * setup 依次做四件事：建 venv 并 pip 装 pinned 依赖（CPU 版 torch）、下载约 850MB 权重、
 * 打印注册提示、拉起服务并等 /health。它是幂等的，重复跑会跳过已完成的部分。
 * 输出全部写 SETUP_LOG_PATH，宿主这边只看退出码。
 */
function runSetup(base, root) {
  const script = join(root, 'bin', 'setup.mjs')
  if (!existsSync(script)) return Promise.resolve({ ok: false, detail: `缺少 ${script}` })
  let fd
  try {
    fd = openSync(SETUP_LOG_PATH, 'a')
  } catch {
    fd = undefined
  }
  try {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', fd === undefined ? 'ignore' : fd, fd === undefined ? 'ignore' : fd],
      env: {
        ...process.env,
        LAYA_ROUTER_URL: `${base}/judge`,
        LAYA_START_TIMEOUT: process.env.LAYA_START_TIMEOUT || '300',
        PYTHONIOENCODING: 'utf-8',
      },
    })
    return new Promise((resolve) => {
      child.on('error', (error) => resolve({ ok: false, detail: error.message }))
      child.on('exit', (code) => resolve({ ok: code === 0, detail: `退出码 ${code}` }))
    })
  } catch (error) {
    return Promise.resolve({ ok: false, detail: error && error.message ? error.message : String(error) })
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const entryId = entryIdOf(ctx, 'effort-router')
  const mountedJudgeUrl = valueOf(cfg.judgeUrl, '') || process.env.LAYA_ROUTER_URL || DEFAULT_JUDGE
  // 档位 -> 目标强度。判定服务给的是 low / high / max，缺省同名映射。
  const tiers = { ...DEFAULT_TIERS, ...valueOf(cfg.tiers, {}) }
  const mode = { current: valueOf(cfg.mode, 'auto') === 'manual' ? 'manual' : 'auto' }

  /**
   * 本轮配置：设置面当前值优先，读不到退回挂载快照。
   * 一轮读一次就够，调用方把结果往下传，避免同一轮反复 describe。
   *
   * 合并规则在 config/settings.mjs 的 resolveLive：纯函数，单测直接喂输入。
   */
  function live() {
    return resolveLive(liveSettings(ctx, entryId), cfg, { judgeUrl: mountedJudgeUrl, mode: mode.current, tiers })
  }

  trace(`mounted mode=${mode.current} judge=${mountedJudgeUrl} entry=${entryId}`)

  /** 判定后端的可用性，给 /effort-router/judge 看。 */
  const judge = { state: 'unknown', detail: '' }

  /**
   * 记一次后端的可用性。
   *
   * 本地服务的状态由 `ensureJudge` 维护；Jev 没有探活流程，就由每次真实判定的结果刷新，
   * 这样状态接口报的就是「上一轮到底连通没有」，而不是一个与 Jev 无关的本地服务状态。
   */
  function noteBackend(state, detail) {
    judge.state = state
    judge.detail = detail
  }

  /** 会话 -> { turn, tier, effort, baseline }：本轮判定结果。turn 为 undefined 表示留给下一轮。 */
  const verdicts = new Map()
  /** 会话 -> { effort }，记下我们自己写过的强度，用来区分“用户改的”和“我们写的”。 */
  const written = new Map()
  /** provider/model -> { at, list }，档位解析结果，带寿命。 */
  const infos = new Map()
  /** 会话 -> 最近一次判定，供输入框旁的芯片显示。启动时从磁盘读回，重启后芯片不会空。 */
  const recent = loadRecent(MAX_RECENT, live().legacyOwned)
  /** 浏览器半边最后一次报到的时间、它带上来的会话参数，以及组件收到的 props 键名。 */
  const clientSeen = { at: 0, lastQuery: null, keys: null, sid: null }

  /** 上次落盘的时间。稳定档位也定期刷一次，免得磁盘上的 at 长期冻在被淘汰的边缘。 */
  const saveState = { at: 0 }

  /**
   * 写会话级内存表，超过容量上限时丢最早的一条。
   * Map 保持插入顺序，最早插入的那条就是最该淘汰的。
   */
  function remember(map, key, value) {
    map.delete(key)
    map.set(key, value)
    if (map.size <= MAX_SESSION_ENTRIES) return
    const oldest = map.keys().next()
    if (oldest.done !== true) map.delete(oldest.value)
  }

  /**
   * 记一次判定结果。芯片读的是这里，不读会话日志。
   *
   * prevTier 记上一次记下的档位，芯片据此显示 low → high。hold 阶段还不知道轮次号
   * （turn 为空），pre-step 补判时才拿得到；一轮里若插话又判了一次，就按最后一次记。
   *
   * owned 记的是这条 record 的强度是不是插件自己写进去的：用户钉住的强度即使被原样写回，
   * 也不算我们的，下一轮不能因此把它降下去。
   *
   * 落盘条件：档位或归属变了，或者距上次落盘超过 SAVE_INTERVAL_MS。后者保证活跃会话在
   * 磁盘上不会变成「最久没更新」而被容量淘汰挤掉。
   */
  function recordVerdict({ key, tier, picked, baseline, floor, effort, provider, model, turn, owned, legacyOwned }) {
    const previous = recent.get(key)
    const now = Date.now()
    const changed = previous === undefined
      || previous.tier !== tier
      || previous.effort !== effort
      || previous.picked !== picked
      || previous.baseline !== baseline
      || previous.provider !== provider
      || previous.model !== model
      || previous.owned !== (owned === true)
    recent.set(key, {
      schemaVersion: RECORD_SCHEMA_VERSION,
      tier,
      // 判定落位值与写之前的强度一起记：下次判断归属时不必再猜当时发生了什么。
      picked,
      baseline,
      effort,
      provider,
      model,
      at: now,
      prevTier: previous === undefined ? null : previous.tier,
      turn,
      owned: owned === true,
      // 被下限挡住时记下挡住的值；其余情况不写这个字段。
      ...(floor === undefined ? {} : { floor }),
    })

    // 内存也要裁：只在读盘时截断会让这张表随着会话数一直涨。
    if (recent.size > MAX_RECENT) {
      const oldest = [...recent.entries()].sort((left, right) => (left[1]?.at ?? 0) - (right[1]?.at ?? 0))[0]
      if (oldest !== undefined) recent.delete(oldest[0])
    }

    // 落盘：档位变了，或者距上次落盘超过 SAVE_INTERVAL_MS。
    // 后者让「档位一直不变但会话很活跃」的记录在磁盘上不会变成最旧的那条。
    if (changed || now - saveState.at > SAVE_INTERVAL_MS) {
      saveState.at = now
      saveRecent(recent, MAX_RECENT, legacyOwned)
    }
  }

  /**
   * Jev 的凭据：进程环境优先，其次宿主凭据服务。
   * 引用名沿用 DSH 的 credential-ref 约定（形如环境变量名）。
   */
  async function jevKey(reference) {
    const name = typeof reference === 'string' && reference !== '' ? reference : JEV_KEY_REF
    // 顺序跟宿主凭据服务一致：文件优先，环境变量兜底。
    // 反过来的话，面板写进凭据库的 Key 会被同名环境变量盖住，状态显示与实际生效对不上。
    try {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
        // 宿主凭据服务返回的是 { value, source }，不是裸字符串；两种形状都收。
        const resolved = await credentials.resolve(name)
        if (typeof resolved === 'string' && resolved !== '') return resolved
        if (resolved !== null && typeof resolved === 'object'
          && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      }
    } catch {
      /* 凭据服务不可用，退到环境变量 */
    }
    const fromEnv = process.env[name]
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return ''
  }

  /** 两个档位里更强的那个，用于低置信度向上取。 */
  function strongerOf(left, right) {
    const leftIndex = strengthOf(left)
    const rightIndex = strengthOf(right)
    if (leftIndex === undefined) return right
    if (rightIndex === undefined) return left
    return rightIndex > leftIndex ? right : left
  }

  /**
   * 问 Jev 要一个档位。
   *
   * Jev 是决策模型，走 System One 协议：`POST {model, state, questions}`，
   * 回来的是 `{answers:{effort:{choice, confidence, probabilities}}}`，没有文本、没有推理链。
   * 置信度低于阈值时在概率最高的两档里取更强的那个：宁可高估，不低估。
   * 任何失败都返回 null，调用方保持原强度。
   */
  async function askJev(task, signal, now, timeoutMs) {
    if (typeof task !== 'string' || task === '') return null
    // 没给预算时用配置里的 Jev 超时；给了（hold 阶段）就用给的，且不叠加。
    const budget = toMs(timeoutMs, toMs(now.jevTimeoutMs, JEV_TIMEOUT_MS))
    // 一次判定总共只有 budget 这么多时间，解析凭据也算在里面。
    // 两段各给一次 budget 的话，最坏情况是 hold 被扣住两倍预算。
    const deadline = Date.now() + budget
    // 凭据服务不接受 signal：挂住的话 hold 永远结束不了，这里必须兜一层超时。
    const key = await withTimeout(jevKey(now.jevApiKeyEnv), budget)
    if (typeof key !== 'string' || key === '') {
      noteBackend('down', `没有可用凭据：${now.jevApiKeyEnv}`)
      log('Jev 没有可用凭据，本轮按兜底档处理')
      return null
    }
    // 剩余预算：凭据解析花掉的时间从这里扣。
    const timeout = AbortSignal.timeout(Math.max(0, deadline - Date.now()))
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => timeout.abort?.(), { once: true })
    }
    try {
      const response = await fetch(now.jevUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: now.jevModel,
          state: task.slice(0, MAX_TASK_CHARS),
          questions: {
            effort: {
              type: 'choice',
              instructions: 'How much reasoning depth does answering this request need?',
              criteria: TIER_CRITERIA,
            },
          },
        }),
        signal: timeout,
      })
      if (!response.ok) {
        noteBackend('down', `HTTP ${response.status}`)
        log(`Jev 返回 HTTP ${response.status}，本轮按兜底档处理`)
        return null
      }
      const body = await response.json()
      const answer = body !== null && typeof body === 'object' && body.answers !== undefined ? body.answers.effort : undefined
      const choice = answer !== null && typeof answer === 'object' && typeof answer.choice === 'string'
        ? answer.choice.trim().toLowerCase()
        : ''
      if (!TIER_KEYS.includes(choice)) {
        noteBackend('down', `答案不是已知档位（${choice === '' ? '空' : choice}）`)
        log(`Jev 的答案不是已知档位（${choice === '' ? '空' : choice}），本轮按兜底档处理`)
        return null
      }
      noteBackend('up', '')
      const confidence = Number(answer.confidence)
      const threshold = Number.isFinite(now.jevConfidence) ? now.jevConfidence : DEFAULT_JEV_CONFIDENCE
      if (Number.isFinite(confidence) && confidence < threshold) {
        const probabilities = answer.probabilities !== null && typeof answer.probabilities === 'object' ? answer.probabilities : {}
        const ranked = Object.entries(probabilities)
          .filter((entry) => TIER_KEYS.includes(entry[0]))
          .sort((left, right) => Number(right[1]) - Number(left[1]))
          .map((entry) => entry[0])
        if (ranked.length >= 2) {
          const stronger = strongerOf(ranked[0], ranked[1])
          trace(`jev 置信度 ${confidence.toFixed(2)} 低于 ${threshold}，取更强的 ${stronger}`)
          return stronger
        }
      }
      return choice
    } catch (error) {
      noteBackend('down', error && error.message ? error.message : String(error))
      log(`Jev 不可用（${error && error.message ? error.message : error}），本轮按兜底档处理`)
      return null
    }
  }

  /**
   * 把这一轮的强度写进会话的模型选择。
   *
   * 0.2.2 唯一的写入口是 `agent.model.select()`：它 append 一条 `model/selection`，
   * 会话级的 model-selection 监听把它折成 pending，下一次 `model.current()` 快照到的
   * 就是新值。所以写入必须发生在 preStep 之前——这就是写入点挪到 hold 阶段的原因。
   *
   * select 不做任何校验：空 provider、模型不认识的强度名都写得进去，之后在
   * `prepareRequest` 或 `llm.prepareCall` 才炸，离写入点很远。所以调用方必须先用
   * 模型自己声明的强度列表选好值（`pickEffortFor`），这里只负责写。
   */
  function applySelection(agent, provider, model, reasoningEffort) {
    const api = agent === null || agent === undefined ? undefined : agent.model
    if (api === undefined || api === null || typeof api.select !== 'function') {
      trace('selection: agent 没有 model.select，本轮不写会话选择')
      return false
    }
    try {
      api.select({ provider, model, reasoningEffort })
      trace(`selection: 写入 ${provider}/${model} → ${reasoningEffort}（agent.model.select）`)
      return true
    } catch (error) {
      trace(`selection: 写入失败（agent.model.select）：${error && error.message ? error.message : error}`)
      return false
    }
  }

  /**
   * 这一轮能不能直接覆盖会话里的强度。
   *
   * 会话里还没有任何选择时，选择器上的是模型默认值，可以覆盖。已经有选择时：
   * - 值等于我们自己写过的（本进程的 written，或落盘历史里 owned 为 true 的那条），可以覆盖；
   * - 值等于 agent 的默认强度（重启后会话记录里的 lastUsed 多半就是这个），可以覆盖；
   * - 其余情况当作用户自己拧的，只升不降。
   *
   * `recordedSelection()` 与 `options` 只在运行时的 AgentModel 上有，公开的 Model 接口
   * 只声明了 `current()` 与 `select()`。两个都读不到时按「不是我们写的」处理：
   * 判定结果只能往上抬，比现状弱就保留现状。宁可少降，也不把用户手动调的档顶掉。
   */
  function ownsSelection(agent, key, currentEffort) {
    // 进程内自记账不依赖宿主 API：先看这个值是不是我们自己写进去的。
    const last = written.get(key)
    if (last !== undefined && last.effort === currentEffort) return true
    let readable = false
    let recorded = null
    let fallbackEffort
    try {
      const api = agent === null || agent === undefined ? undefined : agent.model
      if (api !== undefined && api !== null && typeof api.recordedSelection === 'function') {
        recorded = api.recordedSelection()
        fallbackEffort = api.options?.reasoningEffort
        readable = true
      }
    } catch {
      readable = false
    }
    // 读不到会话选择就保守处理：当作不是我们写的，只升不降。
    if (!readable) return false
    if (recorded === null || recorded === undefined) return true
    const saved = recent.get(key)
    if (saved !== undefined) {
      // 记录里是别的值，说明用户在我们写过之后又改过：这是用户的选择，按下限处理。
      if (saved.effort !== currentEffort) return false
      // 值没变，而且这条确实是我们写的：可以继续接管。
      if (saved.owned === true) return true
      // 记录说不是我们写的（当年被下限挡住）。判定想要更高的档时由 routeEffort 接手，
      // 这里不认领，免得把用户的下限抹掉。
      return false
    }
    // 没有可认领的历史（或者历史就是当前值但不是我们写的）：等于 agent 默认强度时接管，
    // 否则当作会话里原有的用户选择。
    return fallbackEffort !== undefined && recorded.reasoningEffort === fallbackEffort
  }

  /** 用户自己选过强度时的保守处理：只往上抬，不往下压。 */
  function onlyRaise(pinned, picked) {
    const pin = strengthOf(pinned)
    const want = strengthOf(picked)
    if (pin === undefined || want === undefined) return picked
    return want <= pin ? pinned : picked
  }

  /** 按当前模型声明的强度列表落位；列表拿不到时返回 undefined，也就是不写。 */
  async function pickEffortFor(provider, model, tier, now) {
    return pickForTier(await effortsFor(provider, model), tier, now.tiers)
  }

  /**
   * 判定档位 → 本轮强度 → 写进会话选择。
   *
   * 成功时返回 `{ tier, effort, baseline }`；模型没声明强度、拿不到写入接口、判定期间
   * 用户换了模型、或者这一轮已经被取消时返回 undefined，请求保持原样。
   */
  async function routeEffort(agent, key, route, tier, signal, now, turn) {
    const picked = await pickEffortFor(route.provider, route.model, tier, now)
    if (picked === undefined) return undefined
    if (signal !== undefined && signal !== null && signal.aborted === true) return undefined
    // 判定期间用户可能换了模型或强度：写回旧选择会把他刚做的操作顶掉，这种轮次直接放弃。
    // 名字不叫 live：那与本文件里读热改配置的 live() 同名，容易看错。
    const current = agent.model?.current?.()
    if (current === undefined || current === null
      || current.provider !== route.provider || current.model !== route.model
      || current.reasoningEffort !== route.reasoningEffort) {
      trace(`selection: 判定期间路由变了（${route.provider}/${route.model} → ${current?.provider ?? '?'}/${current?.model ?? '?'}），本轮不写`)
      return undefined
    }
    const baseline = route.reasoningEffort
    const ours = ownsSelection(agent, key, baseline)
    const effort = ours ? picked : onlyRaise(baseline, picked)
    if (!applySelection(agent, route.provider, route.model, effort)) return undefined
    // 三种情形分开记，归属才算得清楚：
    // - 我们本来就有这个值，或者这一轮改了值：归我们；
    // - 判定本来就要当前这个强度（picked === baseline）：插件认可它，也算我们的，
    //   下一次判定更低时才有资格降下来；
    // - 判定要改、被下限挡住（picked ≠ baseline 而 effort 仍是 baseline）：会话里那个值是
    //   用户的下限，把挡住的值记进 floor，下一次判定要提到它之上才动得了。
    const blocked = picked !== undefined && picked !== null && picked !== baseline && effort === baseline
    const owned = ours || effort !== baseline || picked === baseline
    if (owned) remember(written, key, { effort })
    recordVerdict({
      key,
      tier,
      picked,
      baseline,
      floor: blocked ? baseline : undefined,
      effort,
      provider: route.provider,
      model: route.model,
      turn,
      owned,
      legacyOwned: now.legacyOwned,
    })
    return { tier, effort, baseline }
  }

  /**
   * 判定实际读哪个凭据引用：跟已保存的配置走，没有配置时用 JEV_KEY_REF。
   * UI 不暴露引用名。
   */
  function keyRef(now) {
    return typeof now?.jevApiKeyEnv === 'string' && now.jevApiKeyEnv !== '' ? now.jevApiKeyEnv : JEV_KEY_REF
  }

  /** 宿主凭据服务；没有 set 能力时当作不可写。 */
  function credentialsService() {
    try {
      const service = ctx.get('credentials')
      return service !== undefined && service !== null ? service : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Key 的状态：只报「有没有、从哪来」，不回传值。
   * 描述失败当成未配置，面板据此显示「未配置」。
   */
  async function keyStatus(now) {
    const ref = keyRef(now)
    const service = credentialsService()
    let described
    try {
      described = service !== undefined && typeof service.describe === 'function' ? await service.describe(ref) : undefined
    } catch {
      described = undefined
    }
    return {
      ref,
      configured: described?.configured === true,
      source: typeof described?.source === 'string' ? described.source : null,
      writable: service !== undefined && typeof service.set === 'function',
    }
  }

  /**
   * 把 Key 写进凭据库。值只进不返，失败带原因。
   *
   * 写入目标是 JEV_KEY_REF。配置里存着别的引用名时，写完把它改过来，
   * 否则判定还在读旧名字，Key 看着保存了却不生效。
   *
   * 凭据文件被占用时宿主会抛 EPERM/EACCES/EBUSY，这种失败通常几秒内自己消失，
   * 这里退避重试；一直失败才把原因回给面板。
   */
  async function saveKey(now, value) {
    const current = keyRef(now)
    const ref = JEV_KEY_REF
    const service = credentialsService()
    if (service === undefined || typeof service.set !== 'function') {
      return { ok: false, code: 503, detail: '宿主没有可写的凭据服务，Key 存不进去' }
    }
    let failure
    for (let attempt = 0; attempt <= CREDENTIAL_WRITE_RETRY_MS.length; attempt += 1) {
      try {
        await service.set(ref, value)
        failure = undefined
        break
      } catch (error) {
        failure = error
        const retryable = isTransientCredentialError(error) && attempt < CREDENTIAL_WRITE_RETRY_MS.length
        if (!retryable) break
        trace(`credentials: 写入 ${ref} 被临时挡住（${error.code}），${CREDENTIAL_WRITE_RETRY_MS[attempt]}ms 后重试`)
        await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_WRITE_RETRY_MS[attempt]))
      }
    }
    if (failure !== undefined) {
      const message = failure && failure.message ? String(failure.message) : String(failure)
      // 报错原样回浏览器前先把 Key 值抹掉，换别的凭据实现也不会把值带出去。
      const safe = message.split(value).join('***')
      const detail = isTransientCredentialError(failure)
        ? `凭据写入失败：凭据文件被其他程序占用或暂时不可写，关掉打开它的编辑器（或让杀软跳过 .dsh 目录）后重试。文件：${credentialsPath()}。原始错误：${safe}`
        : `凭据写入失败：${safe}`
      return { ok: false, code: 503, detail }
    }
    trace(`credentials: 写入 ${ref}`)
    if (ref !== current) {
      try {
        const settings = ctx.get('settings')
        if (settings !== undefined && settings !== null && typeof settings.update === 'function') {
          await settings.update(entryId, { jevApiKeyEnv: ref })
        }
      } catch {
        /* 设置面写不进去时，本轮已经写进凭据库，下次保存再对齐 */
      }
    }
    return { ok: true }
  }

  /** 凭据文件的位置：DSH_HOME 优先，没有就用 ~/.dsh。 */
  function credentialsPath() {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    return join(home, '.credentials.yaml')
  }

  /**
   * 用系统默认程序打开凭据文件。
   *
   * 路径写死在这一个文件上：不接受调用方传路径，避免变成「打开任意文件」的口子。
   */
  function openCredentials() {
    const path = credentialsPath()
    if (!existsSync(path)) return { ok: false, code: 404, detail: `找不到凭据文件：${path}` }
    const command = process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', path] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [path] }
        : { file: 'xdg-open', args: [path] }
    try {
      const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return { ok: true, path }
    } catch (error) {
      return { ok: false, code: 503, detail: error && error.message ? error.message : String(error) }
    }
  }

  /**
   * 探一次当前判定后端能不能答得上话。
   *
   * 与真实判定走同一条路径、同一套凭据解析，只是任务换成一句没意义的话。
   * 设置页的「测试」按钮调它，省得用户只能靠发一条消息才知道配置对不对。
   * 任何失败都折成 `{ok:false, detail}`，不抛。
   */
  async function probeBackend(now) {
    const started = Date.now()
    const ms = () => Date.now() - started

    if (now.judgeSource === 'jev') {
      const key = await jevKey(now.jevApiKeyEnv)
      if (key === '') {
        return { ok: false, backend: 'jev', detail: `没有可用凭据：${now.jevApiKeyEnv} 既不在环境变量里，也不在凭据服务里`, ms: ms() }
      }
      try {
        const response = await fetch(now.jevUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: now.jevModel,
            state: '探测：把两个整数相加',
            questions: {
              effort: {
                type: 'choice',
                instructions: 'How much reasoning depth does answering this request need?',
                criteria: TIER_CRITERIA,
              },
            },
          }),
          signal: AbortSignal.timeout(toMs(now.jevTimeoutMs, JEV_TIMEOUT_MS)),
        })
        if (!response.ok) return { ok: false, backend: 'jev', detail: `HTTP ${response.status}`, ms: ms() }
        const body = await response.json()
        const answer = body !== null && typeof body === 'object' && body.answers !== undefined ? body.answers.effort : undefined
        const choice = answer !== null && typeof answer === 'object' ? answer.choice : undefined
        if (typeof choice !== 'string') return { ok: false, backend: 'jev', detail: '响应里没有 answers.effort.choice', ms: ms() }
        return { ok: true, backend: 'jev', detail: `返回档位 ${choice}`, ms: ms() }
      } catch (error) {
        return { ok: false, backend: 'jev', detail: error && error.message ? error.message : String(error), ms: ms() }
      }
    }

    try {
      const response = await fetch(now.judgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: '探测：把两个整数相加' }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      })
      if (!response.ok) return { ok: false, backend: 'local', detail: `HTTP ${response.status}`, ms: ms() }
      const body = await response.json()
      const tier = body !== null && typeof body === 'object' && typeof body.tier === 'string' ? body.tier.trim() : ''
      if (tier === '') return { ok: false, backend: 'local', detail: '响应里没有 tier', ms: ms() }
      // 只有认识的档位才算连通：回了句别的字符串照样跑不动。
      if (!JUDGE_TIERS.includes(tier)) {
        return { ok: false, backend: 'local', detail: `档位不认识：${tier}`, ms: ms() }
      }
      return { ok: true, backend: 'local', detail: `返回档位 ${tier}`, ms: ms() }
    } catch (error) {
      return { ok: false, backend: 'local', detail: error && error.message ? error.message : String(error), ms: ms() }
    }
  }

  /**
   * 问一次判定器要档位。任何后端失败都返回 null，调用方落兜底档。
   * `now` 是本轮读到的热改值，后端选择与地址都从它取；`timeoutMs` 是该次调用的预算，
   * 不给时各自用配置里的超时。
   */
  async function askJudge(task, signal, now, timeoutMs) {
    if (now.judgeSource === 'jev') return askJev(task, signal, now, timeoutMs)
    // 后端是热改的。判定前发现本地服务不在线就顺手拉起：设置页刚切到「本地」时，
    // 挂载阶段的检查早过去了，不补这一下，服务要等下次重启 DSH 才起得来。
    if (judge.state !== 'up') requestJudgeStart()
    // 发全文：截断会改判定结果（实测同一段多段规格，全文判 low 用 45ms，截到 150 字判 max 用 6.9 秒）。
    return judgeTier(now.judgeUrl, task, signal, judge, timeoutMs)
  }

  /**
   * 目标模型支持的强度 id 列表；拿不到时给空数组。
   *
   * 档位从 `llm.resolveModelInfo` 现读，所以新加的 provider / model 不用改配置，也不用重启：
   * 用户第一次拿它发消息时就能拿到它自己声明的档位。
   *
   * 两条缓存规则保证「现读」成立：
   * 1. 解析不到档位不写缓存。模型或适配器可能还没注册完，下一轮要能重新问；
   *    旧实现会把空数组存下来，之后这个模型永远被视为「没有档位」。
   * 2. 命中的缓存有寿命（`modelInfoTtlMs`），并会被 `llm/adapters-updated` 整体清掉，
   *    用户在 Models 页改完档位不必重启。
   */
  async function effortsFor(provider, model) {
    const key = `${provider}/${model}`
    const ttl = toMs(cfg.modelInfoTtlMs, 60000)
    const cached = infos.get(key)
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.list
    let list = []
    try {
      const llm = ctx.get('llm')
      const info = llm === undefined || llm === null ? undefined : await llm.resolveModelInfo(provider, model)
      list = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
    } catch {
      list = []
    }
    if (list.length > 0) {
      // 缓存加容量上限：provider/model 名是外部输入，不设上限会让这张表无界增长。
      if (infos.size >= MAX_MODEL_CACHE) {
        const oldest = [...infos.entries()].sort((left, right) => (left[1]?.at ?? 0) - (right[1]?.at ?? 0))[0]
        if (oldest !== undefined) infos.delete(oldest[0])
      }
      infos.set(key, { at: Date.now(), list })
      trace(`model ${key} efforts=${JSON.stringify(list)}`)
    } else {
      infos.delete(key)
    }
    return list
  }

  /** 拼一条可见的路由提示；内容只有档位、强度、模型。 */
  function notice(tier, effort, provider, model) {
    const text = `[effort-router] 难度 ${tier} → 强度 ${effort}（${provider}/${model}）`
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // 用 model-selection/notice：与核心的「[model changed: …]」同一种载体，
      // 循环只会特意拦下 runtime-context，用那个会被吞掉。
      source: { kind: 'model-selection', form: 'notice', summary: `${tier} → ${effort}` },
    }
  }

  /**
   * 让判定服务可用：先等在线，再用配置好的路径拉起并等它就绪，最后才走首次部署。
   *
   * 冷启动要加载权重，约 70 秒；拉起之后用 startWaitMs 等，探一次就判死会把状态永久卡在
   * failed。首次部署较慢（装 CPU 版 torch、下约 850MB 权重），全程在后台跑，宿主的启动和
   * 请求都不等它。没就绪之前那几轮按判定失败处理，落兜底档，请求照常发。
   */
  async function ensureJudge() {
    const base = serviceBase(mountedJudgeUrl)
    const startupWaitMs = toMs(process.env.ROUTER_EFFORT_STARTUP_WAIT_MS ?? cfg.startupWaitMs, 3000)
    const startWaitMs = toMs(process.env.ROUTER_EFFORT_START_WAIT_MS ?? cfg.startWaitMs, 90000)
    try {
      if (await waitForService(base, startupWaitMs)) {
        judge.state = 'up'
        // 服务在线，但未必归我们管：旧版本拉起的、或者用户手工起的，退出 DSH 之后不会自己消失。
        const watched = supervisorAlive()
        judge.detail = watched ? '' : '服务在线但不在看门人管下（旧版遗留或手工启动），退出 DSH 后它不会自己结束'
        log(watched ? `判定服务已在线（${base}）` : judge.detail)
        return
      }
      if (cfg.autoStart !== false && cfg.servicePython && cfg.serviceScript) {
        judge.state = 'starting'
        log(startService(base, cfg.servicePython, cfg.serviceScript, cfg.serviceModel))
        if (await waitForService(base, startWaitMs)) {
          judge.state = 'up'
          judge.detail = ''
          log('判定服务已就绪')
          return
        }
        judge.detail = `按配置路径拉起后 ${Math.round(startWaitMs / 1000)} 秒内没就绪`
        log(judge.detail)
      }
      if (cfg.provision === false) {
        judge.state = 'down'
        judge.detail = judge.detail || 'provision 已关闭，服务不在线'
        log('判定服务不在线，provision 关闭，本轮起按兜底档处理')
        return
      }
      const source = layaRoot(cfg)
      if (source === undefined) {
        judge.state = 'missing'
        judge.detail = '找不到 dsh-router-laya 包'
        log('首次部署跳过：找不到 dsh-router-laya 包，装上它或设置 layaDir')
        return
      }
      const root = typeof cfg.layaDir === 'string' && cfg.layaDir !== '' ? source : mirrorLaya(source)
      judge.state = 'provisioning'
      judge.detail = SETUP_LOG_PATH
      log(`首次部署判定服务（要装 CPU 版 torch 并下载约 850MB 权重，日志 ${SETUP_LOG_PATH}）`)
      const outcome = await runSetup(base, root)
      if (await waitForService(base, toMs(cfg.provisionWaitMs, 5000))) {
        judge.state = 'up'
        judge.detail = ''
        return
      }
      judge.state = 'failed'
      judge.detail = outcome.ok
        ? `部署脚本跑完（${outcome.detail}）但服务没起来；见 ${SETUP_LOG_PATH}`
        : `部署脚本${outcome.detail}；见 ${SETUP_LOG_PATH}`
      log(`首次部署未成功：${judge.detail}`)
    } catch (error) {
      judge.state = 'failed'
      judge.detail = error && error.message ? error.message : String(error)
      log(`判定服务启动流程出错：${judge.detail}`)
    }
  }

  /**
   * 拉起判定服务的单飞入口。
   *
   * 挂载时调一次，之后由 askJudge 在「本地后端 + 状态不是 up」时再调。冷启动要加载权重，
   * 一次运行占住几十秒，所以同一时刻只跑一次。失败后按 cooldown 再试，部署失败
   * （脚本报错、缺包）给更长的冷却，因为那条路每次都重跑整个部署脚本。
   */
  const judgeStart = { at: 0, running: false }
  function requestJudgeStart() {
    if (judgeStart.running) return
    const cooldown = judge.state === 'failed' || judge.state === 'missing'
      ? JUDGE_DEPLOY_RETRY_MS
      : JUDGE_START_RETRY_MS
    if (Date.now() - judgeStart.at < cooldown) return
    judgeStart.at = Date.now()
    judgeStart.running = true
    void ensureJudge().finally(() => { judgeStart.running = false })
  }

  // 本地判定服务只在 local 后端下才需要。jev 走公网端点，探活与部署都是白做：
  // 以前的实现会在用 Jev 时照样去装 torch、下 850MB 权重，状态接口还长期报「部署失败」。
  if (live().judgeSource === 'local') {
    requestJudgeStart()
  } else {
    trace(`判定后端是 jev（${live().jevUrl}），不检查本地判定服务`)
  }

  // provider 拓扑变了（新加 provider、改模型定义），缓存的档位立刻作废。
  ctx.on('llm/adapters-updated', () => { infos.clear() })

  /** 正在 hold 本轮的 agent。maintenance 期间 status 仍是 idle，靠这张表防重入。 */
  const holds = new Set()

  /**
   * 唯一的写入时机：用户消息进 inbox 的那一刻。
   *
   * 0.2.2 的顺序是 `send()` 先 splice（同步 emit `agent/inbox/inserted`），再 wakeDriver；
   * 唤醒起来后 turn → preStep 里先 `inbox.claim()`，紧接着 `model.current()` 快照。
   * 也就是说写在 pre-step 里的强度最早也要下一步才生效。
   *
   * `inserted` 是快照之前唯一的异步窗口：监听器在第一个 await 之前调用
   * `agent.runMaintenance()`，phase 立刻变成 maintenance，随后的 wakeDriver 只能记下
   * wakeRequested。判定跑完、`model.select()` 写完，hold 结束才放开唤醒，第一个请求就用上新强度。
   */
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined || agent === null || agent.status !== 'idle') return
    if (holds.has(agent)) return
    if (isSubagent(agent)) return
    if (message === null || message === undefined || message.source?.kind !== 'user') return
    const text = textOf(message)
    if (text === '') return
    const now = live()
    if (!now.enabled || now.mode === 'manual') return

    holds.add(agent)
    let task
    try {
      task = agent.runMaintenance(async (signal) => {
        const route = agent.model?.current?.()
        if (route === undefined || route === null || !route.provider || !route.model) return
        const key = sessionKeyOf(agent)
        const tier = await askJudge(text, signal, now, now.judgeTimeoutMs)
        if (signal.aborted === true) return
        // 判定失败也要落一个档：hold 已经把本轮唤醒扣住，白扣一轮比落错一档更糟。
        // 兜底顺序按设计：该会话上一轮的档位，没有就用配置里的 tiers.fallback。
        const chosen = tier ?? recent.get(key)?.tier ?? now.tiers.fallback
        if (tier === null) trace(`判定不可用，用 ${chosen} 档兜底（${key}）`)
        const verdict = await routeEffort(agent, key, route, chosen, signal, now, undefined)
        if (verdict === undefined) {
          // 模型没声明强度、写入接口不可用、或者这一轮已被取消：这一轮到此为止。
          // 记下「已经判过」，pre-step 别再问一次——那边问是要 await 在请求前面的。
          remember(verdicts, key, { messageId: message.id, skipped: true })
          return
        }
        // 记下消息 id：pre-step 只认这条消息认领的那一轮，别把陈年判定套到新任务上。
        remember(verdicts, key, { messageId: message.id, ...verdict })
      })
    } catch {
      // phase 已经被别的活动占住（运行中的 turn、别的插件的 maintenance）：放弃本轮。
      holds.delete(agent)
      return
    }
    void task
      .finally(() => holds.delete(agent))
      .catch((error) => trace(`hold: ${error && error.message ? error.message : error}`))
  }, { global: true })

  // 每轮第一步在对话里留一条可见提示：难度档位、最终强度、模型。
  // 强度与选择在 hold 阶段就写完了，这里只读结果；只有用户插话导致的补判才现问。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const now = live()
    if (!now.enabled || now.mode === 'manual') return decision
    if (decision.kind === 'reject') return decision
    if (isSubagent(payload.agent)) return decision
    try {
      const route = currentRoute(payload)
      if (route === undefined) {
        // 拿不到本轮模型时插不了提示（提示里要写模型名）。留一行痕迹，免得像“没生效”。
        trace('pre-step: payload 里没有本轮模型，跳过')
        return decision
      }
      const key = sessionKeyOf(payload.agent)
      const claimed = Array.isArray(payload.messages) ? payload.messages : []
      const claimedIds = new Set(claimed.map((message) => message && message.id).filter((id) => id !== undefined))
      let verdict = verdicts.get(key)
      const fromHold = verdict !== undefined
        && verdict.messageId !== undefined
        && claimedIds.has(verdict.messageId)
      if (!fromHold) {
        // 这一轮没走到 hold（运行中插话、或者唤醒来自队列）：补判一次。
        // selection 在派发 pre-step 之前就快照好了，这次写入从下一步生效。
        // 用户消息优先：hold 只认用户消息，这里保持一致；step 1 若拿不到用户消息
        // （定时任务、webhook 之类）再退回整批，更靠后的 step 只认用户插话。
        const users = claimed.filter((message) => message && message.source && message.source.kind === 'user')
        const candidate = users.length > 0 ? users : payload.step === 1 ? claimed : []
        const text = textsOf(candidate)
        if (text === '') return decision
        const tier = await askJudge(text, payload.signal, now, now.judgeTimeoutMs)
        if (tier === null) return decision
        verdict = await routeEffort(payload.agent, key, route, tier, payload.signal, now, payload.turn)
        if (verdict === undefined) return decision
      } else if (verdict.skipped === true) {
        // hold 已经判过，只是没什么可写（模型没有强度 / 写入接口不在）。
        return decision
      }
      // 提示只在每轮第一步插；中途插话补判过的那几步不刷屏。
      if (payload.step !== 1) return decision
      if (now.notify === 'off') return decision
      if (now.notify !== 'always' && verdict.effort === verdict.baseline) return decision
      trace(`pre-step: 插入提示 ${verdict.tier} -> ${verdict.effort}（${route.provider}/${route.model}）`)
      return {
        ...decision,
        messages: [...decision.messages, notice(verdict.tier, verdict.effort, route.provider, route.model)],
      }
    } catch (error) {
      log(`判定失败（${error && error.message ? error.message : error}）`)
      return decision
    }
  }, { global: true, prepend: true })

  // 运行时开关：GET 读当前模式，POST body {"mode":"auto"|"manual"} 切换。
  // 旧路径 /router-effort/* 保留为别名，README 与已有脚本里的 curl 继续可用。

  /**
   * 把改动写回 profile。这是设置页保存的唯一落盘路径；没有设置面时退回内存开关。
   *
   * 失败分两类：字段本身不合法回 400，设置服务写不进去回 503。两者都带 detail。
   */
  const writeConfig = async (patch) => {
    const checked = validatePatch(patch)
    if (!checked.ok) return checked
    const clean = checked.clean
    let settings
    try {
      settings = ctx.get('settings')
    } catch {
      settings = undefined
    }
    if (settings === undefined || settings === null || typeof settings.update !== 'function') {
      if (clean.mode === undefined) return { ok: false, detail: '设置服务不可用' }
      mode.current = clean.mode
      return { ok: true, persisted: false, detail: '设置服务不可用，只改了内存里的模式' }
    }
    try {
      await settings.update(entryId, clean)
    } catch (error) {
      return { ok: false, detail: error && error.message ? error.message : String(error) }
    }
    if (clean.mode !== undefined) mode.current = clean.mode
    // 切到本地后端的那一下就把服务拉起来。等服务收到第一条消息才拉，那一轮必然超时落兜底，
    // 冷启动又要几十秒，用户会以为插件没生效。
    if (live().judgeSource === 'local' && judge.state !== 'up') requestJudgeStart()
    return { ok: true, persisted: true }
  }

  /** 设置页要显示的内容。 */
  const readConfig = () => {
    let writable = false
    try {
      const settings = ctx.get('settings')
      writable = settings !== undefined && settings !== null && typeof settings.update === 'function'
        && liveSettings(ctx, entryId) !== undefined
    } catch {
      writable = false
    }
    return { entryId, ...live(), writable }
  }

  // 浏览器半边的数据面：九条路由，两条前缀。旧前缀 /router-effort/* 是 README 与已有脚本里
  // 的 curl 用的，一直留着。
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) {
      trace('webServer 不可用，模式开关没注册')
      return
    }
    const routes = createRoutes({
      live, judge, recent, clientSeen, readConfig, writeConfig,
      effortsFor, pickForTier, probeBackend, keyStatus, saveKey, openCredentials,
      bareSession, trace,
      limits: { modelInfoTtlMs: toMs(cfg.modelInfoTtlMs, 60000), setupLogPath: SETUP_LOG_PATH },
      enums: { modes: MODES, judgeSources: JUDGE_SOURCES, tierKeys: TIER_KEYS },
    })
    trace('webServer 就绪，注册 ' + routes.length + ' 组 /effort-router/* 路由（含 /router-effort/* 旧别名）')
    for (const route of routes) {
      for (const prefix of ROUTE_PREFIXES) {
        scoped.effect(() => webServer.register({ kind: 'exact', path: prefix + '/' + route.name, handler: route.handler }))
      }
    }
  })
}
