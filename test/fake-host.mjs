/**
 * 0.2.2 的宿主替身：假 agent、假 ctx、假 HTTP 路由。
 *
 * 为什么要有这个文件：0.2.2 起插件只在 agent/inbox/inserted 里、用 agent.runMaintenance()
 * 把本轮唤醒扣住，再用 agent.model.select() 写强度。三样东西都得在测试里复现，
 * 散在各测试文件里会各自漂移，所以集中在这里。
 *
 * 复刻的是行为，不是实现：
 * - agent.status 在 maintenance 期间仍然是 'idle'（真机就是这么写的，
 *   所以插件才需要自己用 Set 防重入）；
 * - model.select() 值相同时短路（真机 sameModelSelection 的行为）；
 * - model.current() 先看会话记下的选择，没有才回落到 agent 的默认强度；
 * - runMaintenance() 在 phase 非 idle 时抛错（真机也是抛）。
 */

export const EFFORTS_3 = [{ id: 'low' }, { id: 'high' }, { id: 'max' }]
export const EFFORTS_5 = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }]

/**
 * 统一的断言与计数出口。文件末尾调 done()，失败时进程退出码非 0。
 *
 * options.exit 为 false 时只设退出码、不调 process.exit：有 socket 还在关闭时，
 * process.exit 会把句柄从事件循环底下抽走，Windows 上会断言
 * `!(handle->flags & UV_HANDLE_CLOSING)`。让事件循环自己排空的测试用这个。
 */
export function makeChecker(options = {}) {
  let failures = 0
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures += 1
    console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + JSON.stringify(actual) + (ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'))
  }
  const done = () => {
    console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 个失败')
    if (options.exit === false) {
      process.exitCode = failures === 0 ? 0 : 1
      return
    }
    process.exit(failures === 0 ? 0 : 1)
  }
  return { check, done }
}

/**
 * 假 agent。
 *
 * options.id - 会话 id。
 * options.provider / options.model - agent 的默认路由（模型选择器里的那个）。
 * options.reasoningEffort - agent 的默认强度；模型没声明强度时省略。
 * options.recorded - 会话里已经记下的选择，模拟「重启后读回会话日志」。
 * options.header - session.header，用来模拟子代理。
 * options.efforts - 这个模型声明的强度列表，select 不校验，但测试要按它断言。
 */
export function makeAgent(options = {}) {
  const {
    id = 'session-test',
    provider = 'p',
    model = 'm',
    reasoningEffort,
    recorded = null,
    header,
    efforts = EFFORTS_3,
    // 宿主哪天把 recordedSelection / options 收回去，插件只能退回保守判断。
    // 打开这个开关就能测那条退路。
    strictModel = false,
  } = options
  const phase = { kind: 'idle' }
  const selections = []
  let stored = recorded === null ? null : { ...recorded }

  const agent = {
    id,
    efforts,
    selections,
    session: header === undefined ? { id } : { id, header },
    get status() {
      return phase.kind === 'idle' || phase.kind === 'maintenance' ? 'idle' : 'running'
    },
    /** 模拟「正在跑一轮」：插件此时不该抢 hold。 */
    setRunning() {
      phase.kind = 'running'
    },
    setIdle() {
      phase.kind = 'idle'
    },
    model: {
      ...(strictModel ? {} : { options: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }),
      current() {
        if (stored !== null) return { ...stored }
        if (!provider || !model) return undefined
        return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      },
      select(selection) {
        const same = stored !== null
          && stored.provider === selection.provider
          && stored.model === selection.model
          && stored.reasoningEffort === selection.reasoningEffort
        if (same) return
        stored = {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }
        selections.push({ ...stored })
      },
      ...(strictModel ? {} : {
        recordedSelection() {
          return stored === null ? null : { ...stored }
        },
      }),
    },
    /** 最近一次 hold 的 Promise：测试用它等判定跑完。 */
    settled: Promise.resolve(),
    runMaintenance(job) {
      if (phase.kind !== 'idle') throw new Error('agent "' + id + '" already has active work')
      phase.kind = 'maintenance'
      const abort = new AbortController()
      agent.lastSignal = abort.signal
      const task = (async () => {
        try {
          return await job(abort.signal)
        } finally {
          phase.kind = 'idle'
        }
      })()
      agent.settled = task.then(() => undefined, () => undefined)
      return task
    },
  }
  return agent
}

/**
 * 假 ctx。
 *
 * 只实现插件真正会调的那几处：on 收事件、get 取服务、inject 拿 webServer。
 * settings.describe() 的形状照真机：[{ ns, value }]，value 是当前配置值。
 */
export function makeContext(options = {}) {
  const handlers = new Map()
  const routes = new Map()
  const state = { ...(options.settings ?? {}) }
  const infoCalls = []
  const credentialValues = options.credentials ?? {}
  const credentialWrites = []

  return {
    handlers,
    routes,
    state,
    infoCalls,
    credentialValues,
    credentialWrites,
    on(event, handler) {
      handlers.set(event, handler)
    },
    get(name) {
      if (name === 'llm') {
        const efforts = options.efforts === undefined ? EFFORTS_3 : options.efforts
        return {
          async resolveModelInfo(provider, model) {
            infoCalls.push({ provider, model })
            const list = typeof efforts === 'function' ? efforts(provider, model) : efforts
            return list === null ? {} : { reasoning: { efforts: list } }
          },
        }
      }
      if (name === 'settings') {
        if (options.noSettings === true) return undefined
        return {
          describe() {
            return [{ ns: 'effort-router', value: { ...state } }]
          },
          async update(ns, patch) {
            Object.assign(state, patch)
          },
        }
      }
      if (name === 'credentials') {
        if (options.noCredentials === true) return undefined
        return {
          async resolve(ref) {
            return Object.prototype.hasOwnProperty.call(credentialValues, ref)
              ? { value: credentialValues[ref], source: 'test' }
              : undefined
          },
          async describe(ref) {
            const configured = Object.prototype.hasOwnProperty.call(credentialValues, ref)
            return { configured, source: configured ? 'test' : null }
          },
          async set(ref, value) {
            credentialValues[ref] = value
            credentialWrites.push({ ref, value })
          },
        }
      }
      return undefined
    },
    inject(services, fn) {
      if (!services.includes('webServer')) return
      fn({
        get: () => ({
          register(entry) {
            routes.set(entry.path, entry.handler)
            return () => routes.delete(entry.path)
          },
        }),
        effect(run) {
          run()
        },
      })
    },
    effect(fn) {
      fn()
    },
    /** 触发一条已注册的事件监听器，返回它的返回值（waterfall 用）。 */
    emit(event, payload) {
      const handler = handlers.get(event)
      if (handler === undefined) return undefined
      return handler(payload)
    },
    has(event) {
      return handlers.has(event)
    },
  }
}

/** 调一条已注册的 HTTP 路由，返回 { code, body }。 */
export function callRoute(ctx, path, body, options = {}) {
  const handler = ctx.routes.get(path)
  if (handler === undefined) throw new Error('没有注册路由 ' + path)
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method: options.method ?? 'POST',
      url: path,
      headers: options.headers ?? { 'content-type': 'application/json' },
      on(event, fn) {
        listeners[event] = fn
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolve({ code: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) })
      },
    }
    handler(req, res)
    if (body !== undefined) listeners.data?.(JSON.stringify(body))
    listeners.end?.()
  })
}