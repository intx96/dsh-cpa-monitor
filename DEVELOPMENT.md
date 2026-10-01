# 开发文档

本文档面向本仓库的维护者，内容涵盖架构、接口契约、内部约束、测试与发布流程。使用说明见 [README.md](./README.md)。

## 架构总览

插件由两个半边组成，分别运行在两个进程/环境中：

| 半边 | 文件 | 运行环境 | 职责 |
|---|---|---|---|
| 服务端 | `lib/index.js` | Cordis（`dsh web` / 桌面 App 主进程） | 按周期访问 CPA 管理口，聚合账号状态，注册 loopback 精确路由与设置命名空间 |
| 客户端 | `lib/client.js` | 浏览器（shell 的模块加载器） | 注册状态徽标与详情面板，注册两代宿主的配置面 |

客户端半边是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，没有构建步骤，由宿主按请求从磁盘读取。服务端半边是标准的 Cordis 插件：导出 `name`、`apply(ctx, config, deps)` 与 `Config`。

额度解析逻辑移植自一个参考的 Python 采集脚本（窗口识别、`primary=5h` / `second=7d|30d` 判定、`94%/80%-08/26 14:30` 汇总格式），并做了三点加强：

1. **账号自动发现**：不硬编码 `auth_index` / `account_id`，改为读取凭据列表接口，账号增删无需修改配置。
2. **附带 CPA 健康状态**：展示 `status` / `disabled` / `unavailable` / 成功失败计数 / 近 20 个 10 分钟请求区间。
3. **并发与容错**：上游请求并发执行；单账号取数失败只影响该卡片；传输层并行探测、粘滞优胜者并复用 keep-alive 连接。

## 目录结构

```
lib/net.js                    代理感知 HTTP 客户端（HTTP CONNECT / SOCKS5，仅用 node: 内置模块）
lib/cpa.js                    CPA 领域逻辑：账号发现、usage 拉取、窗口解析、写操作、诊断解析
lib/schema.js                 schemastery 加载器（本地依赖优先，回退到宿主 profile）
lib/index.js                  Cordis 服务端插件：配置三层、runtime 热切换、轮询、路由
lib/client.js                 浏览器半边：手写 bundle，侧栏徽标 + 面板 + 两代配置面
cordis.patch.yml              组合层默认配置 + 挂载入口
scripts/probe.mjs             服务端真机探针
scripts/patch-config.mjs      补丁 YAML 读取器（使用真实 YAML 解析）
scripts/check.mjs             包契约检查
scripts/smoke-server.mjs      服务端集成测试（真 Cordis + 真 settings 服务）
scripts/smoke-client.mjs      客户端渲染测试（jsdom + React 18）
scripts/capture-fixtures.mjs  重抓离线 fixture
test/fixtures/                真机抓取的 fixture（快照 / 错误日志列表 / 单篇正文与解析）
```

## 本地开发

### 安装与热更新

```bash
cd /path/to/dsh-cpa-monitor && npm install
dsh plugin --profile web add /path/to/dsh-cpa-monitor
```

`pnpm add <目录>` 生成 `link:` 软链接，链接后的插件仍可从自身真实路径解析依赖（软链接保留真实路径，Node 自仓库侧向上查找 `node_modules`），因此仓库内的 `npm install` 不可省略。

| 修改对象 | 生效方式 |
|---|---|
| `lib/client.js` | 宿主轮询到 mtime/size 变化后热重载该插件，刷新页面即可 |
| `lib/index.js`、`lib/cpa.js`、`lib/net.js`、`lib/schema.js` | 仅在进程启动时加载，**必须重启 `dsh web`（或桌面 App）** |
| 配置项 | 保存即生效，无需重启 |

服务端为旧版时，面板会依据快照中的 `capabilities` 字段给出提示（详见下文"能力位"），此时新增控件不会渲染。

## 配置契约

### 三层覆盖

