# dsh-effort-router

按一句话的难度，调当前模型的思考强度。

A DeepSeek Harness plugin that picks `reasoningEffort` per turn from a local difficulty judge, leaving
provider and model as you selected them.

## 它做什么

每轮你把话发出去，插件把这句任务描述送到本机判定服务，拿回一个档位：`low`、`high`、`max`。
档位换成强度名，再在目标模型支持的强度里挑一个不高于目标、尽量强的那个，写进请求的
`reasoningEffort`。

provider 和 model 用模型选择器里的那个。换厂商、加新 provider，这个插件不用改。

判定服务没起来，或者目标模型没有强度可选（`resolveModelInfo` 里没有 `reasoning.efforts`），
请求原样发出。

判定结果出现在输入框右侧的芯片上，固定两段：上一轮的档位 → 这一轮的档位。档位没变也写成
`high → high`，一眼能看出这轮判定跟上一轮一样；跨档就是 `low → high`。还没有上一轮时
（首轮，或旧版记录里没有这个字段）左段写 `Default`，与模型选择器里的叫法一致。
悬停或读屏能看到「当前档 → 强度（provider/model）」。还没判定过时芯片显示 `Default → Default`，
不再时隐时现。芯片读的是插件自己的 `/effort-router/last`，每 3 秒问一次，不往对话里插消息。

最近一次判定会落盘到 `~/.dsh/router-effort/last.json`（与部署目录同一个根，最多留 100 条），
所以重启 DSH 之后芯片直接就有内容，不用等下一轮判定。落盘是「先写临时文件再改名」，
进程被杀也不会留下半个 JSON；写之前会看一眼文件的修改时间，中途被别的进程写过就重读合并一次。

芯片优先按会话取：前端把 `sessionId` 传上来，宿主侧两边都去掉 `session-` 前缀再比，
所以带前缀和不带前缀都能对上。本会话还没有记录时退到最近一条，保证芯片一直可见。

芯片里显示的模型名取自会话的模型选择状态（`sessionProjections.stateOf(session, 'modelSelection')`，
`pending ?? lastUsed`），所以这一轮刚换过模型也能显示对。

## 安装

两种方式。要它出现在 GUI 的“已安装插件”列表里，用方式 A；只想让它跑起来，方式 B 就够。

### 方式 A：登记成 bundle

1. 把包放到 profile 能按名字找到的位置。放到 `plugins/effort-router` 再建目录链接即可：

```
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-effort-router" "%USERPROFILE%\.dsh\profiles\desktop\plugins\effort-router"
```

2. 改 profile 的 `package.json`（`%USERPROFILE%\.dsh\profiles\desktop\package.json`），两处都要加：

```json
{
  "dependencies": {
    "dsh-effort-router": "link:./plugins/effort-router"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-effort-router"]
    }
  }
}
```

列表里“已安装”看的是 `dependencies` 里有没有这个名字，“启用”看的是 `dsh.profile.bundles` 里有没有。
包目录由 Node 的解析规则从 profile 目录找，目录链接就够，不用跑 pnpm。

行里显示的标题和描述来自 `locale/*.json` 的 `meta.title` / `meta.description`，按界面语言取，
没有对应语言时用英文。这两个文件在 `exports` 里必须导出，否则解析不到。

3. 重启 DSH。启动时加载自己带的 `cordis.patch.yml`，把默认配置行插进树里。

`pnpm install` 看到这条 `link:` 依赖会自己补链接，但本机 pnpm 10 与这个 profile 的 pnpm 11 布局不兼容，
会要求清空 `node_modules` 重装。真被删掉链接时跑一次 `repair-link.cmd`。

### 方式 B：只写 patch 行

1. 把本目录复制到 `%USERPROFILE%\.dsh\profiles\desktop\plugins\effort-router`。
2. 建目录链接，命令同方式 A 第 1 步。
3. 在 profile 的 `cordis.patch.yml` 末尾加一行。新 id 必须包在 `insert:` 里，裸的 `- id:` 只能改已存在的行：

