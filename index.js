/**
 * effort-router —— 按任务难度调整当前模型的思考强度。
 *
 * 它只改一个字段：`reasoningEffort`。provider 和 model 保持你（或 agent 默认模型）
 * 选的那个，所以换任何厂商、任何新加的 provider 都自动适用。
 *
 * 流程：每轮第一次请求时，把用户这句话发给本机判定服务，拿一个档位
 * （low / high / max），再把档位映射成强度名，最后在目标模型真正支持的强度里
 * 挑一个不超过目标的、最强的那个。
 *
 * 判定服务不可用时什么都不做，请求保持原样。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
// profile 提供的 peer：包落在能解析到 harness 的 node_modules 下就能裸解析。
import z from '@deepseek-ai/schemastery'

export const name = 'effort-router'

const DEFAULT_JUDGE = 'http://127.0.0.1:8765/judge'
const JUDGE_TIMEOUT_MS = 20000
const MAX_TASK_CHARS = 4000
const SERVICE_LOG_PATH = `${tmpdir()}/laya-router-service.log`
/** 首次部署的完整输出。pip、权重下载、服务启动日志都在这里。 */
const SETUP_LOG_PATH = `${tmpdir()}/router-effort-setup.log`
/** 挂载痕迹。宿主没有稳定的 stderr 落盘，这里记一行，重启后能确认插件到底有没有挂上。 */
const MOUNT_LOG_PATH = `${tmpdir()}/router-effort.log`

/** 判定后端。local 走本机服务；jev 是留给判断型模型 API 的位置，当前不发起调用。 */
const JUDGE_SOURCES = ['local', 'jev']
const MODES = ['auto', 'manual']

/** 档位到强度名的默认映射，也是页面里那四个下拉的名字。 */
const TIER_KEYS = ['low', 'high', 'max', 'fallback']
const DEFAULT_TIERS = { low: 'low', high: 'high', max: 'max', fallback: 'low' }
/** 最近判定的保留条数。落盘和芯片列表都用它。 */
const MAX_RECENT = 50
/** 查询参数的长度上限。端点名与模型名都很短，超长的一律当非法。 */
const MAX_QUERY_LENGTH = 200
/** 模型档位缓存的容量上限，防止外部传入的端点名把这张表撑大。 */
const MAX_MODEL_CACHE = 200

/**
 * 配置 schema。
 *
 * mode / judgeUrl / notify 标 volatile：设置页改完即时生效，不必重挂。声明 schema 之后，
 * 没有列在这里的配置字段会被剥掉，所以现有字段必须全部写上。
 */