```
schema 默认值  →  组合层（本包 cordis.patch.yml）  →  用户层
```

用户层落点随宿主版本变化：≤ 0.1 为 `~/.dsh/settings.yaml` 的 `cpa-monitor:` 段（由本包注册的命名空间写入）；≥ 0.2 为当前 profile 自身的配置文档（由宿主配置编辑器写入）。

按 id 定位的补丁（`- id: cpa-monitor`）会整体替换 `config` 对象，而非深合并；`dsh web --dump-config` 可打印组合结果。

### 0.2 的 volatile 契约（承重约束）

0.2 的配置表单只保留标记了 `meta.volatile` 的字段：`dsh-settings` 的 `volatileForm()` 会丢弃其余字段，若一个都不剩则返回 `undefined`，`describe()` 随之跳过整行，浏览器无法取得该命名空间，表现为"配置按钮点开一片空白"。其 `write()` 同样只接受 volatile 节点下的路径。

本插件 12 个字段全部标记。标记方式是 `.extra("volatile", true)` 而非 `.volatile()`：后者仅存在于宿主打过补丁的 schemastery 3.18.4 中，其实现即为 `extra("volatile", true)`，而 npm 公开发布的 3.18.2 没有该方法；使用 `extra` 可同时兼容两种构建。

标记 volatile 还有第二层语义：字段解析结果不是值，而是可写单元格（`{ get(), [Symbol.for("cosmokit.volatile.write")] }`）。仅修改这些字段时 Loader 不会重新 `apply`，而是写入单元格并广播 `loader/volatile-update`。因此服务端半边在边界处使用 `plainEntryConfig()` 解出普通值，并监听该事件重新激活运行时；该路径不成立时，0.2 上的配置保存会静默失效。

`Config` 必须是真正的 schemastery 对象：0.2 的配置编辑器要求 `"toJSON" in Config` 才会投影表单，并会遍历它以脱敏 `role('secret')` 字段；手写的 Standard Schema 无法满足这两点。

### 0.1 的配置面

0.1 使用 `settings.plugin.item` + `settingsScope`，二者在 0.2 中已移除（`settings.plugin.item` 不在 0.2.0-rc.2 的 98 个根 slot 中，`settingsScope` 服务一并删除）。该分支在 0.2 上不会注册，但也不会报错。

0.1 的卡片与官方各设置页逐项对齐：默认折叠、`li` 卡片壳、15px/600 标题与 13px 描述、`.5px` `border-l4` 描边、展开后切换为 `bg-layer-2`、`IconChevronDownOutline…` 旋转 180°（0.1 为 `…Outline14`，0.2 为 `…OutlineRegular`，按代次依次尝试）、未保存时在标题栏挂官方 `Tag`（`tone: "neutral"`）、保存成功后自动折叠、`aria-label` 采用官方措辞。折叠不会丢失暂存内容。0.2 的插件页版本不套卡片壳（页面已绘制标题与面包屑），表单直接展开并常驻显示。

0.2 的插件页声明三个 slot 供插件注册配置面，本插件使用 `plugins.row.config`，键为 `dsh-cpa-monitor#cpa-monitor`（`<包名>#<patch 中的行 id>`）。表单状态由页面的 `form` 持有，保存时写入。

### cordis.patch.yml

`insert` 段的 `id` 与 `name` 决定插件身份与配置行 id，`config` 为组合层默认值。该文件会被提交，因此其中只有占位地址且不含 `managementKey`；真实部署信息位于用户层或环境变量 `DSH_CPA_MANAGEMENT_KEY`。

### 能力位与热重载错配

快照载荷中的 `capabilities` 数组（当前为 `["account","diagnostics","cpa","reset","credits","refresh","consume"]`）用于处理热重载错配：`lib/client.js` 由 HMR 即时生效，`lib/index.js` 仅在重启后更新，因此"浏览器为新版、服务端为旧版"是正常状态。客户端依据该声明决定渲染哪些控件；声明缺失时会显示"服务端 half 是旧版，请重启"并隐藏相关控件，而不是在操作后返回难以理解的错误。