```yaml
- insert:
    - id: effort-router
      name: dsh-effort-router
      config:
        mode: auto
        judgeUrl: http://127.0.0.1:8765/judge
        tiers:
          low: low
          high: high
          max: max
          fallback: low
```

4. 重启 DSH。挂载痕迹写在 `%TEMP%\router-effort.log`，第一行是 `mounted mode=...`。

两种方式可以同时存在，不会挂两次：bundle 层先应用插件自带的 patch，profile 层后应用，同 id 的条目
最后由 `cordis-plugin-loader` 折叠成一条，生效的是后出现的那份 config。机器相关的路径（`servicePython`
之类）写在 profile 那行里，就能在方式 A 下继续生效。

## 从 dsh-router-effort 迁移

包名改成 `dsh-effort-router` 之后，profile 里四处要跟着改：

1. `dependencies` 的键换成新名，`link:` 的值指向包目录
2. `dsh.profile.bundles` 里那条换成新名，否则启动时按旧名解析不到包
3. `node_modules` 下那个目录链接改名
4. profile `cordis.patch.yml` 里那行的 `id` 改成 `effort-router`、`name` 改成 `dsh-effort-router`。只改 `name` 不动 `id`，包自带的 patch 会再插一条，同一个插件挂两遍

三处名字按旧样保留：`~/.dsh/router-effort`（venv 和权重的落地目录，约 1.5 GB）、`%TEMP%\router-effort*.log`、HTTP 路由 `/router-effort/*`（作为新路径的别名）。

## 给其他人装

对方不用建链接、改 patch。DSH 的安装入口内部调 pnpm，装完会把声明了 `dsh.bundle` 的新依赖加进
`dsh.profile.bundles`，等于装完即启用。

Desktop 用户走 GUI：设置里的插件管理，安装框填 spec。这几种写法都行：

```
github:Hakutaku-02/dsh-effort-router          # GitHub 仓库，默认分支
github:Hakutaku-02/dsh-effort-router#Jev      # 指定分支
dsh-effort-router                             # npm 注册表，尚未发布，现在填它装不上
D:\path\to\dsh-effort-router                  # 本地目录，绝对路径
```

命令行用户（web、tui、headless 这些 profile）：

```bash
dsh plugin --profile web install github:Hakutaku-02/dsh-effort-router
```

`install` 与 `add` 等价，剩下的参数原样交给 pnpm。`--profile` 是必填项。`desktop` 这个 profile 由 Electron 应用独占，CLI 会直接拒绝，Desktop 用户只能用 GUI。

装完重启 DSH。安装前有兼容预检：对方 DSH 运行时版本不满足 `engines.dsh` 时直接拒绝，什么都不装。

直接在 profile 目录里 `pnpm add <spec>` 也能落文件，但不会触发激活，列表里显示“已安装、未启用”；
要自己把名字写进 `dsh.profile.bundles`，或者再用 GUI/CLI 走一次安装。

对方不用自己装判定服务：插件把 `dsh-router-laya` 声明成依赖（服务源码、依赖锁、权重清单都在里面），
首次启动发现服务不在线就会自动部署，见下一节。

## 判定服务怎么来

判定服务是个 Python 进程，权重是一个 846 MB 的 fine-tune 检查点。安装插件时不会顺带装它：
pnpm 10 起默认不执行依赖的 postinstall，写在 `postinstall` 里也没人跑。所以部署放在宿主首次启动时做。

启动顺序：

1. `GET <judgeUrl 的 /health>` 说 `protocol: "finetuned"`，直接用，什么都不做。启动时最多等
   `startupWaitMs`（默认 3 秒），服务本来就在线时第一次探活就返回。
2. 配了 `servicePython` 与 `serviceScript`，按这两个路径把服务拉起来，然后最多等 `startWaitMs`
   （默认 90 秒）。冷启动要加载权重约 70 秒，拉起之后必须等，探一次就判死会把状态永久卡在
   `failed`。
