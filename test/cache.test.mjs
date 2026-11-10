/**
 * 档位的动态读取：新加的 provider / model 第一次被选中时就要按它自己的档位工作。
 *
 * 0.2.2 的写入口只剩 agent.model.select()，而且必须在 model.current() 快照之前写，
 * 所以插件把判定扣在 agent/inbox/inserted 的 runMaintenance 里。这里每一轮就是
 * 「插一条用户消息 → 等 hold 跑完 → 看会话选择被写成了什么」。
 *
 * 盯的还是档位缓存那三条规则：命中要有寿命、解析失败不缓存、provider 拓扑变化立刻作废。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { makeAgent, makeChecker, makeContext } from './fake-host.mjs'

// 挂载痕迹写到测试自己的文件，宿主那份只留真实重启的记录。
process.env.ROUTER_EFFORT_LOG = `${tmpdir()}/router-effort-test.log`
process.env.ROUTER_EFFORT_HOME = mkdtempSync(join(tmpdir(), 'effort-router-home-'))
process.env.ROUTER_EFFORT_STARTUP_WAIT_MS = '0'

const { check, done } = makeChecker()

// 判定服务固定回 high：档位不是这组测试的变量，缓存才是。
const judge = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url === '/health' ? { protocol: 'finetuned' } : { tier: 'high' }))
})
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const judgeUrl = `http://127.0.0.1:${judge.address().port}/judge`

const FULL = [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }]

/**
 * 挂载插件。
 *
 * list 是模型当下声明的档位，null 表示解析不到（模型或适配器还没注册完）。
 * 返回的 llm.list 可以中途改，模拟用户跑去 Models 页改档位。
 */
function fresh(list = FULL, config = {}) {
  const llm = { list }
  const ctx = makeContext({ efforts: () => llm.list })
  apply(ctx, { mode: 'auto', autoStart: false, provision: false, judgeUrl, ...config })
  return { ctx, llm }
}

/** 跑一轮：插一条用户消息，等 hold 判定写完会话选择。返回这一轮的强度。 */
async function turn(ctx, agent, id) {
  ctx.emit('agent/inbox/inserted', {
    agent,
    message: { id, role: 'user', content: [{ type: 'text', text: '改这段代码' }], source: { kind: 'user' } },
  })
  await agent.settled
  return agent.model.current()?.reasoningEffort
}

/** 调一条已注册的路由；url 可以带查询串。 */
function ask(ctx, path, url = path) {
  return new Promise((resolve) => {
    const handler = ctx.routes.get(path)
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        resolve({ code: res.statusCode, body: text === undefined || text === '' ? undefined : JSON.parse(text) })
      },
    }
    handler({ method: 'GET', url, headers: {}, on() {}, destroy() {} }, res)
  })
}

// 新模型第一次出现：读到它自己的档位并按它落位
{
  const { ctx } = fresh()
  const agent = makeAgent({ id: 'session-new', provider: 'fresh-provider', model: 'fresh-model' })
  const effort = await turn(ctx, agent, 'm1')
  check('新模型: 解析的是它自己', `${ctx.infoCalls[0]?.provider}/${ctx.infoCalls[0]?.model}`, 'fresh-provider/fresh-model')
  check('新模型: 判定 high 落到 high', effort, 'high')
  check('新模型: 解析一次', ctx.infoCalls.length, 1)
}

// 缓存命中：同一模型第二轮不再解析，也不重复写同值
{
  const { ctx } = fresh()
  const agent = makeAgent({ id: 'session-hit' })
  await turn(ctx, agent, 'm1')
  await turn(ctx, agent, 'm2')
  check('缓存: 只解析一次', ctx.infoCalls.length, 1)
  check('缓存: 同值不重复写', agent.selections.length, 1)
}

// 解析不到档位：不缓存，下一轮重试；模型后来注册好了立刻用上
{
  const { ctx, llm } = fresh(null)
  const agent = makeAgent({ id: 'session-empty', reasoningEffort: 'low' })
  await turn(ctx, agent, 'm1')
  check('无档位: 不写会话选择', agent.selections.length, 0)
  await turn(ctx, agent, 'm2')
  check('无档位: 没被缓存住', ctx.infoCalls.length, 2)

  // 模型后来注册好了，下一轮就能用上
  llm.list = [{ id: 'low' }, { id: 'high' }]
  check('无档位: 恢复后能用', await turn(ctx, agent, 'm3'), 'high')
}

// provider 拓扑变化清缓存：用户在 Models 页改了档位，下一轮读新的
{
  const { ctx, llm } = fresh()
  const agent = makeAgent({ id: 'session-refresh' })
  await turn(ctx, agent, 'm1')
  check('刷新: 首次解析', ctx.infoCalls.length, 1)

  llm.list = [{ id: 'low' }, { id: 'medium' }]
  ctx.emit('llm/adapters-updated')
  const effort = await turn(ctx, agent, 'm2')
  check('刷新: 事件后重新解析', ctx.infoCalls.length, 2)
  // 判定 high → 目标 high，新列表最高只有 medium，落到 medium
  check('刷新: 用上新档位', effort, 'medium')
}

// 缓存寿命：过期后重新解析
{
  const { ctx } = fresh(FULL, { modelInfoTtlMs: 20 })
  const agent = makeAgent({ id: 'session-ttl' })
  await turn(ctx, agent, 'm1')
  check('寿命: 首次解析', ctx.infoCalls.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await turn(ctx, agent, 'm2')
  check('寿命: 过期后重新解析', ctx.infoCalls.length, 2)
}

// 诊断接口：问出某个 model 现在解析到的档位
{
  const { ctx } = fresh()
  const ok = await ask(ctx, '/effort-router/models', '/effort-router/models?provider=fresh&model=thing')
  check('诊断: 返回档位', ok.body.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  check('诊断: 回显路由', `${ok.body.provider}/${ok.body.model}`, 'fresh/thing')

  const bad = await ask(ctx, '/effort-router/models', '/effort-router/models?provider=fresh')
  check('诊断: 缺参数回 400', bad.code, 400)
}

// 芯片的数据源：每个会话最近一次判定
{
  const { ctx } = fresh()
  await turn(ctx, makeAgent({ id: 'session-chip' }), 'm1')
  // 这个文件里先跑的用例已经往同一个 ROUTER_EFFORT_HOME 写过落盘文件，
  // 所以这里断言「能取到本会话」，不再断言表是空的。
  const after = await ask(ctx, '/effort-router/last', '/effort-router/last?session=session-chip')
  check('芯片: 有本会话记录', after.body.current?.session, 'session-chip')
  check('芯片: 记的是判定档位', after.body.current?.tier, 'high')
  check('芯片: 记的是写入强度', after.body.current?.effort, 'high')
  check('芯片: 记了模型', `${after.body.current?.provider}/${after.body.current?.model}`, 'p/m')
}

judge.closeAllConnections?.()
judge.close()
await new Promise((resolve) => setTimeout(resolve, 200))
done()