export const Config = z.object({
  mode: z.union(MODES).default('auto').volatile(),
  judgeSource: z.union(JUDGE_SOURCES).default('local'),
  judgeUrl: z.string().default(DEFAULT_JUDGE).volatile(),
  notify: z.string().default('').volatile(),
  tiers: z.dict(z.string()).volatile(),
  autoStart: z.boolean(),
  servicePython: z.string(),
  serviceScript: z.string(),
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

/**
 * 强度从弱到强。各厂商词汇不同（deepseek 只有 low/high/max，minimax 多 medium/xhigh），
 * 这里只做跨厂商的粗序，认不出的强度当作未知。
 */
const ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 一个强度名在 ORDER 里的位置；未知返回 undefined。 */
export function strengthOf(effort) {
  const index = ORDER.indexOf(String(effort ?? '').toLowerCase())
  return index === -1 ? undefined : index
}

/**
 * 在 `available` 里挑一个不超过 `target` 的最强档。
 *
 * 模型全部比 target 强时给最弱那个（例如目标 low，而模型只有 high/max）；
 * available 为空、或全是不认识的强度名时返回 undefined，调用方保持原配置。
 */
export function pickEffort(available, target) {
  const targetIndex = strengthOf(target)
  if (targetIndex === undefined) return undefined
  const known = (available ?? [])
    .map((id) => ({ id, index: strengthOf(id) }))
    .filter((entry) => entry.index !== undefined)
    .sort((left, right) => left.index - right.index)
  if (known.length === 0) return undefined
  let best
  for (const entry of known) {
    if (entry.index <= targetIndex) best = entry.id
  }
  return best ?? known[0].id
}

/** 一条消息里的纯文本，拼起来；没有文本时返回空串。 */
function textOf(message) {
  return (message && Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function sessionKey(payload) {
  const session = payload && payload.agent && payload.agent.session
  return (session && (session.id || session.sessionId)) || 'global'
}

function log(message) {
  process.stderr.write(`[effort-router] ${message}\n`)
}

/**
 * 本轮真正要用的模型。
 *
 * 上一次请求头里的模型是上一轮的，用户这一轮换了模型就会写错。会话的模型选择
 * 投影里 `pending` 才是尚未落地的本轮选择，没有 pending 时才用 `lastUsed`。
 * 投影读不到（没有 session controller 的宿主）就退回请求头。
 */
function currentRoute(ctx, payload) {
  const session = payload && payload.agent && payload.agent.session
  if (!session) return undefined
  try {
    // strict=false：宿主没挂 session controller 时返回 undefined，而不是抛错。
    const projections = ctx.get('sessionProjections', false)
    const state = projections && typeof projections.stateOf === 'function'
      ? projections.stateOf(session, 'modelSelection')
      : undefined
    const chosen = state?.pending ?? state?.lastUsed
    if (chosen && chosen.provider && chosen.model) {
      return { provider: chosen.provider, model: chosen.model, reasoningEffort: chosen.reasoningEffort }
    }
  } catch {
    /* 投影服务不在，走请求头 */
  }
  try {
    const config = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
    if (config && config.provider && config.model) {
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    }
  } catch {
    /* 没有请求头 */
  }
  return undefined
}

/** 问判定服务要一个档位；任何失败都返回 null。成功时把 state 刷成 up。 */
async function judgeTier(url, task, signal, state) {
  if (typeof task !== 'string' || task === '') return null
  const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS)
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
      log(`判定服务返回 HTTP ${response.status}，本轮不改强度`)
      return null
    }
    const body = await response.json()
    const tier = typeof body?.tier === 'string' ? body.tier.trim().toLowerCase() : ''
    if (tier !== '' && state !== undefined && state !== null) {
      // 服务答得上话，状态就该是 up。启动阶段那一次探活失败不该永久定死状态。
      state.state = 'up'
      state.detail = ''
    }
    return tier === '' ? null : tier
  } catch (error) {
    log(`判定服务不可用（${error && error.message ? error.message : error}），本轮不改强度`)
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
 * volatile 字段在运行时是个带 `get()` 的句柄，不是普通值。
 * 普通字段原样返回；句柄读一次拿当前值；取不到时用 fallback。
 */
function valueOf(input, fallback) {
  try {
    if (input !== undefined && input !== null && typeof input.get === 'function') {
      const value = input.get()
      return value === undefined ? fallback : value
    }
  } catch {
    /* 落到 fallback */
  }
  return input === undefined || input === null ? fallback : input
}

/** 配置里的毫秒值可能是 YAML 数字也可能是字符串；不合法时用默认值。 */
function toMs(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
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
function isSubagent(payload) {
  try {
    const session = payload && payload.agent && payload.agent.session
    const header = session && typeof session.header === 'object' ? session.header : undefined
    return header !== undefined && header !== null && header.origin === 'subagent'
  } catch {
    return false
  }
}

/** 拉起本机判定服务，返回一句结果说明。失败不影响路由。 */
function startService(base, python, script) {
  if (!python || !script) return '未配置判定服务路径，跳过启动'
  if (!existsSync(python) || !existsSync(script)) return `判定服务文件缺失（${python} / ${script}），跳过启动`
  let fd
  try {
    fd = openSync(SERVICE_LOG_PATH, 'a')
  } catch {
    fd = undefined
  }
  try {
    // pythonw 是窗口子系统，不会弹出黑色控制台。
    let exe = python
    const pythonw = python.replace(/python(\.exe)?$/i, 'pythonw.exe')
    if (process.platform === 'win32' && existsSync(pythonw)) exe = pythonw
    const port = new URL(base).port || '8765'
    const child = spawn(exe, [script, '--http', '--port', port], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', fd === undefined ? 'ignore' : fd],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    child.unref()
    return `已拉起判定服务（${exe}）`
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

/** 最近判定落盘的位置。重启后芯片要能显示上一次的档位。 */
function recentPath() {
  return join(provisionRoot(), 'last.json')
}

/**
 * 会话 id 的归一化。
 *
 * 宿主侧的 session.id 带 `session-` 前缀，前端 `sessionId` 有时给裸 uuid。
 * 两边都归一化再比，芯片才能精确对上自己的会话。
 */
function bareSession(value) {
  return String(value ?? '').replace(/^session-/, '')
}

/** 读回上次落盘的判定。文件不存在、坏掉、结构不对都当空表；只留最新的 limit 条。 */
function loadRecent(limit) {
  try {
    const parsed = JSON.parse(readFileSync(recentPath(), 'utf8'))
    const rows = parsed !== null && typeof parsed === 'object' && parsed.records !== null && typeof parsed.records === 'object'
      ? parsed.records
      : {}
    return new Map(Object.entries(rows)
      .filter((entry) => entry[1] !== null && typeof entry[1] === 'object')
      .sort((left, right) => (Number(right[1]?.at) || 0) - (Number(left[1]?.at) || 0))
      .slice(0, limit))
  } catch {
    return new Map()
  }
}

/**
 * 把最近判定写回磁盘，只留最近几条。
 *
 * 三处细节都是为了多个进程共存时不互相踩：
 * 1. 先读回磁盘再合并，各进程只补自己新写的行，不整表覆盖对方的记录；
 * 2. 临时文件名带 pid 与随机后缀，两个进程同时写不会踩同一个临时文件；
 * 3. 先写临时文件再改名，进程被杀也不会留下半个 JSON。
 * 写不了不影响路由。
 */
function saveRecent(recent, limit) {
  try {
    mkdirSync(provisionRoot(), { recursive: true })
    const target = recentPath()
    const merged = loadRecent(limit)
    for (const [key, value] of recent) {
      const existing = merged.get(key)
      if (existing === undefined || (Number(value?.at) || 0) >= (Number(existing?.at) || 0)) {
        merged.set(key, value)
      }
    }
    const rows = [...merged.entries()]
      .sort((left, right) => (Number(right[1]?.at) || 0) - (Number(left[1]?.at) || 0))
      .slice(0, limit)
    const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, records: Object.fromEntries(rows) }, null, 2)}\n`)
    renameSync(temporary, target)
  } catch {
    /* 写不了就算了，芯片最多少一条历史 */
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
   * 热改字段的当前值：设置面优先，读不到用挂载时的快照。
   * 一轮读一次就够，调用方把结果往下传，避免同一轮反复 describe。
   */
  function live() {
    const values = liveSettings(ctx, entryId)
    const tierSource = values?.tiers !== undefined && values.tiers !== null && typeof values.tiers === 'object'
      ? { ...tiers, ...values.tiers }
      : tiers
    return {
      mode: MODES.includes(values?.mode) ? values.mode : mode.current,
      judgeSource: JUDGE_SOURCES.includes(values?.judgeSource) ? values.judgeSource : (valueOf(cfg.judgeSource, 'local') === 'jev' ? 'jev' : 'local'),
      judgeUrl: typeof values?.judgeUrl === 'string' && values.judgeUrl !== '' ? values.judgeUrl : mountedJudgeUrl,
      notify: typeof values?.notify === 'string' ? values.notify : String(valueOf(cfg.notify, '') ?? ''),
      tiers: { ...DEFAULT_TIERS, ...tierSource },
    }
  }

  trace(`mounted mode=${mode.current} judge=${mountedJudgeUrl} entry=${entryId}`)

  /** 判定服务的状态，给 /effort-router/judge 看。 */
  const judge = { state: 'unknown', detail: '' }

  /** 本轮用户在退让前的原话。inbox 被认领时就记下来，请求时读不到消息体。 */
  const tasks = new Map()
  /** 会话 -> { turn, tier }，一轮只判一次。 */
  const verdicts = new Map()
  /** 会话 -> { turn, effort }，记下我们自己写过的强度，用来区分“用户改的”和“我们写的”。 */
  const written = new Map()
  /** provider/model -> { at, list }，档位解析结果，带寿命。 */
  const infos = new Map()
  /** 会话 -> 本轮 pre-step 判出的档位，供同一步的请求复用，避免问两次。 */
  const pending = new Map()
  /** 会话 -> 最近一次判定，供输入框旁的芯片显示。启动时从磁盘读回，重启后芯片不会空。 */
  const recent = loadRecent(MAX_RECENT)
  /** 浏览器半边最后一次报到的时间、它带上来的会话参数，以及组件收到的 props 键名。 */
  const clientSeen = { at: 0, lastQuery: null, keys: null, sid: null }

  /** 记一次判定结果。芯片读的是这里，不读会话日志。值没变就不落盘。 */
  function recordVerdict(key, tier, effort, provider, model) {
    const previous = recent.get(key)
    if (previous !== undefined
      && previous.tier === tier
      && previous.effort === effort
      && previous.provider === provider
      && previous.model === model) return
    recent.set(key, { tier, effort, provider, model, at: Date.now() })
    saveRecent(recent, MAX_RECENT)
  }

  /**
   * 问一次判定器要档位。任何后端失败都返回 null，调用方保持原强度。
   * `now` 是本轮读到的热改值，后端选择与地址都从它取。
   */
  async function askJudge(task, signal, now) {
    if (now.judgeSource === 'jev') {
      // 留着的位置：判断型模型 API（Jev）。当前只用本地服务，这里不发起调用。
      return null
    }
    return judgeTier(now.judgeUrl, task, signal, judge)
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
   * 请求都不等它。没就绪之前那几轮按“判定失败”处理，也就是不改强度，请求照常发。
   */
  async function ensureJudge() {
    const base = serviceBase(mountedJudgeUrl)
    const startupWaitMs = toMs(process.env.ROUTER_EFFORT_STARTUP_WAIT_MS ?? cfg.startupWaitMs, 3000)
    const startWaitMs = toMs(process.env.ROUTER_EFFORT_START_WAIT_MS ?? cfg.startWaitMs, 90000)
    try {
      if (await waitForService(base, startupWaitMs)) {
        judge.state = 'up'
        judge.detail = ''
        log(`判定服务已在线（${base}）`)
        return
      }
      if (cfg.autoStart !== false && cfg.servicePython && cfg.serviceScript) {
        judge.state = 'starting'
        log(startService(base, cfg.servicePython, cfg.serviceScript))
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
        log('判定服务不在线，provision 关闭，本轮起不改强度')
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

  // 总是探一次：状态接口要反映真实可用性。拉起与部署各自受 autoStart / provision 控制。
  void ensureJudge()

  // provider 拓扑变了（新加 provider、改模型定义），缓存的档位立刻作废。
  ctx.on('llm/adapters-updated', () => { infos.clear() })

  ctx.on('agent/inbox/claimed', (payload) => {
    const text = textOf(payload && payload.message)
    if (text === '') return
    tasks.set(sessionKey(payload), text)
  }, { global: true })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    const now = live()
    if (now.mode === 'manual') return base
    if (!base || !base.provider || !base.model) return base
    // 子代理的强度跟主代理走，这里不覆盖。
    if (isSubagent(payload)) return base
    try {
      const key = sessionKey(payload)
      const turn = payload && payload.turn
      const cached = verdicts.get(key)
      let tier
      if (cached !== undefined && cached.turn === turn) {
        tier = cached.tier
      } else if (pending.has(key)) {
        // pre-step 在 step 1 已经问过判定服务，这里直接复用。
        tier = pending.get(key)
        pending.delete(key)
        verdicts.set(key, { turn, tier })
      } else {
        tier = await askJudge(tasks.get(key), payload && payload.signal, now)
        verdicts.set(key, { turn, tier })
      }
      if (tier === null || tier === undefined) return base

      const target = now.tiers[tier] ?? now.tiers.fallback
      const picked = pickEffort(await effortsFor(base.provider, base.model), target)
      if (picked === undefined) return base

      // 上一轮之后强度被改过，说明是用户自己拧的：这时只升不降。
      const previous = written.get(key)
      let effort = picked
      if (previous !== undefined && previous.turn !== turn
        && base.reasoningEffort !== undefined && base.reasoningEffort !== previous.effort) {
        const pinned = strengthOf(base.reasoningEffort)
        const want = strengthOf(picked)
        if (pinned !== undefined && want !== undefined && want <= pinned) effort = base.reasoningEffort
      }
      written.set(key, { turn, effort })
      recordVerdict(key, tier, effort, base.provider, base.model)
      if (effort === base.reasoningEffort) return base
      log(`turn ${turn} ${tier} -> ${target} => ${effort}（${base.provider}/${base.model}）`)
      return { ...base, reasoningEffort: effort }
    } catch (error) {
      log(`本轮跳过（${error && error.message ? error.message : error}）`)
      return base
    }
    // prepend：排在会话级监听之前，否则用户没显式选强度时，我们写的值会被抹掉。
  }, { global: true, prepend: true })

  // 每轮第一步在对话里留一条可见提示：难度档位、最终强度、模型。
  // 只在强度和上一轮不同、或 notify: always 时插入，避免每轮都刷屏。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const now = live()
    if (now.mode === 'manual' || now.notify === 'off') return decision
    if (decision.kind === 'reject') return decision
    if (payload.step !== 1) return decision
    try {
      const route = currentRoute(ctx, payload)
      if (route === undefined) {
        // 拿不到本轮模型时插不了提示（提示里要写模型名）。留一行痕迹，免得像“没生效”。
        trace('pre-step: 拿不到本轮模型，跳过提示')
        return decision
      }
      const key = sessionKey(payload)
      const tier = await askJudge(tasks.get(key), payload.signal, now)
      if (tier === null) return decision
      pending.set(key, tier)
      const effort = pickEffort(await effortsFor(route.provider, route.model), now.tiers[tier] ?? now.tiers.fallback)
      if (effort === undefined) return decision
      if (now.notify !== 'always' && effort === route.reasoningEffort) return decision
      recordVerdict(key, tier, effort, route.provider, route.model)
      trace(`pre-step: 插入提示 ${tier} -> ${effort}（${route.provider}/${route.model}）`)
      return { ...decision, messages: [...decision.messages, notice(tier, effort, route.provider, route.model)] }
    } catch (error) {
      log(`提示生成失败（${error && error.message ? error.message : error}）`)
      return decision
    }
  }, { global: true, prepend: true })

  // 运行时开关：GET 读当前模式，POST body {"mode":"auto"|"manual"} 切换。
  // 旧路径 /router-effort/* 保留为别名，README 与已有脚本里的 curl 继续可用。
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) {
      trace('webServer 不可用，模式开关没注册')
      return
    }
    trace('webServer 就绪，注册 /effort-router/mode 与 /effort-router/judge（含旧别名）')
    /**
     * 读 JSON 请求体。
     *
     * 强制 `application/json`：插件路由不受宿主 auth fence 保护，浏览器里任意页面都能向
     * localhost 发 no-cors 的 text/plain POST。要求 JSON 类型会让跨站请求触发预检而失败，
     * 顺手挡掉配置被跨站改写的路径。
     */
    const collectJson = (req, send, onBody) => {
      const headers = req !== null && typeof req === 'object' && req.headers !== undefined ? req.headers : {}
      const contentType = String(headers['content-type'] ?? '').toLowerCase()
      if (!contentType.includes('application/json')) {
        send(415, { error: 'content-type must be application/json' })
        return
      }
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (Buffer.byteLength(raw) > 8192) req.destroy()
      })
      req.on('end', () => {
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          send(400, { error: 'body must be json' })
          return
        }
        if (body === null || typeof body !== 'object') {
          send(400, { error: 'body must be a json object' })
          return
        }
        void onBody(body)
      })
    }

    /** 把改动写回 profile。这是设置页保存的唯一落盘路径；没有设置面时退回内存开关。 */
    const writeConfig = async (patch) => {
      const clean = {}
      if (MODES.includes(patch.mode)) clean.mode = patch.mode
      if (JUDGE_SOURCES.includes(patch.judgeSource)) clean.judgeSource = patch.judgeSource
      if (typeof patch.judgeUrl === 'string' && patch.judgeUrl !== '') {
        // 判定地址每轮都会收到用户原文，必须限定成 http(s)，别的 scheme 一律拒绝。
        let parsed
        try {
          parsed = new URL(patch.judgeUrl)
        } catch {
          parsed = undefined
        }
        if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          return { ok: false, detail: 'judgeUrl 必须是 http(s) 地址' }
        }
        clean.judgeUrl = parsed.toString()
      }
      if (patch.notify === '' || patch.notify === 'off' || patch.notify === 'always') clean.notify = patch.notify
      if (patch.tiers !== undefined && patch.tiers !== null && typeof patch.tiers === 'object') {
        const next = {}
        for (const key of TIER_KEYS) {
          const value = patch.tiers[key]
          if (value === undefined) continue
          if (typeof value !== 'string' || strengthOf(value) === undefined) {
            return { ok: false, detail: `档位 ${key} 的强度名不认识：${String(value)}` }
          }
          next[key] = value
        }
        if (Object.keys(next).length > 0) clean.tiers = next
      }
      if (Object.keys(clean).length === 0) return { ok: false, detail: '没有可写的字段' }
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

    const judgeHandler = (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end()
        return
      }
      const text = JSON.stringify({
        state: judge.state,
        detail: judge.detail,
        judgeUrl: live().judgeUrl,
        setupLog: SETUP_LOG_PATH,
      })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Length', String(Buffer.byteLength(text)))
      res.end(text)
    }
    const modeHandler = (req, res) => {
      const send = (code, body) => {
        const text = JSON.stringify(body)
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(Buffer.byteLength(text)))
        res.end(text)
      }
      if (req.method === 'GET') {
        send(200, { mode: live().mode })
        return
      }
      if (req.method !== 'POST') {
        send(405, { error: 'method not allowed' })
        return
      }
      collectJson(req, send, async (body) => {
        if (!MODES.includes(body.mode)) {
          send(400, { error: 'mode must be auto or manual' })
          return
        }
        const outcome = await writeConfig({ mode: body.mode })
        if (!outcome.ok) {
          send(503, outcome)
          return
        }
        send(200, { mode: live().mode, persisted: outcome.persisted === true })
      })
    }
    /** 诊断用：问出某个 provider/model 现在解析到的档位，用来确认新加的模型被读到了。 */
    const modelsHandler = (req, res) => {
      const send = (code, body) => {
        const text = JSON.stringify(body)
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(Buffer.byteLength(text)))
        res.end(text)
      }
      if (req.method !== 'GET') {
        send(405, { error: 'method not allowed' })
        return
      }
      let provider = ''
      let model = ''
      try {
        const query = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1').searchParams
        provider = query.get('provider') || ''
        model = query.get('model') || ''
      } catch {
        provider = ''
        model = ''
      }
      if (provider === '' || model === '' || provider.length > MAX_QUERY_LENGTH || model.length > MAX_QUERY_LENGTH) {
        send(400, { error: 'provider and model are required, at most 200 characters each' })
        return
      }
      void (async () => {
        try {
          const efforts = await effortsFor(provider, model)
          send(200, { provider, model, efforts, ttlMs: toMs(cfg.modelInfoTtlMs, 60000) })
        } catch (error) {
          send(500, { error: error && error.message ? error.message : String(error) })
        }
      })()
    }
    /** 输入框旁的芯片读这里：每个会话最近一次判定。 */
    const lastHandler = (req, res) => {
      const send = (code, body) => {
        const text = JSON.stringify(body)
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(Buffer.byteLength(text)))
        res.end(text)
      }
      if (req.method !== 'GET') {
        send(405, { error: 'method not allowed' })
        return
      }
      let session = ''
      try {
        session = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1').searchParams.get('session') || ''
      } catch {
        session = ''
      }
      if (session.length > MAX_QUERY_LENGTH) session = ''
      const all = [...recent.entries()]
        .map(([key, value]) => ({ session: key, ...value }))
        .sort((left, right) => right.at - left.at)
      // 展示只取前 20 条，但“当前会话”在完整列表里找，免得命中被截掉。
      const records = all.slice(0, 20)
      clientSeen.lastQuery = session === '' ? null : session
      const wanted = bareSession(session)
      const current = wanted === ''
        ? undefined
        : all.find((row) => bareSession(row.session) === wanted)
      send(200, {
        records,
        current: current === undefined ? null : current,
        seenAt: clientSeen.at,
        lastQuery: clientSeen.lastQuery,
        propsKeys: clientSeen.keys,
        propsSid: clientSeen.sid,
      })
    }
    /** 浏览器半边的报到点：有值就说明 client bundle 在页面里跑过。 */
    const seenHandler = (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end()
        return
      }
      let keys = ''
      let sid = ''
      try {
        const query = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1').searchParams
        keys = (query.get('keys') || '').slice(0, MAX_QUERY_LENGTH)
        sid = (query.get('sid') || '').slice(0, MAX_QUERY_LENGTH)
      } catch {
        keys = ''
        sid = ''
      }
      clientSeen.at = Date.now()
      if (keys !== '') clientSeen.keys = keys
      if (sid !== '') clientSeen.sid = sid
      const text = JSON.stringify({ ok: true, at: clientSeen.at, keys: clientSeen.keys ?? null, sid: clientSeen.sid ?? null })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Length', String(Buffer.byteLength(text)))
      res.end(text)
    }
    const configHandler = (req, res) => {
      const send = (code, body) => {
        const text = JSON.stringify(body)
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(Buffer.byteLength(text)))
        res.end(text)
      }
      if (req.method === 'GET') {
        send(200, readConfig())
        return
      }
      if (req.method !== 'POST') {
        send(405, { error: 'method not allowed' })
        return
      }
      collectJson(req, send, async (body) => {
        const outcome = await writeConfig(body)
        if (!outcome.ok) {
          send(503, outcome)
          return
        }
        send(200, { ok: true, persisted: outcome.persisted === true, config: readConfig() })
      })
    }
    for (const path of ['/effort-router/judge', '/router-effort/judge']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: judgeHandler }))
    }
    for (const path of ['/effort-router/mode', '/router-effort/mode']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: modeHandler }))
    }
    for (const path of ['/effort-router/config', '/router-effort/config']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: configHandler }))
    }
    for (const path of ['/effort-router/models', '/router-effort/models']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: modelsHandler }))
    }
    for (const path of ['/effort-router/last', '/router-effort/last']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: lastHandler }))
    }
    for (const path of ['/effort-router/seen', '/router-effort/seen']) {
      scoped.effect(() => webServer.register({ kind: 'exact', path, handler: seenHandler }))
    }
  })
}