3. 都不行就部署：跑 `dsh-router-laya` 包自带的 `bin/setup.mjs`。它建 venv、pip 装 pinned 依赖
   （CPU 版 torch）、下载权重、拉起服务并等 `/health`。幂等，已装过的部分会跳过。跑完最多等
   `provisionWaitMs`（默认 5 秒）。

第 3 步在后台跑，宿主的启动和请求都不等它，装好之前那几轮按“判定失败”处理，不改强度。
全过程输出写在 `%TEMP%\router-effort-setup.log`（Linux 是 `/tmp`）。

状态会跟着真实可用性走：任意一次判定成功都会把 `state` 刷成 `up`。启动时探活失败但服务后来
起来了，状态会自己回来，不必重启。

部署前会先把 `dsh-router-laya` 包复制到 `~/.dsh/router-effort/laya`。venv 和权重会写在被复制的那份里，
插件升级或 pnpm 重装换掉 node_modules 时，这 1.5 GB 不会被一起清掉；包版本变了才重新复制。
想彻底卸载服务就删掉 `~/.dsh/router-effort`。

前置条件：Python 3.10 到 3.13，磁盘约 1.5 GB，能访问 PyPI 与 HuggingFace（`HF_ENDPOINT` 可以换镜像）。
冷启动加载模型约 70 秒。

不想让它自动下载就把 `provision` 设成 `false`。想提前装好可以在 profile 里手动跑：

```bash
node node_modules/dsh-router-laya/bin/setup.mjs
```

看当前状态：

```bash
curl http://127.0.0.1:<GUI 端口>/effort-router/judge
# {"state":"up"|"provisioning"|"failed"|"missing"|"down","detail":"...","judgeUrl":"...","setupLog":"..."}
```

## 设置界面

两个入口，读同一份配置，改哪边都一样：

- 设置 → **思考强度**（左侧导航里独立的一节，`settings.section`，order 25）
- 插件 → 已安装 → 难度路由 → 详情页里的配置区

页面上能改：

| 区块 | 内容 |
| --- | --- |
| 路由开关 | 开启 / 关闭。关掉后完全不改请求，等同手动模式 |
| 判定方式 | 本地服务 / Jev。选 Jev 时展开下面四项 |
| Jev 配置 | 地址、模型名、API Key、置信度阈值；Key 存进凭据库，面板只显示「已配置 / 未配置」 |
| 模式 | 自动 / 手动（与总开关叠加：任一为关就不改请求） |
| 判定服务 | 本地判定服务的地址 |
| 对话提示 | 变化时提示 / 每轮都提示 / 不提示 |
| 档位映射 | 简单 / 中等 / 困难 / 兜底 四个下拉 |

页面行为：

- 「保存」没有改动时是禁用的（灰掉），改动后才可点。提示文字 3 秒后自动消失。
- 判定地址、Jev 地址、模型名都是必填：清空后点保存只给提示，不发请求，不会被宿主回写悄悄还原。
- 置信度阈值留空或超出 0 到 1 也不保存，避免空值被当成 0 静默生效。
- Key 输入框不回显已有值：留空表示不改，填了就写进 `~/.dsh/.credentials.yaml` 的 `TOKENFLUX_JEV_KEY`。
  旧配置若还指着 `TOKENFLUX_API_KEY`（TokenFlux provider 共用的那个），写入时自动转到专用名并改配置，不会顶掉模型通道的 key。
- 「打开凭据文件」用系统默认程序打开 `.credentials.yaml`。DSH 顶栏自带的「打开配置文件」打开的是 profile 补丁，属于宿主，本插件不改它。
- 「测试」按**表单里当前的**后端与模型名发一次最小请求，凭据用已保存的那条；改过地址要先保存再测。
- 四组切换按钮都带 `role="group"` 与 `aria-pressed`，读屏与脚本能判断当前选中项。
- 档位下拉只列真实的思考档（不含 `off`：`off` 在这套实现里不会关掉思考，只会落到最低档）。
  老配置里若存了 `off`，载入时归一化成默认值。选了当前模型不支持的档，会退到最接近的较低档。

