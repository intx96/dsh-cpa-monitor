# dsh-cpa-monitor

一个 DSH Web profile 插件：在**左侧栏底部**显示 CLIProxyAPI（CPA）里每个 Codex 账号的订阅额度状态，提供**地址与代理的可视化配置页**（DSH ≥ 0.2 在侧栏「插件」页，≤ 0.1 在「设置 → 插件」），并支持**在面板里直接开关账号、编辑备注/优先级、查看失败原因**。

- **服务端 half**（`lib/index.js`）：按周期直连 CPA 管理口，聚合账号状态，暴露两个 loopback-only 精确路由，并注册 `cpa-monitor` 设置命名空间。
- **客户端 half**（`lib/client.js`）：注册到 `sidebar.footer.action`（状态徽标 + 详情面板）和 `settings.plugin.item`（配置卡片）。

额度解析逻辑移植自一个参考的 Python 采集脚本（窗口识别、`primary=5h` / `second=7d|30d` 判定、`94%/80%-08/26 14:30` 汇总格式），并做了三点加强：

1. **账号自动发现**：不再硬编码 `auth_index` / `account_id`，改为读 `GET /v0/management/auth-files`，账号增删无需改配置。
2. **带 CPA 健康状态**：额外展示 `status` / `disabled` / `unavailable` / 成功失败计数 / 近 20 个 10 分钟请求桶。
3. **真并发 + 容错**：4 个上游请求并发；单账号取数失败只影响该卡片；传输层并行探测 + 粘滞优胜者 + keep-alive 复用。

---

## 适用范围：额度部分**只适配 Codex**

这一点请先看清，避免误以为它是个通用的多供应商面板：

| 能力 | 是否与 provider 无关 |
|---|---|
| **配额/额度**（徽标的 `5h/7d`、账号卡片的进度条） | ❌ **仅 Codex** |
| 账号启用/禁用、备注、优先级 | ✅ 任何 CPA 凭据 |
| 失败原因诊断（读 CPA 的 error-log） | ✅ 任何 provider 的请求 |
| CPA 版本与更新提示 | ✅ |

只适配 Codex 的原因：额度取自 `GET https://chatgpt.com/backend-api/wham/usage`，鉴权靠 `Chatgpt-Account-Id` 头（值来自凭据 `id_token.chatgpt_account_id`），窗口语义也是 Codex 的 `primary_window` / `secondary_window` + `limit_window_seconds`（5h / 7d / 30d）。其它 provider 没有对应的用量接口，所以：

- 默认 `providerFilter: "codex"`，只列 Codex 凭据；
- 把它**留空**会列出其它 provider 的凭据，但它们的配额条不会出现，卡片上会显示取数失败——这只是"不隐藏"，**不等于支持**。

账号开关/备注/优先级/失败诊断这几项走的是 CPA 的凭据管理与日志接口，与 provider 无关，换成 Claude/Gemini 等凭据同样可用。

---

## 安装

从 npm 安装（使用者用这条）：

```bash
dsh plugin --profile web add dsh-cpa-monitor
# 然后重启 dsh web（服务端 half 在启动时挂载）
```

从源码安装（改代码即时生效，见「开发期热更新」）：

```bash
cd /path/to/dsh-cpa-monitor && npm install     # 插件包有一个真实依赖，见文末说明
dsh plugin --profile web add /path/to/dsh-cpa-monitor
# 然后重启 dsh web
```

装完把 CPA 地址填进**配置页**（见下面「配置」一节的入口对照表），或在启动环境里设 `DSH_CPA_MANAGEMENT_KEY`——仓库里**不含**任何真实地址与密钥，见下面的分层说明。

`dsh plugin add` 用 pnpm 建 **软链**（`link:`，不复制代码），并把 `dsh-cpa-monitor` 追加进 profile 的 `dsh.profile.bundles`。重启后刷新浏览器即可。

卸载：

```bash
dsh plugin --profile web remove dsh-cpa-monitor
```

> 已实测：`pnpm add <目录>` 生成 `link:`，链接后的插件仍能从自己的真实路径解析到依赖（软链保留真实路径，Node 从仓库侧向上找 `node_modules`）。所以第 1 步不能省。

### 开发期热更新

- 改 `lib/client.js` → `dsh-client-hmr` 轮询到 mtime/size 变化，**浏览器自动热重载该插件**，不用重启。
- 改 `lib/index.js`（服务端 half）→ 需要重启 `dsh web`。
- 改配置 → **不需要重启**，见下。

---

## 配置

### 首选：配置页

配置页的入口**跟着 DSH 版本走**，插件对两代都做了注册，只会命中其中一个：

