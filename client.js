/**
 * 浏览器半边：插件详情页里的配置区。
 *
 * 这个文件是 client module system 的 lazy-CJS bundle：执行时只注册工厂，模块体在首次物化时
 * 才跑，所有副作用都在工厂闭包里。`require("react")` 走 shell 的 frozen platform seed。
 *
 * 页面不直接读写 profile：所有落盘都发包自带的 /effort-router/config，由宿主半边转成
 * settings.update。这样浏览器侧不需要 Remote，也不需要知道 profile 的结构。
 */
window.__ModuleLoader__.load({
  id: 'dsh-effort-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/effort-router/config'
    const LAST_ENDPOINT = '/effort-router/last'
    const KEY_ENDPOINT = '/effort-router/key'
    const OPEN_CREDENTIALS_ENDPOINT = '/effort-router/open-credentials'

    /** 判定服务给的档位，以及每个档位能映射到的强度名（宿主侧的粗序）。 */
    const TIER_KEYS = ['low', 'high', 'max', 'fallback']
    const TIER_LABEL = { low: '简单', high: '中等', max: '困难', fallback: '兜底' }
    /** 凭据来源的显示名。宿主回的是 file / env 这类 token，不直接摆进中文界面。 */
    const SOURCE_LABEL = { file: '文件', env: '环境变量', 'project-env': '项目 .env', 'user-env': '用户 .env' }
    const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    /** 档位映射的可选项：去掉 off。它在这套实现里不会真的关思考，只会落到最低档。 */
    const TIER_OPTIONS = EFFORTS.filter((id) => id !== 'off')
    const DEFAULT_TIERS = { low: 'low', high: 'high', max: 'max', fallback: 'low' }

    /**
     * 把宿主返回的配置整理成表单草稿。
     *
     * 档位在这里归一化：`off` 之类不在下拉里的历史值会被换回默认，
     * 否则 select 显示第一项、草稿却还是旧值，保存又把旧值原样送回去。
     */
    function draftOf(body) {
      const source = body !== null && typeof body === 'object' && body.tiers !== null && typeof body.tiers === 'object' ? body.tiers : {}
      const tiers = { ...DEFAULT_TIERS }
      for (const key of TIER_KEYS) {
        const value = source[key]
        tiers[key] = TIER_OPTIONS.includes(value) ? value : DEFAULT_TIERS[key]
      }
      return {
        enabled: body.enabled !== false,
        mode: body.mode === 'manual' ? 'manual' : 'auto',
        judgeSource: body.judgeSource === 'jev' ? 'jev' : 'local',
        judgeUrl: typeof body.judgeUrl === 'string' ? body.judgeUrl : '',
        notify: body.notify === 'always' ? 'always' : body.notify === 'off' ? 'off' : '',
        tiers,
        jevUrl: typeof body.jevUrl === 'string' ? body.jevUrl : '',
        jevModel: typeof body.jevModel === 'string' ? body.jevModel : '',
        jevApiKeyEnv: typeof body.jevApiKeyEnv === 'string' ? body.jevApiKeyEnv : '',
        jevConfidence: Number.isFinite(Number(body.jevConfidence)) ? String(body.jevConfidence) : '0.6',
      }
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 2px 10px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { minWidth: 72, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      input: {
        flex: '1 1 240px',
        minWidth: 0,
        padding: '4px 8px',
        fontSize: 12,
        font: 'inherit',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      seg: { display: 'inline-flex', gap: 6 },
      chip: (on) => ({
        padding: '3px 10px',
        fontSize: 12,
        font: 'inherit',
        borderRadius: 999,
        cursor: 'pointer',
        border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
        background: on ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'transparent',
        color: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      foot: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      tierRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
      tierCell: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 },
      tierLabel: { color: 'var(--dsw-alias-label-secondary)' },
      select: {
        padding: '2px 6px',
        fontSize: 12,
        font: 'inherit',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      save: {
        padding: '4px 14px',
        fontSize: 12,
        font: 'inherit',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      /** 输入框旁芯片的外框。名字与配置页的 chip() 区分开，两者都用会互相覆盖。 */
      chipBox: {
        display: 'inline-flex',
        alignItems: 'center',
        // 不参与压缩：文字 nowrap，被挤会压到旁边的模型选择器上。
        flex: 'none',
        padding: '0 2px',
        marginRight: 6,
        // 只写 fontSize：`font` 是简写，写在后面会把字号一并重置成继承值。
        fontSize: 11,
        background: 'transparent',
        border: '0',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        cursor: 'default',
      },
    }

    /** 固定字段顺序的配置快照：只用来判断「有没有改动」，不依赖对象键序。 */
    function snapshotOf(value) {
      if (value === null || value === undefined) return ''
      return JSON.stringify([
        value.enabled === true,
        value.mode,
        value.judgeSource,
        value.judgeUrl,
        value.notify,
        TIER_KEYS.map((key) => (value.tiers && value.tiers[key] !== undefined ? value.tiers[key] : '')),
        value.jevUrl,
        value.jevModel,
        value.jevApiKeyEnv,
        String(value.jevConfidence),
      ])
    }

    function ConfigPanel() {
      const [cfg, setCfg] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [probing, setProbing] = React.useState(false)
      const [saved, setSaved] = React.useState('')
      const [keyDraft, setKeyDraft] = React.useState('')
      const [keyStatus, setKeyStatus] = React.useState(null)
      const [keyOpening, setKeyOpening] = React.useState(false)
      const noteTimer = React.useRef(null)

      /** 统一的提示出口：写入前清掉上一条的定时器，3 秒后自动消失。 */
      const showNote = React.useCallback((text) => {
        if (noteTimer.current !== null) clearTimeout(noteTimer.current)
        noteTimer.current = null
        setNote(text)
        if (text) {
          noteTimer.current = setTimeout(() => {
            noteTimer.current = null
            setNote('')
          }, 3000)
        }
      }, [])

      // 卸载时清掉挂起的定时器，别在已卸载的组件上 setState。
      React.useEffect(() => () => {
        if (noteTimer.current !== null) clearTimeout(noteTimer.current)
      }, [])

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(ENDPOINT)
          const body = await res.json()
          setCfg(body)
          const next = draftOf(body)
          setDraft(next)
          // 初次载入就对齐快照，否则一进页面「保存」就是可点的。
          setSaved(snapshotOf(next))
        } catch (error) {
          const message = '读取失败：' + (error && error.message ? error.message : error)
          // 只写 note 会被「读取中…」挡住看不到，另存一份错误状态让页面渲染出来。
          setLoadError(message)
          showNote(message)
        }
      }, [showNote])

      React.useEffect(() => { void load() }, [load])

      /** Key 只写不读：状态只用来显示和算 placeholder，任何已有 Key 都不回显。 */
      const loadKey = React.useCallback(async () => {
        try {
          const res = await fetch(KEY_ENDPOINT)
          const body = await res.json()
          setKeyStatus(body !== null && typeof body === 'object' ? body : { configured: false, source: null })
        } catch {
          // 取不到就当未配置，别让配置页崩掉。
          setKeyStatus({ configured: false, source: null })
        }
      }, [])
      React.useEffect(() => { void loadKey() }, [loadKey])

      const openKeyFile = async () => {
        setKeyOpening(true)
        try {
          const res = await fetch(OPEN_CREDENTIALS_ENDPOINT, { method: 'POST' })
          // 非 JSON 响应也不能把提示变成解析错误：解析失败就退回状态码。
          const body = await res.json().catch(() => undefined)
          if (res.ok === true && body !== undefined && body.ok === true) {
            showNote('已打开 ' + body.path)
          } else {
            showNote('打开失败：' + (body && body.detail ? body.detail : 'HTTP ' + res.status))
          }
        } catch (error) {
          showNote('打开失败：' + (error && error.message ? error.message : error))
        } finally {
          setKeyOpening(false)
        }
      }

      if (draft === null && loadError !== '') return h('div', { style: S.row },
        h('span', { style: S.note }, loadError),
        h('button', {
          style: S.save,
          onClick: () => { setLoadError(''); void load() },
        }, '重试'),
      )
      if (draft === null) return h('div', { style: S.note }, '读取中…')

      const writable = cfg !== null && cfg.writable === true
      // 当前草稿与最近一次成功保存（或初次载入）的快照不同，才算有改动。
      const changed = snapshotOf(draft) !== saved
      // 只填 Key 不动其它字段时也要能保存，否则 Key 提交不出去；初始载入两者皆空仍是灰的。
      const canSave = changed || keyDraft.trim() !== ''

      const save = async () => {
        // Key 走独立接口，先于配置保存：失败就停在这里，配置一动不动。
        let keySaved = false
        // 后面任何一步失败，都要说清 Key 已经写进去了，不然用户会以为整单没存。
        const suffix = () => (keySaved ? '（Key 已保存）' : '')
        const keyText = keyDraft.trim()
        if (keyText !== '') {
          setBusy(true)
          try {
            const res = await fetch(KEY_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: keyText }),
            })
            const body = await res.json()
            if (body === null || typeof body !== 'object' || body.ok !== true) {
              showNote((body && body.detail) || 'Key 保存失败')
              return
            }
            keySaved = true
            setKeyDraft('')
            void loadKey()
          } catch (error) {
            showNote('Key 保存失败：' + (error && error.message ? error.message : error))
            return
          } finally {
            setBusy(false)
          }
        }
        // 宿主 writeConfig 会忽略空字段：空值发过去就被旧配置静默还原，先在前端拦下。
        if (draft.judgeUrl.trim() === '') return showNote('判定地址不能为空' + suffix())
        // 走本地判定时 Jev 那几项是隐藏的，既不校验也不提交，免得报一个看不见的错。
        const jev = draft.judgeSource === 'jev'
        if (jev) {
          if (draft.jevUrl.trim() === '') return showNote('Jev 地址不能为空' + suffix())
          if (draft.jevModel.trim() === '') return showNote('Jev 模型名不能为空' + suffix())
          // 草稿里存的是原始字符串：空串 Number 出 0，会被当成合法阈值「永远听 Jev 自己的档」。
          const confidence = Number(draft.jevConfidence)
          if (draft.jevConfidence.trim() === '' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
            return showNote('置信度阈值必须在 0 到 1 之间' + suffix())
          }
        }
        setBusy(true)
        showNote('')
        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: draft.enabled,
              mode: draft.mode,
              judgeSource: draft.judgeSource,
              judgeUrl: draft.judgeUrl,
              notify: draft.notify,
              tiers: draft.tiers,
              ...(jev ? {
                jevUrl: draft.jevUrl,
                jevModel: draft.jevModel,
                jevConfidence: Number(draft.jevConfidence),
              } : {}),
            }),
          })
          const body = await res.json()
          if (body.ok === true) {
            showNote(body.persisted === true ? '已保存' : '已保存到内存（设置服务不可用）')
            if (body.config) {
              setCfg(body.config)
              // 用宿主回写的配置重建草稿：它会归一化 URL、档位等字段，
              // 只回填 mode 会让「保存」一直停在可点态。
              const next = draftOf(body.config)
              setDraft(next)
              setSaved(snapshotOf(next))
            } else {
              setSaved(snapshotOf(draft))
            }
          } else {
            showNote((body.detail || '保存失败') + suffix())
          }
        } catch (error) {
          showNote('保存失败：' + (error && error.message ? error.message : error) + suffix())
        } finally {
          setBusy(false)
        }
      }

      const probe = async () => {
        setProbing(true)
        showNote('')
        try {
          const res = await fetch('/effort-router/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 带上草稿：测试的应该是「即将保存的这套」，不是上一次保存的那套。
            body: JSON.stringify({
              judgeSource: draft.judgeSource,
              jevModel: draft.jevModel,
              judgeUrl: draft.judgeUrl,
              jevUrl: draft.jevUrl,
            }),
          })
          const body = await res.json()
          // 状态码也要看：非 200 就算响应体里写着 ok 也不算连通。
          if (res.ok === true && body && body.ok === true) {
            showNote(`连通：${body.backend} · ${body.detail}（${body.ms}ms）`)
          } else {
            const detail = body && body.detail !== undefined && body.detail !== null ? body.detail : `HTTP ${res.status}`
            showNote('不通：' + detail)
          }
        } catch (error) {
          showNote('测试失败：' + (error && error.message ? error.message : error))
        } finally {
          setProbing(false)
        }
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: S.label }, '路由开关'),
          h('div', { style: S.seg, role: 'group' },
            [[true, '开启'], [false, '关闭']].map(([value, text]) => h('button', {
              key: String(value),
              style: S.chip(draft.enabled === value),
              'aria-pressed': draft.enabled === value,
              onClick: () => setDraft((previous) => ({ ...previous, enabled: value })),
            }, text)),
          ),
          h('span', { style: S.note }, draft.enabled ? '' : '关掉后完全不改请求'),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, '判定方式'),
          h('div', { style: S.seg, role: 'group' },
            [['local', '本地服务'], ['jev', 'Jev']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.judgeSource === id),
              'aria-pressed': draft.judgeSource === id,
              onClick: () => setDraft((previous) => ({ ...previous, judgeSource: id })),
            }, text)),
          ),
        ),
        draft.judgeSource === 'jev' ? h('div', { style: S.wrap },
          h('div', { style: S.row },
            h('span', { style: S.label }, 'Jev 地址'),
            h('input', {
              style: S.input,
              value: draft.jevUrl,
              placeholder: 'https://api.typesafe.ai/v1/systemone',
              onChange: (event) => setDraft((previous) => ({ ...previous, jevUrl: event.target.value })),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, 'Jev 模型'),
            h('input', {
              style: S.input,
              value: draft.jevModel,
              placeholder: 'jev-latest',
              onChange: (event) => setDraft((previous) => ({ ...previous, jevModel: event.target.value })),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, 'API Key'),
            h('input', {
              style: S.input,
              type: 'password',
              autoComplete: 'new-password',
              value: keyDraft,
              placeholder: keyStatus !== null && keyStatus.configured === true ? '已配置，留空则不修改' : '填入 TypeSafe Jev Key',
              onChange: (event) => setKeyDraft(event.target.value),
            }),
            h('button', {
              style: S.save,
              disabled: keyOpening,
              onClick: () => void openKeyFile(),
            }, keyOpening ? '打开中…' : '打开凭据文件'),
            h('span', { style: S.note },
              keyStatus === null
                ? '读取中…'
                : keyStatus.configured === true
                  ? '已配置' + (keyStatus.source ? '（来源：' + (SOURCE_LABEL[keyStatus.source] ?? keyStatus.source) + '）' : '')
                  : '未配置',
              // 引用名是低敏信息，摆出来才能对上「运行时到底在读哪一条」。
              keyStatus !== null && typeof keyStatus.ref === 'string' ? ' · ' + keyStatus.ref : '',
            ),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, '置信度阈值'),
            h('input', {
              style: S.input,
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              value: draft.jevConfidence,
              onChange: (event) => setDraft((previous) => ({ ...previous, jevConfidence: event.target.value })),
            }),
            h('span', { style: S.note }, '低于它就在最高的两档里取更强的那档'),
          ),
        ) : null,
        h('div', { style: S.row },
          h('span', { style: S.label }, '模式'),
          h('div', { style: S.seg, role: 'group' },
            [['auto', '自动'], ['manual', '手动']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.mode === id),
              'aria-pressed': draft.mode === id,
              onClick: () => setDraft((previous) => ({ ...previous, mode: id })),
            }, text)),
          ),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, '判定服务'),
          h('input', {
            style: S.input,
            value: draft.judgeUrl,
            placeholder: 'http://127.0.0.1:8765/judge',
            onChange: (event) => setDraft((previous) => ({ ...previous, judgeUrl: event.target.value })),
          }),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, '对话提示'),
          h('div', { style: S.seg, role: 'group' },
            [['', '变化时提示'], ['always', '每轮都提示'], ['off', '不提示']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.notify === id),
              'aria-pressed': draft.notify === id,
              onClick: () => setDraft((previous) => ({ ...previous, notify: id })),
            }, text)),
          ),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, '档位映射'),
          h('div', { style: S.tierRow },
            TIER_KEYS.map((key) => h('label', { key, style: S.tierCell },
              h('span', { style: S.tierLabel }, TIER_LABEL[key]),
              h('select', {
                style: S.select,
                value: draft.tiers[key] === undefined ? 'low' : draft.tiers[key],
                onChange: (event) => {
                  const value = event.target.value
                  setDraft((previous) => ({ ...previous, tiers: { ...previous.tiers, [key]: value } }))
                },
              }, TIER_OPTIONS.map((id) => h('option', { key: id, value: id }, id))),
            )),
          ),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, ''),
          h('span', { style: S.note }, '留默认值时按模型自己的档位自动分布（最低 / 中间 / 最高）；改成非默认值才按这张表走。选了模型不支持的档，会退到最接近的较低档'),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, ''),
          h('span', { style: S.note }, '插件会改写模型选择器里的「推理等级」，那里显示的就是本轮实际使用的档位。'),
        ),
        h('div', { style: S.foot },
          h('button', {
            style: canSave ? S.save : { ...S.save, opacity: 0.5 },
            disabled: busy || !writable || !canSave,
            onClick: () => void save(),
          }, busy ? '保存中…' : '保存'),
          h('button', {
            style: S.save,
            disabled: probing,
            onClick: () => void probe(),
          }, probing ? '测试中…' : '测试'),
          h('span', { style: S.note }, note),
        ),
      )
    }

    /**
     * 芯片该显示什么。参数是 /effort-router/last 的响应。
     *
     * 路由开关关掉时返回 null：那一轮请求完全没被插件碰过，再摆一个档位出来会让人以为
     * 判定还在跑。没有判定记录时给 Default 占位，位置不跳。
     */
    function chipView(body) {
      if (body !== null && typeof body === 'object' && body.enabled === false) return null
      const records = body !== null && typeof body === 'object' && Array.isArray(body.records) ? body.records : []
      const current = body !== null && typeof body === 'object' && body.current !== null && body.current !== undefined
        ? body.current
        : null
      // 本会话没有记录时退到最近一条：多会话串一下比空着好查。
      const row = current !== null ? current : (records.length > 0 ? records[0] : null)
      if (row === null || row === undefined) return { label: 'Default', detail: '暂无判定' }
      // 三种「没有档位」都显示 Default：左段（上一轮）缺失、右段（这一轮）缺失。
      const thisTier = row.tier === undefined || row.tier === null || row.tier === '' ? 'Default' : String(row.tier)
      const previousTier = row.prevTier === undefined || row.prevTier === null || row.prevTier === '' ? 'Default' : String(row.prevTier)
      return {
        label: previousTier + ' → ' + thisTier,
        detail: thisTier + ' → ' + row.effort + '（' + row.provider + '/' + row.model + '）',
      }
    }

    /**
     * 输入框旁的档位芯片：显示这个会话最近一次判定。
     *
     * 轮询而不是订阅：静态 client bundle 拿不到宿主的推送通道，3 秒一次足够，
     * 一次请求只回一条记录。开关关掉或者判定还没发生时什么都不渲染。
     */
    function EffortChip(props) {
      const sessionId = props === undefined || props === null ? undefined : props.sessionId
      const [view, setView] = React.useState(null)

      // 一次性的形状上报：把组件实际收到的 props 键名与 sessionId 传给宿主。
      // 排“拿不到会话”时不用再猜 props 叫什么。
      React.useEffect(() => {
        try {
          const keys = props === undefined || props === null ? [] : Object.keys(props)
          const sid = sessionId === undefined || sessionId === null ? '' : String(sessionId)
          void fetch(`/effort-router/seen?keys=${encodeURIComponent(keys.join(','))}&sid=${encodeURIComponent(sid)}`)
        } catch {
          /* 自检失败不影响功能 */
        }
        // 只在挂载时报一次：props 的键名不进依赖数组，挂载后再变也不重报。
      }, [])

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const query = typeof sessionId === 'string' && sessionId !== ''
              ? '?session=' + encodeURIComponent(sessionId)
              : ''
            const res = await fetch(LAST_ENDPOINT + query)
            const body = await res.json()
            if (!alive) return
            setView(chipView(body))
          } catch {
            /* 拿不到就不显示，别打扰输入 */
          }
        }
        void load()
        const timer = setInterval(load, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      if (view === null) return null
      // 纯文本 + aria-label：读屏能念出完整含义，悬停也能看到强度与模型。
      return h('div', {
        style: S.chipBox,
        role: 'status',
        'aria-label': view.detail,
        title: view.detail,
      }, h('span', null, view.label))
    }

    function apply(ctx) {
      // 自检：bundle 真在浏览器里跑起来了，宿主侧的 /seen 会记下这次访问。
      try {
        void fetch('/effort-router/seen')
      } catch {
        /* 自检失败不影响功能 */
      }
      // 芯片先注册。配置页那个 slot 只在插件页挂载时才存在，别让它挡住芯片。
      try {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'effort-router-chip', order: 5 },
          (slotProps) => h(EffortChip, {
            sessionId: slotProps === undefined || slotProps === null ? undefined : slotProps.sessionId,
          }),
        ))
      } catch (error) {
        console.error('[effort-router] 芯片注册失败', error)
      }
      try {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-effort-router' },
          () => h(ConfigPanel),
        ))
      } catch (error) {
        console.error('[effort-router] 配置页注册失败', error)
      }
      // 设置界面左侧导航里的独立一节。插件详情页那块也留着，两处读同一份配置。
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'effort-router', order: 25, label: '思考强度' },
          () => h(ConfigPanel),
        ))
      } catch (error) {
        console.error('[effort-router] 设置节注册失败', error)
      }
    }

    exports.name = 'effort-router-client'
    exports.inject = ['slots']
    // 芯片的显示规则是纯函数，测试直接调它，不用起 DOM。
    exports.chipView = chipView
    // 档位词汇在这里是第二份（宿主侧那份在 config/settings.mjs），测试比对两边是否仍然一致。
    exports.TIER_KEYS = TIER_KEYS
    exports.DEFAULT_TIERS = DEFAULT_TIERS
    exports.EFFORTS = EFFORTS
    exports.apply = apply
    return module.exports
  },
})