保存写回 profile 的 `cordis.patch.yml`。`enabled`、`mode`、`judgeSource`、`judgeUrl`、`notify`、`tiers`、
`jevUrl`、`jevModel`、`jevApiKeyEnv`、`jevConfidence` 都标了 volatile，改完即时生效；其余字段下次重启生效。

页面不直接读写 profile：它调插件自己的 `/effort-router/config`，由宿主半边转成 `settings.update`。
宿主没有设置面时页面只读，保存退化成只改内存里的模式。

## 换模型与加模型

档位不写死在插件里。每轮请求前按当前模型调 `llm.resolveModelInfo` 拿它自己声明的强度列表，
然后**按位置**把判定的三档落到这份列表上：`low` 取最低档，`high` 取中间档，`max` 取最高档。

这样每个模型都能用满自己的范围，不用手工配：

| 模型 | 声明的档位 | 判定 low | 判定 high | 判定 max |
|---|---|---|---|---|
| deepseek-v4.1-flash | low / high / max | low | high | max |
| minimax-m3.1-flash | low / medium / high / xhigh / max | low | high | max |
| gemini（三档） | low / medium / high | low | **medium** | **high** |

按名字硬套是上一版的写法，会把「没有 max 的模型」的 max 压到 high、让「有 xhigh 的模型」
永远用不到 medium 与 xhigh。想手工精调仍可以改 `tiers`，只要它与默认值不同就按那张表走。

解析结果按 `modelInfoTtlMs`（默认 60 秒）缓存；解析不到档位时不写缓存，`llm/adapters-updated`
事件会整体清掉缓存，所以改完模型定义下一轮就生效。

想确认某个模型现在解析到哪些档位、以及某个判定档会落到哪一档：

```bash
curl "http://127.0.0.1:<GUI 端口>/effort-router/models?provider=<provider>&model=<model>"
# {"efforts":["low","medium","high"],"ttlMs":60000}

curl "http://127.0.0.1:<GUI 端口>/effort-router/models?provider=<provider>&model=<model>&tier=max"
# {"efforts":["low","medium","high"],"tier":"max","picked":"high","ttlMs":60000}
```

## 判定方式：本地服务或 Jev

`judgeSource` 二选一。设为 `local` 走上一节的本地 Python 服务；设为 `jev` 走 TypeSafe 的 Jev 决策模型。

Jev 不是对话模型，它走 System One 决策协议，`POST {model, state, questions}` 换回
`{answers:{effort:{choice, confidence, probabilities}}}`，没有文本、没有推理链。所以它接不进
DSH 的 provider 通道（那里只有 chat 协议），插件直接对 `jevUrl` 发请求，凭据按 `jevApiKeyEnv`
解析：进程环境优先，其次宿主凭据服务。

超时 12 秒（`jevTimeoutMs`），失败一律不改强度。置信度低于 `jevConfidence`（默认 0.6）时，在概率最高的两档里取
更强的那个：宁可高估，不低估。

```bash
# 切到 Jev
curl -X POST http://127.0.0.1:<GUI 端口>/effort-router/config \
  -H "Content-Type: application/json" \
  -d "{\"judgeSource\":\"jev\"}"
```

`tokenflux.dev` 上的实测结果：`GET /v1/models` 给出 `jev-latest` 与 `jev-preview`；`POST
/v1/chat/completions` 会被拒绝（`protocol_not_allowed`），`POST /v1/systemone` 正常返回决策。
默认配置就是对准这个端点。