## 传输层

`lib/net.js` 实现代理感知的 HTTP 客户端，仅使用 `node:` 内置模块：

- 候选代理**并行探测**，首个成功者胜出，顺序只用于打破平局，失效候选不带来额外延迟；
- 优胜者之后被粘滞复用，并保持 keep-alive 连接；
- 连续失败的候选在 10 秒后被标记为不可达并跳过，直到一次全员失败才重新探测；
- `connectTimeoutMs` 限制单条代理握手/TLS，`timeoutMs` 限制端到端请求。

代理列表默认为空，即直连；此时 `allowDirect` 隐式为真。

## 管理 API 适配

CPA 8 引入 `/v8/management`，并将其自身的 `/v0/management` 标注为临近废弃。本插件对两代均支持：启动后的首次调用会先以一次只读探针（v8 独有的配额提供方目录，体量小且不含机密）判定目标 CPA 的代数，结果缓存在客户端上，其后所有调用均走该代；探针被拒（401/403）会照常报告 `management key rejected`，不会静默降级。

| 用途 | v8 | v0 |
|---|---|---|
| 凭据列表 | `GET /credentials` | `GET /auth-files` |
| 开关 / 字段 | `PATCH /credentials/status`、`/credentials/fields` | `PATCH /auth-files/status`、`/auth-files/fields` |
| 带凭据的上游调用 | `POST /requests/api-call` | `POST /api-call` |
| 错误日志 | `GET /observability/logs/errors[/:name]` | `GET /request-error-logs[/:name]` |
| 最新版本 | `GET /server/latest-version` | `GET /latest-version` |
| 重置本地冷却 | `POST /routing/cooldown/reset` | `POST /reset-quota` |
| 刷新 OAuth 凭证 | `POST /credentials/refresh` | 无此路由 |
| request-log 开关 | 无（位于配置树） | `GET /request-log`（v8 服务器仍然应答） |

快照中的 `cpa.api` 字段标明本次使用的代数。v8 的 `/credentials` 是否返回 `email` / `priority` / `note` / `success` / `failed` / `recent_requests` 等字段以实测为准；读取实现是宽容的，缺失字段显示为空，而不会导致整个快照失败。

## 上游接口契约

### 用量

```
GET https://chatgpt.com/backend-api/wham/usage
headers: Authorization: Bearer $TOKEN$
         ChatGPT-Account-Id: <id_token.chatgpt_account_id>
```

窗口语义为 `primary_window`（5 小时）与 `secondary_window`（7 天 / 30 天），由 `limit_window_seconds` 判定。该调用通过 CPA 的 `api-call` 路由转发，`$TOKEN$` 由 CPA 替换为对应凭据的 access token。

### 重置券

券的**张数**位于用量响应中，但仅有计数：

```
rate_limit_reset_credits: { available_count, applicable_available_count }
```

券的**明细与到期时间**位于另一个独立的只读接口：

```
GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
→ { available_count, total_earned_count,
    credits: [ { id, status, reset_type, title, granted_at, expires_at, redeemed_at } ] }
```

该接口会限流，因此面板仅在展开时按需读取，服务端缓存 60 秒。实测中，被兑换的券会**从列表中消失**，而非保留并标记为 `redeemed`；面板对两种形态均做了容错。

### 使用重置券

管理 API 没有兑换路由。`POST /v8/management/credentials/quota/reset`（`ResetCredentialQuota`）需要注册**配额提供方**，未注册的部署会返回 501。实际兑换是一次直连上游的请求，经 CPA 的 `api-call` 用该凭据的 token 转发：

