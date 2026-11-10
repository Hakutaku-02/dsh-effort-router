/**
 * 插件的 HTTP 路由。
 *
 * 浏览器半边只用这几条端点：读配置、存配置、探活、写 Key、读芯片数据。这里只做请求校验与
 * 形状转换，判定、落位、凭据、落盘都在 apply() 里，通过 `deps` 传进来，所以这个文件不需要
 * 认识宿主、磁盘或模型。
 *
 * 路由名单独给出：`/effort-router/*` 是正式路径，`/router-effort/*` 是旧别名。
 */
import { collectJson, sameOrigin, send, sendBare } from './respond.mjs'

/** 两组路径前缀。README 与已有脚本里的 curl 用的是旧那组，一直留着。 */
export const ROUTE_PREFIXES = ['/effort-router', '/router-effort']

/** 查询参数的长度上限。端点名与模型名都很短，超长的一律当非法。 */
const MAX_QUERY_LENGTH = 200

/**
 * 造出九条路由。
 *
 * `deps` 的每一项都由 apply() 提供：
 * - live()：本轮配置（设置面优先，读不到退回挂载快照）；
 * - judge / recent / clientSeen：判定服务的可用性、最近判定、浏览器半边的报到记录；
 * - readConfig / writeConfig：设置页那两份数据；
 * - effortsFor / pickForTier：当前模型声明的强度与档位落位；
 * - probeBackend / keyStatus / saveKey / openCredentials：设置页的「测试」与 Key 管理；
 * - limits / enums：长度上限与枚举，全部来自 config/settings.mjs。
 */