## 配置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时完全不改请求 |
| `mode` | `auto` | `manual` 时完全不改请求；与 `enabled` 叠加 |
| `judgeUrl` | `http://127.0.0.1:8765/judge` | 判定服务地址，也可以用环境变量 `LAYA_ROUTER_URL` |
| `tiers` | `low/high/max` 同名，`fallback: low` | 档位到强度名的映射；标了 volatile，改完即时生效 |
| `notify` | 空 | `always` 每轮都写提示，`off` 不写 |
| `autoStart` | `true` | 发现判定服务不在线时，按 `servicePython` / `serviceScript` 拉起 |
| `servicePython` | 空 | 判定服务的 python 路径 |
| `serviceScript` | 空 | 判定服务的入口脚本 |
| `provision` | `true` | 服务起不来时跑 `dsh-router-laya` 的 `bin/setup.mjs` 部署一遍 |
| `layaDir` | 空 | `dsh-router-laya` 包的位置，默认按依赖解析 |
| `judgeSource` | `local` | 判定后端。`local` 走本机服务；`jev` 走 Jev 决策模型 |
| `jevUrl` | `https://tokenflux.dev/v1/systemone` | Jev 的决策端点，只接受 http(s) |
| `jevModel` | `jev-latest` | Jev 的模型名 |
| `jevApiKeyEnv` | `TOKENFLUX_API_KEY` | 凭据引用名，面板写入 Key 时落到这里；先查进程环境再查宿主凭据服务 |
| `jevConfidence` | `0.6` | 置信度阈值，低于它在最高的两档里取更强的 |
| `jevTimeoutMs` | `12000` | Jev 请求超时 |
| `startupWaitMs` | `3000` | 启动时等判定服务就绪的上限 |
| `startWaitMs` | `90000` | 按 `servicePython` / `serviceScript` 拉起后等就绪的上限，覆盖约 70 秒冷启动 |
| `provisionWaitMs` | `5000` | 部署脚本跑完后等就绪的上限 |
| `modelInfoTtlMs` | `60000` | 模型档位的缓存寿命。解析不到档位时不缓存，`llm/adapters-updated` 也会清空 |

`servicePython` 和 `serviceScript` 都填了、文件也在，插件才会走“按路径拉起”那条路。拉起失败只写日志，
接着走部署。部署也失败就保持不改强度，请求照常发。

## 运行时开关

这两条都写回 profile，重启后仍然生效。

```bash
curl http://127.0.0.1:<GUI 端口>/effort-router/config
curl -X POST http://127.0.0.1:<GUI 端口>/effort-router/config -H "Content-Type: application/json" -d "{\"mode\":\"manual\",\"notify\":\"always\"}"
curl -X POST http://127.0.0.1:<GUI 端口>/effort-router/mode -H "Content-Type: application/json" -d "{\"mode\":\"auto\"}"
```

`mode` 路由只切模式；`config` 路由可以一起改 `mode`、`judgeUrl`、`notify`、`tiers`。两个都回 `persisted`，
`false` 表示宿主没有设置面，改动只留在内存里。

`models` 路由是只读诊断，见上一节。`last` 路由是芯片的数据源，只读，返回每个会话最近一次判定：

```bash
curl "http://127.0.0.1:<GUI 端口>/effort-router/last"
curl "http://127.0.0.1:<GUI 端口>/effort-router/last?session=<会话 id>"
```

`key` 路由给面板里的 Key 输入框用：`GET` 只报状态（`{ref, configured, source, writable}`），`POST {key}` 写进宿主凭据库，值不回传。

```bash
curl http://127.0.0.1:<GUI 端口>/effort-router/key
curl -X POST http://127.0.0.1:<GUI 端口>/effort-router/key -H "Content-Type: application/json" -d "{\"key\":\"sk-...\"}"
```