| DSH | 入口 |
|---|---|
| **≥ 0.2**（含桌面 App） | 左侧栏 **插件** → **已安装** → `dsh-cpa-monitor` → 行 `cpa-monitor` 的 **配置** |
| ≤ 0.1 | **设置 → 插件 → 「CPA 账号状态」** |

0.2 把「插件自己的配置」从设置里搬走了：设置里只剩一个**只读**的插件清单（设置 → 插件 → 插件列表），配置改由侧栏插件页承载。插件页声明三个 slot 供插件注册配置面，本插件用的是 `plugins.row.config`，键为 `dsh-cpa-monitor#cpa-monitor`（`<包名>#<patch 里的行 id>`）。页面会自己画标题、图标和面包屑，表单状态由页面的 `form` 持有——**点保存才写**，离开页面丢弃未保存的修改。

0.1 的老卡片走的是 `settings.plugin.item` + `settingsScope`，这两样在 0.2 里已经被删掉（`settings.plugin.item` 在 0.2.0-rc.2 的 98 个根 slot 里已不存在，`settingsScope` 服务也一并没了），所以那一分支在 0.2 上只是静静地不注册，不会报错。

0.1 的那张卡片与官方各设置页**逐项对齐**（按官方 `PluginCard` 的实现照做）：默认折叠、`li` 卡片壳、15px/600 标题 + 13px 描述、`.5px` `border-l4` 描边、展开后换 `bg-layer-2`、`IconChevronDownOutline…` 旋转 180°（0.1 是 `…Outline14`，0.2 是 `…OutlineRegular`，插件按代次依次尝试）、未保存时在标题栏挂官方的 `Tag`（`tone: "neutral"`）、**保存成功后自动折叠**、`aria-label` 也是官方的「展开/收起: <标题>」形式。折叠不会丢暂存。0.2 的插件页版本不套卡片壳（页面已经画了标题和面包屑），表单直接铺开、常驻显示。展开后是 12 个字段，每个都显示当前生效值、是否被覆盖（`已覆盖` 徽标）以及一个 `清除` 回到默认层：

| 字段 | 说明 |
|---|---|
| CPA 地址 | CLIProxyAPI 管理口，例如 `https://cpa.example.com:8317` |
| 管理密钥 | `Authorization: Bearer <密钥>`；**留空表示不修改**（脱敏字段，界面永不回显） |
| 代理地址 | **默认为空**（直连）；需要时每行一个、按顺序尝试；`http://` / `https://` / `socks5://`，也可直接写 `host:port`（按 HTTP 代理处理） |
| 允许直连 | 所有代理都失败后再试直连（代理列表为空时自动直连） |
| 轮询周期（秒） | 后台拉取间隔，最小 5 秒 |
| 请求超时（秒） | 单个上游请求端到端上限 |
| 连接超时（秒） | 单条代理握手/TLS 上限，不能大于请求超时 |
| Provider 过滤 | 只监控该 provider 的凭据，留空=全部（⚠️ 见「适用范围」：额度只适配 Codex） |
| 侧栏徽标口径 | `lowest` = 显示最紧张那个账号的余量；`total` = 各账号按窗口累加（见下） |
| 包含已禁用账号 | 把 CPA 里已禁用的账号一并列出（置灰） |
| 时区 | 重置时间的显示时区，例如 `Asia/Shanghai` |
| 跳过证书校验 | 仅用于 CPA 使用自签名证书 |

写盘位置跟着宿主版本走（见下表）；保存是**修订号围栏**的文档写入，校验不通过的写入会被拒绝并保持原值。两代都**保存即生效**：0.1 走命名空间的 `watch`，0.2 走下面的 volatile 通道，后台立刻用新配置重建传输层并重启轮询。

#### 为什么每个字段都要标 `volatile`（承重细节）

0.2 的表单**只保留标了 `meta.volatile` 的字段**：`dsh-settings` 的 `volatileForm()` 会把其它字段逐个丢掉，一个都不剩时直接返回 `undefined`，`describe()` 于是跳过整行——浏览器根本拿不到这个命名空间，表现就是「配置按钮点开一片空白」。它的 `write()` 也只接受 volatile 节点下的路径。官方就是这么写的：`@deepseek-ai/dsh-subagent` 的 `static Config` 给每个字段都挂了 `.volatile()`。

我们 12 个字段全标。标法用的是 `.extra("volatile", true)` 而不是 `.volatile()`：`volatile()` 是宿主那份**打过补丁的 3.18.4** 才有的糖，其实现就是 `extra("volatile", true)`，而 npm 上公开发布的 3.18.2 没有这个方法——用 `extra` 两种构建都能出表单。

标了 volatile 还有第二层语义：字段解析出来不是值，而是**可写单元格**（`{ get(), [Symbol.for("cosmokit.volatile.write")] }`）。而且只改这些字段时 Loader **不会重新 apply**，它把新值写进单元格再广播 `loader/volatile-update`（官方插件读的就是 `this.config.language.get()`）。所以服务端 half 在边界处用 `plainEntryConfig()` 统一解出普通值，并监听该事件重新激活运行时——这条路径不成立的话，0.2 上保存配置会静默无效。