```
POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
body:    {"redeem_request_id": "<uuid>"}     # 每次新生成，上游拒绝复用
headers: Authorization: Bearer $TOKEN$
         Content-Type: application/json
         User-Agent: codex-tui/0.149.1 (…)   # 上游校验该 UA
         ChatGPT-Account-Id: <account_id>     # 可取得时
```

该契约与请求头与官方管理面板 `Cli-Proxy-API-Management-Center` 的 `consumeCodexRateLimitResetCredit` 一致。

### 本地冷却

本地冷却来自凭据列表中的 `cooldowns` 与 `next_retry_after` 字段：

```
cooldowns: [ { scope: "credential" | "model", reason, model_key,
               retry_at, remaining_seconds, http_status, backoff_level } ]
```

这是 CPA 的路由状态，与上游额度无关，且仅在 v8 上返回（v0 的 `auth-files` 不含 `cooldowns`）。

## 语义与安全设计

### 本地清空与兑换的区分

`POST /v8/management/routing/cooldown/reset` 经源码确认**仅修改本地状态**：`sdk/cliproxy/auth/conductor_cooldown.go` 的 `Manager.ResetQuota` 遍历 `auth.ModelStates` 调用 `resetModelState`，并通过 `clearCooldownStateForAuth` 清除 `Unavailable` / `NextRetryAfter` / `Quota.Exceeded` / `Quota.NextRecoverAt` / `LastError`，随后将状态置回 active 并重投影模型；函数体内没有任何 HTTP 调用，也没有兑换或配额相关的钩子。因此该路由是免费且幂等的。

真正的券消费是上文"使用重置券"所述的直连上游请求。

### 不可自动化

- 兑换动作在整个仓库中只有一个调用点，位于带动作头、仅接受 loopback 与 `POST` 的写路由的 `action === "consume"` 分支内；
- 本地清空有两个调用点，分别位于 `action === "reset"` 与 `action === "consume"` 分支内；
- 两者均不会被轮询、重试或刷新隐式触发；
- 兑换失败后**不自动重试**：请求发出后失败时无法确定券是否已被消费，重试可能导致消耗第二张。

### 状态一致性

写操作成功后，服务端先执行 `refresh({ force: true })`（提升 generation 栅栏并重新观测，而非读取缓存）并将结果折回响应，随后失效该凭据的重置券缓存；客户端收到结果后再次读取券明细。在数值更新完成前，相关按钮保持禁用状态，以避免依据过期数值发起第二次消费。

若兑换成功而清除本地冷却失败，接口返回 200 并附带 `warning` 字段，客户端以提示条呈现。该设计的原因是：券已被消费，将整体结果报告为失败会误导使用者认为操作未生效。

## 时间戳处理

列表与详情中的时刻均按**绝对时刻**取值，再按浏览器本地时区渲染：

- 详情优先使用日志正文中的 `Timestamp:` 行，该值自带偏移（`+08:00` 或 `Z`），为权威来源；
- 列表优先使用 CPA 返回的 `modified`（绝对 epoch 秒，与写入端时区无关）；
- 仅当两者均不可用时，才回退到从文件名中的 `20260930T122726` 解析。文件名是 CPA 自身的本地墙钟且不含偏移，因此按宿主时区解读。

此处修复过一个真实缺陷：早期实现对每个时间戳强行拼接 `Z`，等同于将写入端墙钟当作 UTC。在 `+08:00` 的部署上，列表中的全部失败时间比真实时间晚 8 小时，而正文中本就带 `Z` 的时间戳被拼成 `…ZZ` 导致解析失败。

两项必要的说明：CPA 的 `request-log` 开启时，失败记录会并入请求日志目录，此时 `request-error-logs` 为空，插件会明确提示该状态；`/logs` 接口体量过大（实测约 7MB / 13 万行，直接超时），因此未接入。

## 依赖与模块纯度

profile 插件通过 `link:` 安装，包的真实路径位于**本仓库**而非 profile 的 `node_modules`，因此它自身 `import` 的包会自仓库向上查找，而该处没有 `node_modules`。