`open-credentials` 路由不接受参数，只打开 `DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）。

`probe` 路由是设置页「测试」按钮的后端，真发一次最小请求，返回 `{ok, backend, detail, ms}`：

```bash
curl -X POST http://127.0.0.1:<GUI 端口>/effort-router/probe -H "Content-Type: application/json" -d "{}"
```

只接受切换后端与模型名（`judgeSource`、`jevModel`）；地址一律用已保存的值。请求里带了与已保存不同的
`judgeUrl` / `jevUrl` 时直接回「先保存再测试」，不发请求——否则任何页面都能借这个接口把 Bearer 凭据
发到它自己指定的地址。

改代码要重启 DSH 才生效。

## 测试

```bash
npm test
```

这个包没有运行时依赖，克隆下来直接跑，不用 install（`@deepseek-ai/schemastery` 是 profile 提供的 peer）。

- `test/effort.test.mjs`：跨厂商强度映射。deepseek 只有 low/high/max，minimax 多 medium/xhigh，qwen 没有 max。
- `test/apply.test.mjs`：假 ctx 跑通请求钩子、提示插入、判定失败降级、每轮只问一次判定服务。
- `test/mirror.test.mjs`：判定服务包的镜像目录。版本没变不重复复制，变了才覆盖。
- `test/provision.test.mjs`：首次部署的子进程、参数与失败路径。
- `test/health.test.mjs`：拉起后等就绪、状态跟着真实可用性走。
- `test/config.test.mjs`：配置接口读写、manual/auto 热生效、档位映射与非法值拒绝。
- `test/cache.test.mjs`：新模型动态读取档位、缓存寿命、`llm/adapters-updated` 清缓存、芯片数据源。

真 cordis 上下文里的挂载与事件瀑布另有一个测试：

```bash
npm run test:cordis
DSH_ROOT=<DSH 安装目录> npm run test:cordis   # 装在别处时指定
```

它验证服务注册、`agent/request` 的返回值、`agent/pre-step` 插入的提示内容。找不到 DSH 时打印一行
跳过说明，退出码 0，所以不影响 CI。

## 强度怎么落到请求上

判定出的强度不是靠改 `agent/request` 的返回值生效的。`dsh-agent` 的 model-selection 监听会在
`agent/request` 上无条件剥掉继承来的 `reasoningEffort`：用户没在模型选择器里选档位时清空它，
选了就用那个固定值。所以单靠 hook 返回值，请求里连 `thinking` 参数都不会出现。

插件改走会话的模型选择：在 `agent/pre-step`（早于 prompt assemble）调
`sessionController.selectForNextRequest(agent, {provider, model, reasoningEffort})`，
assemble 时把这个值快照进去，请求就带着它发出去。实测抓包：

```
判定 low  → {"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}
判定 high → {"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}
```

副作用是模型选择器里的「推理等级」会跟着判定跳。这是预期行为：那份选择就是请求的来源。
`agent/request` 里仍保留一层改写，供没有 model-selection 的运行时兜底。

## 已知限制

- 判定服务的协议是写死的：`POST judgeUrl {"task": "..."}` 返回 `{"tier": "..."}`，`GET /health` 返回
  `{"protocol": "finetuned"}`。换别的判定服务要改代码。
- 强度排序靠名字：`off` < `minimal` < `low` < `medium` < `high` < `xhigh` < `max`。厂商出现新词时，
  要加进 `ORDER`，否则那个强度会被当成未知并跳过。
- 一轮只判一次，判的是这一轮第一条用户消息。中途追加的长任务不会重新判。
- 写会话选择依赖 `sessionController.selectForNextRequest`。运行时没有这个服务时退回只改内存，
  此时请求不会带强度（芯片仍会显示判定结果，两者会不一致）。
- 子代理不处理：`session.header.origin === 'subagent'` 时直接放行，强度跟主代理走。
- 芯片跨档提示只在档位真的变化后出现一次；同一轮内的重复调用不会把它抹掉。
- 芯片拿不到本会话的记录时退化成显示最近一条。实测 0.2.1-rc.2 会传 `sessionId`，
  多会话同时开着又都没有记录时，可能短暂显示成别的会话的档位。
- client 半边改了要刷新窗口（`Ctrl+R`）才看得到。Electron 会按 bundle 的内容版本缓存，宿主侧改动不受影响。
- 只在 Windows 上验证过。路径拼接和 pythonw 查找是 Windows 习惯，别的平台没测。

## 发布

仓库地址已写在 `package.json` 的 `repository` / `bugs` / `homepage` 里。发版走两步：

```bash
npm test
npm version patch && git push --follow-tags
npm publish
```

`package-lock.json` 不进仓库（里面记着本机 DSH 安装路径），发版前重新生成即可。

## 许可证

MIT，见 [LICENSE](LICENSE)。