### 备用：YAML（部署级默认值）

配置分三层，逐层覆盖：

```
schema 默认值  →  组合层（本包 cordis.patch.yml）  →  用户层
```

**用户层落在哪里，取决于宿主版本**（这是两代之间唯一还没统一的地方）：

| DSH | 用户层 | 谁写它 |
|---|---|---|
| ≤ 0.1 | `~/.dsh/settings.yaml` 的 `cpa-monitor:` 段 | 本包注册的设置命名空间 |
| ≥ 0.2 | 当前 profile 自己的配置文档 | 宿主的配置编辑器（表单由本包导出的 `Config` 派生） |

两代都是保存即生效：0.1 走命名空间的 `watch`，0.2 由配置编辑器重载本行、重新执行 `apply`。

**本仓库刻意不含密钥。** `cordis.patch.yml`（会被提交）只有占位地址且没有 `managementKey`；某个部署的真实地址与密钥属于**用户层**（上述两处之一），或环境变量 `DSH_CPA_MANAGEMENT_KEY`。`npm run check` 里有一条扫描会挡住「密钥形状的字面量」重新混进被提交的文件。

要在整个部署里改默认值（例如给新 profile 准备一套），用 id 定位补丁写进 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: cpa-monitor
  config:
    baseURL: "https://cpa.example.com:8317"
    proxies: ["http://127.0.0.1:1080"]
```

⚠️ 按 id 定位的补丁会**整体替换** `config` 对象（不是深合并），要改一个字段就把其它字段一起写上。`dsh web --dump-config` 可打印组合结果。在配置页里清除过的字段会回到这里。

### 附：本机实测的 1081 僵尸代理（不再是默认值）

2026-09-17 实测：

| 端口 | 结果 |
|---|---|
| `127.0.0.1:1081` | TCP 能连上，但 **CONNECT / SOCKS5 都不通，对端约 81s 后才 reset** |
| `127.0.0.1:1080` | 可用的 HTTP CONNECT 代理，经它访问 CPA 正常（约 0.5–1.5s/请求） |

这段实测正是**默认代理列表改为空**的原因：把本机环境里的两个 loopback 候选写进默认值，对任何没有本地代理的部署都是纯粹的失败源，而且第一眼看上去像插件坏了。现在默认是 `proxies: []` → 直连；需要在真的走代理时，在配置页填你自己的候选（传输层仍是**并行探测**：僵尸候选不拖慢任何请求，10 秒后被标记不可达并跳过，直到一次全员失败才重新探测）。

---

## 面板里的运营与诊断

### 账号开关 / 备注 / 优先级（写操作）

每个账号卡片上多了三个东西：

- **禁用 / 启用**：直接对 CPA 发 `PATCH /auth-files/status`。某账号 401 或被风控时不用再开 CPA 网页，在正看着的面板里停掉即可。写入期间按钮显示「写入中…」，服务端写完会**强制重读快照**并把结果折回面板，所以状态 chip 和右侧 `可用/总数` 计数立刻跟着变。
- **编辑**：就地改 `note`（备注）与 `priority`（优先级），保存走 `PATCH /auth-files/fields`。备注会显示在卡片上，优先级也进 meta 行。编辑器里的说明文案（优先级的排序规则、刷新凭证的用途）挂在字段旁的 `ⓘ` 上**悬停显示**，不常驻占行；用宿主共享的 `Tooltip`（`label` + 单个 child），没有它的构建退回原生 `title`，两种情况都同时写进 `aria-label`，所以藏到悬停后面不等于对读屏隐藏。OAuth 刷新按钮与「取消 / 保存」同一行（见下）。
- 只做了 `note` + `priority`，**没做 `prefix`**：`prefix` 能写但 CPA 的 `auth-files` 不回读它（只在磁盘回退路径暴露），做成只写字段会让人困惑。

写操作的三条约束：浏览器**只传 `authIndex`**，服务端从快照解析出凭据文件名再去写（浏览器没有机会指名任意文件）；`disabled` 必须是布尔、`priority` 必须是数字；被拒绝的请求不会打到 CPA（测试里断言了这一点）。

### 重置券与本地冷却

卡片底部那行 `重置券 N`（没有券但有冷却时显示为「本地冷却」）是一个**链接**，点开在卡片内就地展开：可用重置券的张数与每张到期时间（**只读展示**），以及该账号当前的**本地冷却**条目——CPA 收到上游 429 后自己记的那份状态。

**先说一件被纠正过的事。** 这个功能最初是照「`POST /v8/management/routing/cooldown/reset` 会消耗一张重置券」实现的；读了 CPA 源码（`sdk/cliproxy/auth/conductor_cooldown.go` 的 `Manager.ResetQuota`）后确认**并非如此**：它只清本地字段——遍历 `auth.ModelStates` 调 `resetModelState`、用 `clearCooldownStateForAuth` 清掉 `Unavailable`/`NextRetryAfter`/`Quota.Exceeded`/`NextRecoverAt`/`LastError` 并把状态改回 active，再重投影模型——**函数体里没有任何 http/上游调用，也没有 redeem/credit 钩子**，所以它是免费的、只影响本地路由状态。

**那重置券到底怎么花？** 管理 API 里没有这条路：另一条 `POST /v8/management/credentials/quota/reset`（`ResetCredentialQuota`）要注册**配额提供方**，`providers` 为空的部署会 501。真正的兑换是**直连上游**的一次 POST，借 CPA 的 `api-call` 用该凭据的 token 转发出去——这一点是读官方管理面板 `Cli-Proxy-API-Management-Center` 的 `consumeCodexRateLimitResetCredit` 确认的：

```
POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
body:    {"redeem_request_id": "<uuid>"}          # 每次新生成，上游拒绝复用
headers: Authorization: Bearer $TOKEN$
         Content-Type: application/json
         User-Agent: codex-tui/0.149.1 (…)       # 上游认这个 UA
         ChatGPT-Account-Id: <account_id>         # 能取到时
