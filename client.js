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

    /** 判定服务给的档位，以及每个档位能映射到的强度名（宿主侧的粗序）。 */
    const TIER_KEYS = ['low', 'high', 'max', 'fallback']
    const TIER_LABEL = { low: '简单', high: '中等', max: '困难', fallback: '兜底' }
    const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

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
      foot: { display: 'flex', alignItems: 'center', gap: 10 },
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

    function ConfigPanel() {
      const [cfg, setCfg] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(ENDPOINT)
          const body = await res.json()
          setCfg(body)
          setDraft({
            enabled: body.enabled !== false,
            mode: body.mode === 'manual' ? 'manual' : 'auto',
            judgeSource: body.judgeSource === 'jev' ? 'jev' : 'local',
            judgeUrl: typeof body.judgeUrl === 'string' ? body.judgeUrl : '',
            notify: body.notify === 'always' ? 'always' : 'off',
            tiers: { low: 'low', high: 'high', max: 'max', fallback: 'low', ...(body.tiers || {}) },
            jevUrl: typeof body.jevUrl === 'string' ? body.jevUrl : '',
            jevModel: typeof body.jevModel === 'string' ? body.jevModel : '',
            jevApiKeyEnv: typeof body.jevApiKeyEnv === 'string' ? body.jevApiKeyEnv : '',
            jevConfidence: Number.isFinite(Number(body.jevConfidence)) ? Number(body.jevConfidence) : 0.6,
          })
        } catch (error) {
          setNote('读取失败：' + (error && error.message ? error.message : error))
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      if (draft === null) return h('div', { style: S.note }, '读取中…')

      const writable = cfg !== null && cfg.writable === true

      const save = async () => {
        setBusy(true)
        setNote('')
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
              jevUrl: draft.jevUrl,
              jevModel: draft.jevModel,
              jevApiKeyEnv: draft.jevApiKeyEnv,
              jevConfidence: draft.jevConfidence,
            }),
          })
          const body = await res.json()
          if (body.ok === true) {
            setNote(body.persisted === true ? '已保存' : '已保存到内存（设置服务不可用）')
            if (body.config) {
              setCfg(body.config)
              setDraft((previous) => ({ ...previous, mode: body.config.mode === 'manual' ? 'manual' : 'auto' }))
            }
          } else {
            setNote(body.detail || '保存失败')
          }
        } catch (error) {
          setNote('保存失败：' + (error && error.message ? error.message : error))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: S.label }, '路由开关'),
          h('div', { style: S.seg },
            [[true, '开启'], [false, '关闭']].map(([value, text]) => h('button', {
              key: String(value),
              style: S.chip(draft.enabled === value),
              onClick: () => setDraft((previous) => ({ ...previous, enabled: value })),
            }, text)),
          ),
          h('span', { style: S.note }, draft.enabled ? '' : '关掉后完全不改请求'),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, '判定方式'),
          h('div', { style: S.seg },
            [['local', '本地服务'], ['jev', 'Jev']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.judgeSource === id),
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
              placeholder: 'https://tokenflux.dev/v1/systemone',
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
            h('span', { style: S.label }, '凭据名'),
            h('input', {
              style: S.input,
              value: draft.jevApiKeyEnv,
              placeholder: 'TOKENFLUX_API_KEY',
              onChange: (event) => setDraft((previous) => ({ ...previous, jevApiKeyEnv: event.target.value })),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: S.label }, '置信度阈值'),
            h('input', {
              style: S.input,
              type: 'number',
              min: 0,
              max: 1,
              step: 0.05,
              value: String(draft.jevConfidence),
              onChange: (event) => setDraft((previous) => ({ ...previous, jevConfidence: Number(event.target.value) })),
            }),
            h('span', { style: S.note }, '低于它就在最高的两档里取更强的那档'),
          ),
        ) : null,
        h('div', { style: S.row },
          h('span', { style: S.label }, '模式'),
          h('div', { style: S.seg },
            [['auto', '自动'], ['manual', '手动']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.mode === id),
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
          h('div', { style: S.seg },
            [['off', '不提示'], ['always', '每轮都提示']].map(([id, text]) => h('button', {
              key: id,
              style: S.chip(draft.notify === id),
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
              }, EFFORTS.map((id) => h('option', { key: id, value: id }, id))),
            )),
          ),
        ),
        h('div', { style: S.row },
          h('span', { style: S.label }, ''),
          h('span', { style: S.note }, '留默认值时按模型自己的档位自动分布（最低 / 中间 / 最高）；改成非默认值才按这张表走'),
        ),
        h('div', { style: S.foot },
          h('button', {
            style: S.save,
            disabled: busy || !writable,
            onClick: () => void save(),
          }, busy ? '保存中…' : '保存'),
          h('span', { style: S.note }, note),
        ),
      )
    }

    /**
     * 输入框旁的档位芯片：显示这个会话最近一次判定。
     *
     * 轮询而不是订阅：静态 client bundle 拿不到宿主的推送通道，3 秒一次足够，
     * 一次请求只回一条记录。判定还没发生时不渲染任何东西。
     */
    function EffortChip(props) {
      const sessionId = props === undefined || props === null ? undefined : props.sessionId
      const [row, setRow] = React.useState(null)

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
        // 只在挂载时报一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            const records = Array.isArray(body.records) ? body.records : []
            const current = body.current !== null && body.current !== undefined ? body.current : null
            // 本会话没有记录时退到最近一条：芯片要一直可见，多会话串一下比空着好查。
            setRow(current !== null ? current : (records.length > 0 ? records[0] : null))
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

      // 三种「没有档位」都显示 Default：
      // 一条记录都没有、左段（上一轮）缺失、右段（这一轮）缺失。
      if (row === null || row === undefined) {
        return h('div', {
          style: S.chipBox,
          role: 'status',
          'aria-label': '暂无判定',
          title: '暂无判定',
        }, h('span', null, 'Default'))
      }
      const current = row.tier === undefined || row.tier === null || row.tier === '' ? 'Default' : String(row.tier)
      const previous = row.prevTier === undefined || row.prevTier === null || row.prevTier === '' ? 'Default' : String(row.prevTier)
      const label = `${previous} → ${current}`
      const detail = `${current} → ${row.effort}（${row.provider}/${row.model}）`
      // 纯文本 + aria-label：读屏能念出完整含义，悬停也能看到强度与模型。
      return h('div', {
        style: S.chipBox,
        role: 'status',
        'aria-label': detail,
        title: detail,
      }, h('span', null, label))
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
    exports.apply = apply
    return module.exports
  },
})