因此服务端半边仅使用 `node:` 内置模块，**唯一例外是 `@deepseek-ai/schemastery`**：两代宿主都需要真实的 schemastery 对象——0.1 的设置服务把 schema 当作函数调用来解析命名空间，0.2 的配置编辑器要求 `"toJSON" in Config` 才会投影表单，并会遍历它以脱敏 `role('secret')` 字段。该依赖被精确锁定在宿主同版本（3.18.4），且 `lib/schema.js` 先尝试本包依赖、再回退到宿主各 profile 的 `node_modules`：即使遗漏 `npm install`，服务端半边仍可从组合层配置继续监控，只是配置表单不可用（日志会给出原因，`npm run check` 会以 note 说明）。

客户端半边的依赖由 shell 的 seed 模块提供（`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`）。

## 样式与设计 token

面板样式向宿主请求设计 token。**未定义的 token 会静默使整条声明失效**：`background: var(--undefined)` 不会绘制任何内容。该问题曾导致危险按钮以白字绘制在透明背景上（`--dsw-alias-label-error` 在 0.2 中不存在，而 `--dsw-alias-bg-layer-3` 存在且为白色）。

约定：

- 状态色使用 0.2 定义的名称：`--dsw-alias-state-error-primary` / `--dsw-alias-state-warn-label` / `--dsw-alias-state-warn-primary`；
- 0.1 时代的名称（`label-error` / `label-warning` / `fill-l1` / `fill-l2`）仅作为 `var()` 的回退值保留，以保证跨代兼容；
- 危险按钮采用宿主自身的做法：淡红底（`color-mix` 12%）、红字与红色描边。

`npm run check` 包含一条设计 token 契约：宿主主题打包在 `app.asar` 内，普通 `fs` 无法读取，因此 `check.mjs` 内置了一个约 30 行、无依赖的 asar 读取器（可用 `DSH_WEB_THEME` 覆盖路径），随后按 CSS 语义判定——只有**没有回退值**的 `var()` 才会因其 token 未定义而失效，带 fallback 的跨代 shim 不视为错误。

## HTTP 路由

| 路由 | 说明 |
|---|---|
| `GET /api/cpa-monitor/snapshot` | 缓存的快照与生效配置（密钥仅以 `managementKeyConfigured: true/false` 体现）；`?refresh=1` 强制刷新 |
| `GET\|POST /api/cpa-monitor/refresh` | 强制刷新 |
| `GET /api/cpa-monitor/diagnostics` | 列出失败请求日志 |
| `GET /api/cpa-monitor/diagnostics?file=<name>` | 读取单篇并解析归属账号、模型、重试次数、上游状态与错误码 |
| `GET /api/cpa-monitor/credits?authIndex=<id>` | 该账号的重置券明细与到期时间（按需读取，缓存 60 秒） |
| `POST /api/cpa-monitor/account` | 凭据写操作：`{action:"status"}`、`{action:"fields"}`、`{action:"reset"}`（清空本地冷却）、`{action:"consume"}`（使用 1 张重置券）、`{action:"refresh"}`（刷新 OAuth 令牌，仅 v8） |

所有路由仅接受 loopback 对端；强制刷新与全部写操作还必须携带 `x-dsh-cpa-monitor-action` 请求头。写操作仅接受 `POST`。

## 测试与验证

```bash
npm run check    # 包契约
npm test         # 服务端与客户端集成/渲染测试
node scripts/probe.mjs            # 服务端真机探针（摘要）
node scripts/probe.mjs --json     # 完整快照
npm run fixtures                  # 从真机重抓离线 fixture（快照 + 错误日志）
```