```

所以面板里是**两个不同的动作**，各自独立确认：

| 动作 | 打给谁 | 代价 |
|---|---|---|
| **清空本地冷却** | `POST /v8/management/routing/cooldown/reset` | 免费，只改 CPA 本地路由状态 |
| **使用重置券** | 上游 `…/rate-limit-reset-credits/consume`，成功后**顺手**再做一次上面的本地清空 | **不可撤销地花掉 1 张券**，立刻重置该账号 5h/7d 限额 |

「使用重置券」为什么还要跟着清一次本地冷却：兑换只解开**上游**的限额，CPA 自己的冷却记录还在，账号依旧不会立刻可用——官方管理面板就是这样，重置完还得再手动点一次「取消冷却」。多出来的这一腿是免费且幂等的，所以同一次点击就做掉。**顺序不能反**：先清本地再兑换，只会让 CPA 立刻拿一个还在限流的上游去撞墙。

如果券已经花掉、但这一腿失败（网络抖动等），接口会返回成功**外加**一条 `warning`（面板以黄色提示条显示「重置券已使用，但清空本地冷却失败：…」）。此时**绝不重试兑换**（券要不回来，重试就是再花一张），只需点「清空本地冷却」重试那半截。

两者都保留一次二次确认（第一条：误点会让 CPA 立刻重试一个仍在限流的上游；第二条：花掉的券要不回来）：

- 插件**任何**自动路径都不会调用它：不轮询、不重试、不在刷新时顺手调用；`resetCooldown` 在整个仓库里只有一个调用点，就是那条带动作头、只接受 loopback 与 `POST` 的写路由，`npm run check` 里有一条断言钉住这一点。
- 打开面板、点 `重置`、点 `取消` 都**不发任何写请求**（客户端套件里各有断言）。
- **重置成功后立刻重读用量与重置券**：服务端先把这次写入折回快照（`refresh({force: true})`，是重新观测而不是读缓存），并**立即失效**那条凭据的重置券缓存；客户端拿到结果后再主动重读一次明细。因此在数字更新完成前，「重置」按钮一直是禁用状态——陈旧数字不会成为第二次消费的依据。
- **本地冷却的来源**是凭据列表（`GET /v8/management/credentials`）里的 `cooldowns[]` 与 `next_retry_after`：每条带 `scope`（`credential` / `model`）、`reason`、`retry_at`、`remaining_seconds`、`model_key`、`http_status`（429）、`backoff_level`。卡片上直接显示一行（`本地冷却 · 模型 gpt-5.6-terra 至 10/03 17:10；…`），面板里逐条列出。这是**路由状态**，与上游额度是两回事，也只出现在 v8（v0 的 `auth-files` 不返回 `cooldowns`）。
- **到期时间不在使用量接口里**（实测：那份 `rate_limit_reset_credits` 只有 `{available_count, applicable_available_count}`），而在上游一个**独立**的只读接口上：

  ```
  GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
  → { available_count, total_earned_count,
      credits: [ { status, reset_type, title, granted_at, expires_at, redeemed_at } ] }
  ```

  面板只在展开时按需读它（`GET /api/cpa-monitor/credits?authIndex=…`），服务端缓存 60 秒——那个接口会限流，翻来覆去点不该换来一串 429。每张券显示 `标题 · 到期 …`，已兑换的显示 `已于 … 兑换`；读不到就显示「到期时间未提供」，绝不编一个。

### 刷新 OAuth 凭证（仅 v8）

账号卡片的**编辑器**里有一个 `刷新 OAuth 凭证` 按钮：让 CPA 立刻用 refresh token 换一张新的 access token。它只出现在 CPA v8 上——`POST /v8/management/credentials/refresh` 这条路由在 v0 里不存在，所以服务端在 v0 面会直接拒绝，客户端也不显示这个按钮（快照里的 `cpa.api` 说明了当前说的是哪一代）。

CPA 那个接口还接受 `all: true`（一次刷新全部凭据），本插件**从不**使用它：请求体只会带单个凭据的名字，`npm run check` 里有一条断言钉住这一点。

### 实测记录：一次真实的重置券消费

2026-10-01 在池子里某个 Codex 账号上端到端跑了一次（邮箱不写进仓库，密钥扫描会拦）（**真花掉 1 张券**），两侧独立取证（插件快照 + 直连 CPA 的凭据列表 + 直连上游的 usage / 券列表）：

| 字段 | 前 → 后 |
|---|---|
| 券可用数（三处来源） | 2 → **1** |
| 券列表 | 少掉 `…6a61`（到期 10/22），剩 `…4d84`（10/29） |
| **本地冷却**（插件与 CPA 原始） | 5 → **0** |
| CPA `next_retry_after` | 10/04 20:02 → **清空** |
| CPA `status` / `unavailable` | `error` / `true` → **`active`** / **`false`** |
| 上游 5h / 7d 剩余 | 53% / 0% → **100% / 100%** |
| `plugin.limitReached` / `allowed` | `true` / `false` → **`false` / `true`** |

也就是说：券被正确消费、上游限额确实重置、而且**顺手清本地冷却那一腿也生效了**（否则冷却会留在 5 条）。顺带一个观察：被兑换掉的那张券会**从上游列表里消失**，而不是留在列表里显示 `redeemed`——面板对两种形态都做了容错。

### 失败原因（只读）

面板底部新增「最近失败请求」区块，点「查看」列出 CPA 的 `request-error-logs`，点「详情」在**该行正下方**就地展开单篇（按钮随之变成「收起」，再点即收起）。展开体是渲染在被点那一行**内部**的，不是追加到列表末尾——追加到末尾会让「点了按钮」看起来像没反应。展开出来的是**解析后的摘要**，不是请求正文：

- 上游状态码（`Status: 502`）与错误三元组（`service_unavailable_error` / `server_is_overloaded` / 人类可读文案）
- **归属账号，且是逐跳的**：CPA 给每次上游尝试都打了 `Auth: provider=…, auth_id=<凭据文件名>, label=<邮箱>`，所以能显示「第 1 跳 alpha → 第 2 跳 bravo」，正好和上面的账号卡片对上
- 模型、端点、重试次数（`N 次尝试`）、发生时刻

请求正文（`=== REQUEST INFO ===` 那一段，主要是提示词负载）默认**不显示**：读它是另一件事，和「这次为什么失败」无关。只有当解析什么都没读出来（未识别的日志格式）时，才退回显示正文——否则那种情况下展开体是空的，比给出正文更糟。正文读取上限 24KB，超出会标注已截断。

### 时间戳

列表和详情里的时刻都按**绝对时刻**取，再按浏览器本地时区渲染：

- 详情优先用日志正文里的 `Timestamp:` 行——它自带偏移（`…+08:00` / `…Z`），是权威值；
- 列表优先用 CPA 返回的 `modified`，那是绝对 epoch 秒，与写入端时区无关；
- 只有两者都拿不到时，才退回从**文件名**里的 `20260930T122726` 解析。文件名是 CPA 自己的**本地墙钟**、不带偏移，所以按宿主时区解读。

这里修过一个真实 bug：早期实现对每个时间戳都强行拼 `Z`，等于把写入端的墙钟当成 UTC。在一个 `+08:00` 的部署上，列表里所有失败都比真实时间晚 8 小时（看起来像「比现在快了 3 小时」），而正文里本来就带 `Z` 的时间戳被拼成 `…ZZ` 直接解析失败。

两个必要的诚实说明：CPA 的 `request-log` 打开时失败记录会并进请求日志目录，`request-error-logs` 就是空的——插件会把这种情况**明说**，而不是让你以为「没有失败」。另外 `/logs` 那个接口是 7MB / 13 万行的火管（实测直接超时），所以刻意没接。

### 管理 API：v8 优先，v0 回退

CPA 8 引入了 `/v8/management`，并把它自己的 `/v0/management` 标注为「临近废弃」。本插件**两代都支持**：启动后第一次调用会先用一次只读探针（v8 独有的配额提供方目录，很小且不含机密）判定这台 CPA 说的是哪一代，把结果缓存在客户端上，之后所有调用都走那一代；探针被拒（401/403）会照旧报「management key rejected」，而不是偷偷降级。

| 用途 | v8 | v0 |
|---|---|---|
| 凭据列表 | `GET /credentials` | `GET /auth-files` |
| 开关 / 字段 | `PATCH /credentials/status`、`/credentials/fields` | `PATCH /auth-files/status`、`/auth-files/fields` |
| 带凭据的上游调用 | `POST /requests/api-call` | `POST /api-call` |
| 错误日志 | `GET /observability/logs/errors[/:name]` | `GET /request-error-logs[/:name]` |
| 最新版本 | `GET /server/latest-version` | `GET /latest-version` |
| 重置冷却 | `POST /routing/cooldown/reset` | `POST /reset-quota` |
| request-log 开关 | 无（在配置树里） | `GET /request-log`（v8 服务器仍然应答） |

快照的 `cpa.api` 会写明这次用的是 `v8` 还是 `v0`。v8 的 `/credentials` 是否仍返回 `email`/`priority`/`note`/`success`/`failed`/`recent_requests` 等字段以实测为准——读取是宽容的，缺哪一项就那项显示为空，而不是让整个快照失败。

### CPA 版本

汇总条里显示当前构建（`CPA 7.2.159`，取自每个管理响应的 `x-cpa-version` 头），并且在宿主能连到 GitHub 且确有新版时补一句 `有新版本 v7.3.7`（`GET /latest-version`，结果缓存 6 小时；取不到就退回「版本未知」而不是让整个快照失败）。版本比较是数字逐段比的，`v` 前缀和标签后缀都能容忍。

---

## 界面

- **侧栏徽标**：`[仪表图标] CPA 账号 133%/89%        2/3`。数值是 `5h余量/7d余量`，**有 30d 数据时再补一段** `5h/7d/30d`；缺 5h 或 7d 显示 `-`，而 **30d 没有就整段不显示**（所以只有 7d 的池子读作 `94%/12%`）。16px 描边图标打头，和旁边的「设置」条目同一套图标语言，且**固定使用侧栏的中性色**（不会因为额度紧张变红）；数值紧跟在标题后面、和上一行「用量/余额 ¥116.50」对齐，只有 `2/3` 这个账号计数用 `margin-left:auto` 顶到最右。侧栏折叠成 rail 时变成 36px 圆形图标。点击展开浮层面板。面板标题「CPA 账号状态」旁的 `ⓘ` 悬停显示「剩余百分比为「重置前可用量」；进度条越短越危险。」——这条说明原来常驻在面板底部，占一行，现在收进悬停。

  数值有两种口径，由配置页的 **「侧栏徽标口径」** 决定：

  | 口径 | 显示什么 | 例子 |
  |---|---|---|
  | `lowest`（默认） | **最紧张那个账号**自己的 5h/7d/30d 余量 | `100%/0%` |
  | `total` | **各账号按窗口累加**的余量 | `133%/89%`（两个账号 5h 各 100% 与 33%） |

  `lowest` 的「最紧张」由两条规则决定（`pickBadge`，已导出并有单测）：

  1. **有账号的 5h 余量 < 20% 时**，取其中余量最低的那个账号——5h 是会话最先撞到的墙；
  2. **所有 5h 都 ≥ 20% 时**，取长窗口（`7d`/`30d`）余量最低的那个账号——一队宽裕的 5h 不该掩盖快用完的长窗口。

  `total` 的累加**只统计未禁用账号**（禁用账号不提供服务，也就不贡献余量）。语义上这是**池子的总余量**而非百分比：三个账号各 100% 就是 300%（分母是账号数 × 100%）。

  **颜色跟着屏幕上显示的那个数走**（≤10% 红、≤30% 黄、否则绿）：`lowest` 模式下显示的就是最紧张的账号，所以该账号见底时照常变红；`total` 模式下看的是池子总量。之所以不按「最差账号」上色——**账号池是负载均衡的，一个账号用尽只会把流量切到下一个，不影响其它账号**，所以单个 0% 不该把健康的整体标红。反过来，池子整体接近耗尽时 `total` 依然会报警。账号被禁用或取数失败由右侧的 `可用/总数` 计数承担（例如 `2/3`）。悬停提示会写明是「用量最低的账号 + 邮箱」还是「各账号按窗口累加」。

- **详情面板**：
  - 汇总条：最紧窗口百分比、可用/总数、待处理数、已禁用数、本次采集耗时。
  - 每账号一张卡：邮箱、plan、CPA 状态 chip、`5h` 与 `7d`/`30d` 两条进度条（剩余 % + 重置时间 + 倒计时）、成功/失败计数、近 20 个 10 分钟桶的迷你柱状图。
  - 单账号取数失败时错误原文显示在该卡片内，不影响其它卡片；后端整体不可达时顶部红色横幅显示传输层错误原文与「重试」。
  - 副标题一行是 `更新于 HH:MM:SS · <CPA 地址>`；页脚只有一句语义说明，不再重复地址。
- 面板通过 `createPortal` 挂到 `document.body`，点外部或按 Esc 关闭。

---

## 接口

| 路由 | 说明 |
|---|---|
| `GET /api/cpa-monitor/snapshot` | 缓存的快照 + 生效配置（密钥只以 `managementKeyConfigured: true/false` 体现）；`?refresh=1` 强制刷新 |
| `GET\|POST /api/cpa-monitor/refresh` | 强制刷新 |
| `GET /api/cpa-monitor/diagnostics` | 失败请求诊断：列出 `request-error-logs`（含从文件名解析出的端点与时间戳） |
| `GET /api/cpa-monitor/diagnostics?file=<name>` | 读某一篇并解析出归属账号、模型、重试次数、上游状态与错误码/文案 |
| `GET /api/cpa-monitor/credits?authIndex=<id>` | 该账号的重置券明细与到期时间（按需读取，结果缓存 60 秒） |
| `POST /api/cpa-monitor/account` | 凭据写操作：`{action:"status", authIndex, disabled}` 开关账号；`{action:"fields", authIndex, note?, priority?}` 改备注/优先级；`{action:"reset", authIndex}` 清空该账号在 CPA 上的**本地**冷却状态（只改本地路由状态，不消耗重置券）；`{action:"consume", authIndex}` **使用 1 张重置券**（直连上游兑换，不可撤销）。两者都只由面板自己的二次确认发起；`{action:"refresh", authIndex}` 刷新该账号的 OAuth 令牌（仅 v8） |

所有路由都只接受 loopback 对端；**强制刷新与所有凭据写操作**还必须带 `x-dsh-cpa-monitor-action` 请求头（跨站页面能打 localhost，但带不上自定义头，preflight 会失败）。写操作只接受 `POST`。

快照载荷里还有一个 `capabilities` 数组（当前是 `["account","diagnostics","cpa","reset","credits","refresh","consume"]`）。这是给**热重载错配**用的：`lib/client.js` 由 HMR 即时生效，`lib/index.js` 只有重启 `dsh web` 才会换，所以「浏览器这半新、服务端那半旧」是正常状态。客户端按这份声明决定渲染哪些控件——声明缺失（旧服务端）时，面板会显示一条「服务端 half 是旧版，请重启 dsh web」，并隐藏账号开关/编辑/诊断/版本 chip，而不是让你点了之后拿到一句看不懂的错。

---

## 改了服务端 half 就要重启

- `lib/client.js`（浏览器 half）：HMR 自动热重载，刷新页面即可。
- `lib/index.js` / `lib/cpa.js` / `lib/net.js` / `lib/schema.js`（服务端 half）：**必须重启 `dsh web`**。

服务端是旧版时面板会明说（见上面的 `capabilities`），但旧版服务端不会返回新字段，所以那时版本 chip 与优先级会缺席——看到那条提示就说明该重启了。

## 开发与验证

```bash
npm run check    # 40 项包契约：清单、补丁层（真 YAML 解析）、模块纯度、依赖锁版本、fixture 齐备
npm test         # 服务端 76 项 + 客户端 176 项
node scripts/probe.mjs            # 服务端真机探针（摘要）
node scripts/probe.mjs --json     # 完整快照
npm run fixtures                  # 从真机重抓离线 fixture（快照 + 错误日志）
```

| 脚本 | 覆盖范围 |
|---|---|
| `scripts/check.mjs` | 包契约：`exports["./client"]`、`dsh.client.platform`、补丁层 insert 形状、服务端只允许 `node:` + 相对路径 + 锁死的 schemastery、客户端 `require` 全在 shell seed 表内；另含两条纯函数回归，因为集成套件需要宿主安装、不总能跑：Config 的 0.2 表单契约（toJSON/type/dict/secret/每字段 volatile），以及日志时间戳（正文偏移优先、文件名兜底按宿主时区、列表优先绝对 `modified`）；还有管理 API 面（v8 探针命中 / 404 回退 v0 / 401 不降级）与**重置的不可自动化**（`resetCooldown` 只有一个调用点、且在确认动作里） |
| `scripts/smoke-server.mjs` | 在**真 cordis 上下文**里跑插件，配**真 `SettingsProvider`**（内存存储）+ 桩 `webServer`；另有一套**假 CPA 传输**（canned 响应 + 写入日志）用来验证凭据写操作与诊断，绝不碰生产代理：命名空间注册、三层优先级、`live` 生效、修订围栏写入、密钥脱敏、校验拒绝（错协议/超时倒置/坏时区）、重置回默认层、loopback 围栏、action 头守卫、缓存、无 settings 服务时的降级、真机快照、版本元信息与 `updateAvailable`、按 authIndex→文件名寻址的凭据写入及全部拒绝路径、诊断列表/单篇解析/路径穿越拒绝/未登记文件拒绝、真机只读诊断 |
| `scripts/smoke-client.mjs` | jsdom + React 18 真渲染：插槽注册形状、`pickBadge` 选择规则与三段式格式（含 20% 边界、禁用账号、30d 回退、缺窗口 `-`、累加与口径）、版本 chip、账号开关与备注/优先级编辑的请求形状与回填、失败诊断列表/详情渲染、真机快照 fixture 渲染、面板文案位置（副标题=CPA 地址，页脚不含地址/代理）、设置卡片的折叠/展开与 `aria-expanded`、`Tag` 未保存标记、保存后自动折叠、折叠不丢暂存、每个字段的渲染/暂存/保存/清除/校验阻断、空密钥不写入、秒↔毫秒换算、代理列表↔数组、只读与不可用状态、侧栏图标中性色、图标名跨代次回退、**失败详情就地展开**（展开体在被点行内部、只给解析摘要、其它行不展开、再点收起、解析不出时才退回正文）、重置券（链接 → 面板 → **二次确认** → 恰好一个写请求；打开/首点/取消都不写、按需读取到期、已兑换文案、只读禁用；v8 编辑器里的 OAuth 刷新与 v0 下不显示）、**0.2 插件页行配置**（`dsh-cpa-monitor#cpa-monitor` 注册形状、`summary`/`page` 两种视图、`form.mutate` 的 path-op 与 revision、写入被拒绝的提示、命名空间晚于首屏出现时的 hook 顺序回归） |
| `scripts/patch-config.mjs` | 用真 YAML 解析读本包补丁（正则会被注释里的示例值骗到） |
| `scripts/capture-fixtures.mjs` | 从真机重抓 `test/fixtures/`（快照 / 错误日志列表 / 单篇正文与解析结果） |