export function createRoutes(deps) {
  const {
    live, judge, recent, clientSeen, readConfig, writeConfig,
    effortsFor, pickForTier, probeBackend, keyStatus, saveKey, openCredentials,
    bareSession, trace,
    limits: { modelInfoTtlMs, setupLogPath },
    enums: { modes, judgeSources, tierKeys },
  } = deps

  /** 判定服务的状态：用户切到 Jev 时不显示本地服务的部署日志。 */
  const judgeHandler = (req, res) => {
    if (req.method !== 'GET') return sendBare(res, 405)
    const now = live()
    const jev = now.judgeSource === 'jev'
    send(res, 200, {
      backend: now.judgeSource,
      state: judge.state,
      detail: judge.detail,
      judgeUrl: jev ? now.jevUrl : now.judgeUrl,
      ...(jev ? { jevModel: now.jevModel } : { setupLog: setupLogPath }),
    })
  }

  const modeHandler = (req, res) => {
    if (req.method === 'GET') return send(res, 200, { mode: live().mode })
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    collectJson(req, res, async (body) => {
      if (!modes.includes(body.mode)) return send(res, 400, { error: 'mode must be auto or manual' })
      const outcome = await writeConfig({ mode: body.mode })
      if (!outcome.ok) return send(res, outcome.invalid === true ? 400 : 503, outcome)
      send(res, 200, { mode: live().mode, persisted: outcome.persisted === true })
    })
  }

  const configHandler = (req, res) => {
    if (req.method === 'GET') return send(res, 200, readConfig())
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    collectJson(req, res, async (body) => {
      const outcome = await writeConfig(body)
      if (!outcome.ok) return send(res, outcome.invalid === true ? 400 : 503, outcome)
      send(res, 200, { ok: true, persisted: outcome.persisted === true, config: readConfig() })
    })
  }

  /** 诊断用：问出某个 provider/model 现在解析到的档位，用来确认新加的模型被读到了。 */
  const modelsHandler = (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
    let provider = ''
    let model = ''
    let tier = ''
    try {
      const query = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1').searchParams
      provider = query.get('provider') || ''
      model = query.get('model') || ''
      tier = (query.get('tier') || '').toLowerCase()
      if (!tierKeys.includes(tier)) tier = ''
    } catch {
      provider = ''
      model = ''
      tier = ''
    }
    if (provider === '' || model === '' || provider.length > MAX_QUERY_LENGTH || model.length > MAX_QUERY_LENGTH) {
      return send(res, 400, { error: `provider and model are required, at most ${MAX_QUERY_LENGTH} characters each` })
    }
    void (async () => {
      try {
        const efforts = await effortsFor(provider, model)
        let picked
        try {
          picked = tier === '' ? undefined : pickForTier(efforts, tier, live().tiers)
        } catch {
          picked = undefined
        }
        send(res, 200, {
          provider,
          model,
          efforts,
          // 带上 tier 时回这个档位实际会写成什么强度，方便核对位置映射。
          ...(tier === '' ? {} : { tier, picked }),
          ttlMs: modelInfoTtlMs,
        })
      } catch (error) {
        send(res, 500, { error: error && error.message ? error.message : String(error) })
      }
    })()
  }

  /** 输入框旁的芯片读这里：每个会话最近一次判定。 */
  const lastHandler = (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
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
    // 展示只取前 20 条，但「当前会话」在完整列表里找，免得命中被截掉。
    const records = all.slice(0, 20)
    clientSeen.lastQuery = session === '' ? null : session
    const wanted = bareSession(session)
    const current = wanted === ''
      ? undefined
      : all.find((row) => bareSession(row.session) === wanted)
    send(res, 200, {
      records,
      current: current === undefined ? null : current,
      // 开关关掉时芯片整个不出现：宿主把状态一起发过去，前端轮询一次就能决定。
      enabled: live().enabled,
      seenAt: clientSeen.at,
      lastQuery: clientSeen.lastQuery,
      propsKeys: clientSeen.keys,
      propsSid: clientSeen.sid,
    })
  }

  /** 浏览器半边的报到点：有值就说明 client bundle 在页面里跑过。 */
  const seenHandler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendBare(res, 405)
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
    send(res, 200, { ok: true, at: clientSeen.at, keys: clientSeen.keys ?? null, sid: clientSeen.sid ?? null })
  }

  const probeHandler = (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    if (!sameOrigin(req)) return send(res, 403, { ok: false, detail: '只接受本页发起的探活' })
    collectJson(req, res, async (body) => {
      const now = live()
      const wanted = { ...now }
      // 只允许切换后端与模型名：地址一律用已保存的。否则任何页面都能借这个接口把
      // Bearer 凭据发到它自己指定的 URL。
      if (judgeSources.includes(body.judgeSource)) wanted.judgeSource = body.judgeSource
      if (typeof body.jevModel === 'string' && body.jevModel !== '') wanted.jevModel = body.jevModel
      // 地址守卫只比当前后端那一条，且按规范化后的 URL 比：换个大小写、补个默认端口都还是
      // 同一个地址，不该拦；另一条地址改没改与本次测试无关。
      const sameUrl = (left, right) => {
        try {
          return new URL(left).toString() === new URL(right).toString()
        } catch {
          return false
        }
      }
      if (wanted.judgeSource === 'local' && typeof body.judgeUrl === 'string' && body.judgeUrl !== ''
        && !sameUrl(body.judgeUrl, now.judgeUrl)) {
        return send(res, 200, { ok: false, backend: 'local', detail: '地址改过还没保存，先保存再测试', ms: 0 })
      }
      if (wanted.judgeSource === 'jev' && typeof body.jevUrl === 'string' && body.jevUrl !== ''
        && !sameUrl(body.jevUrl, now.jevUrl)) {
        return send(res, 200, { ok: false, backend: 'jev', detail: '地址改过还没保存，先保存再测试', ms: 0 })
      }
      send(res, 200, await probeBackend(wanted))
    })
  }

  /** Key：GET 报状态（不含值），POST 写进凭据库。 */
  const keyHandler = (req, res) => {
    if (req.method === 'GET') {
      void keyStatus(live()).then((status) => send(res, 200, status))
      return
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    if (!sameOrigin(req)) return send(res, 403, { ok: false, detail: '只接受本页发起的写入' })
    collectJson(req, res, async (body) => {
      const value = typeof body.key === 'string' ? body.key.trim() : ''
      if (value === '') return send(res, 400, { ok: false, detail: 'Key 不能为空' })
      if (value.length > 4096) return send(res, 400, { ok: false, detail: 'Key 太长，不像是有效值' })
      const outcome = await saveKey(live(), value)
      if (!outcome.ok) return send(res, outcome.code ?? 503, { ok: false, detail: outcome.detail })
      send(res, 200, { ok: true, ...(await keyStatus(live())) })
    })
  }

  /** 用系统默认程序打开凭据文件。路径固定在凭据文件上，不接受调用方传入。 */
  const openCredentialsHandler = (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    if (!sameOrigin(req)) return send(res, 403, { ok: false, detail: '只接受本页发起的打开请求' })
    const outcome = openCredentials()
    if (!outcome.ok) return send(res, outcome.code ?? 503, { ok: false, detail: outcome.detail })
    trace(`打开凭据文件：${outcome.path}`)
    send(res, 200, { ok: true, path: outcome.path })
  }

  return [
    { name: 'judge', handler: judgeHandler },
    { name: 'mode', handler: modeHandler },
    { name: 'config', handler: configHandler },
    { name: 'models', handler: modelsHandler },
    { name: 'last', handler: lastHandler },
    { name: 'seen', handler: seenHandler },
    { name: 'probe', handler: probeHandler },
    { name: 'key', handler: keyHandler },
    { name: 'open-credentials', handler: openCredentialsHandler },
  ]
}