| 脚本 | 覆盖范围 |
|---|---|
| `scripts/check.mjs` | 包契约：`exports["./client"]`、`dsh.client.platform`、补丁层 insert 形状、服务端仅允许 `node:` 与相对路径及锁死的 schemastery、客户端 `require` 全部位于 shell seed 表内；另含若干纯函数回归（因集成套件需要宿主安装，并非随处可跑）：`Config` 的 0.2 表单契约（`toJSON` / `type` / `dict` / `secret` / 每字段 volatile）、日志时间戳规则、管理 API 面（v8 探针命中 / 404 回退 v0 / 401 不降级）、重置与兑换的不可自动化（调用点数量与位置）、设计 token 契约 |
| `scripts/smoke-server.mjs` | 在真实 Cordis 上下文中运行插件，配真实 `SettingsProvider`（内存存储）与桩 `webServer`；另有一套假 CPA 传输（canned 响应与写入日志）用于验证凭据写操作与诊断：命名空间注册、三层优先级、`live` 生效、修订围栏写入、密钥脱敏、校验拒绝、回到默认层、loopback 围栏、action 头守卫、缓存、无 settings 服务时的降级、真机快照、版本元信息、按 `authIndex` 寻址的凭据写入及全部拒绝路径、诊断解析与路径穿越拒绝 |
| `scripts/smoke-client.mjs` | jsdom + React 18 真实渲染：插槽注册形状、`pickBadge` 选择规则与三段式格式、版本提示、账号开关与编辑的请求形状与回填、诊断列表与详情渲染、真机 fixture 渲染、面板文案位置、设置卡片的折叠/展开与暂存、逐字段的渲染与校验、失败详情就地展开、重置券与本地冷却（链接 → 面板 → 二次确认 → 恰好一个写请求；按需读取到期；v8 编辑器的 OAuth 刷新；v0 下不渲染该控件）、0.2 插件页行配置（注册形状、`summary` / `page` 视图、`form.mutate` 的 path-op 与 revision） |
| `scripts/patch-config.mjs` | 使用真实 YAML 解析读取本包补丁（正则会被注释中的示例值误导） |
| `scripts/capture-fixtures.mjs` | 从真机重抓 `test/fixtures/` |

渲染测试依赖包内的 `.test-env`（React 18 + jsdom，不在 `files` 白名单内，不会进入 npm 包）：

```bash
(cd .test-env && npm install react@18 react-dom@18 jsdom)
```

## 实测记录

2026-10-01 对账号池中某个 Codex 账号执行了一次真实的重置券消费，两侧独立取证（插件快照、直连 CPA 的凭据列表、直连上游的 usage 与券列表）：

| 字段 | 前 → 后 |
|---|---|
| 券可用数（三处来源一致） | 2 → 1 |
| 券列表 | 移除到期日为 10/22 的一张，保留 10/29 的一张 |
| 本地冷却（插件与 CPA 原始） | 5 → 0 |
| CPA `next_retry_after` | 10/04 20:02 → 清空 |
| CPA `status` / `unavailable` | `error` / `true` → `active` / `false` |
| 上游 5h / 7d 剩余 | 53% / 0% → 100% / 100% |
| `plugin.limitReached` / `allowed` | `true` / `false` → `false` / `true` |

结果确认：券被正确消费，上游限额确实重置，且随后清除本地冷却的步骤同样生效。被兑换的券从上游列表中消失，而非保留并标记为 `redeemed`。

## 发布流程

```bash
npm run check && npm test      # 全量验证
npm version <版本> --no-git-tag-version
npm publish                    # 需要 2FA
git push origin main
git tag v<版本> && git push origin v<版本>
```

发布前确认 `files` 白名单包含 `lib`、`cordis.patch.yml`、`README.md`、`DEVELOPMENT.md`，且 `README.md` 与 `DEVELOPMENT.md` 中不含真实地址、密钥或账号邮箱（`npm run check` 的密钥扫描会检查被提交的文件）。

## 许可

[MIT](./LICENSE) © 2026 intx96