渲染测试依赖本包内的 `.test-env`（React 18 + jsdom，`files` 白名单不含它，不会进 npm 包）：

```bash
(cd .test-env && npm --cache ../.npm-cache install react@18 react-dom@18 jsdom)
```

### 目录

```
lib/net.js                  代理感知 HTTP 客户端（HTTP CONNECT / SOCKS5，只用 node: 内置模块）
lib/cpa.js                  CPA 领域逻辑：账号发现、usage 拉取、窗口解析（py 逻辑移植）
lib/schema.js               schemastery 加载器（本地依赖优先，回退到 host 的 profiles）
lib/index.js                cordis 服务端插件：config 三层、runtime 热切换、轮询、路由
lib/client.js               浏览器 half：手写 __ModuleLoader__ bundle，侧栏徽标 + 面板 + 两代配置页（0.2 插件页行配置 / ≤0.1 设置卡片）
cordis.patch.yml            组合层默认配置 + 挂载入口
scripts/probe.mjs           服务端真机探针
scripts/patch-config.mjs    补丁 YAML 读取器
scripts/check.mjs           包契约检查
scripts/smoke-server.mjs    服务端集成测试（真 cordis + 真 settings）
scripts/smoke-client.mjs    客户端渲染测试
test/fixtures/             真机抓取的 fixture（快照 / 错误日志列表 / 单篇正文与解析），供离线测试
scripts/capture-fixtures.mjs  重抓上面这些 fixture
```

### 为什么服务端 half 几乎零依赖

profile 插件用 `link:` 装，包的真实路径在**本仓库**里、不在 profile 的 `node_modules` 里——所以它自己 `import` 的包会从仓库往上找，那里没有 `node_modules`。

因此服务端 half 只用 `node:` 内置模块，**唯一例外是 `@deepseek-ai/schemastery`**：两代宿主都要真 schemastery 对象——0.1 的设置服务把 schema 当函数调用来解析命名空间，0.2 的配置编辑器则要求 `"toJSON" in Config` 才肯投影表单，还会遍历它脱敏 `role('secret')` 字段——手写的 Standard Schema 两样都做不到。它被精确锁在 host 同版本（3.18.4，宿主那份是带 `volatile` 支持的构建），且 `lib/schema.js` 先试本包依赖、再回退到 host 各 profile 的 `node_modules`：即使漏了 `npm install`，server half 仍能从组合层配置继续监控，只是配置表单不可用（日志会给出原因，`npm run check` 会用一条 note 说明）。

客户端 half 的依赖由 shell 的 seed 模块满足（`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`）。

---

## 许可

[MIT](./LICENSE) © 2026 intx96
