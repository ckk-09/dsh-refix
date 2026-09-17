# dsh-refix 技术文档（TECHNICAL）

> 本文件承接原 README 的全部技术内容：机制、硬边界、验收矩阵、已知边界、阶段状态。
> **面向使用者的入门内容请看 [README.md](./README.md) 与 [QUICKSTART.md](./QUICKSTART.md)。**

## 版本定版对照表

2026-09-17 起仓库统一使用发布定版号。开发代号（`vN / pX.Y`）保留在源码 `REFIX_VERSION` 与 reports 中，用于与历史验收报告对账；**README / QUICKSTART / 挂载指引一律使用定版号**。

| 定版号 | 文件 | 原开发代号 | 内容 | 状态 |
|--------|------|-----------|------|------|
| **V1.01** | `versions/refix-v1.01.js` | v1 / p0.1 | 契约探测 + 基线 + inspect provider + refix_report | 稳定 |
| **V1.02** | `versions/refix-v1.02.js` | v2 / p1.1 | 事件订阅 + 周期巡检 + 五类症状识别 | 稳定 |
| **V1.03** | `versions/refix-v1.03.js` | v3 / p2.1 | 策略表处方 + refix_repair + 观察窗 + 自动回退 | 稳定 |
| **V1.04** | `versions/refix-v1.04.js` | v4 / p3.1 | F4 内存态知识库 + 历史方案复用 + 失败学习 | 稳定 |
| **V1.05** | `versions/refix-v1.05.js` | v5 / p3.2 | P3R 审查修复版 | 稳定 |
| **V1.06** | `versions/refix-v1.06.js` | v6 / p3.3 | P3R2 复检修复版（见 reports/P3R2.md） | 稳定 |
| **V1.07** | `versions/refix-v1.07.js` | v7 / p3.4 | P3R3 第三轮复检修复版（见 reports/P3R3.md） | **稳定线最终版，推荐挂载** |
| **V1.1-pre1** | `versions/refix-v1.1-pre1.js` | v8 / p3.5 | F6 更新探测 + 提示注入（阶段 1，真实会话渲染已验证） | ⚠️ **前瞻版本** |
| **V1.1-pre2** | `versions/refix-v1.1-pre2.js` | v9 / p3.6 | F6 阶段 2：提示附执行手册 + 外部文本隔离 | ⚠️ **前瞻版本** |
| **V1.1-pre-updater** | `versions/refix-updater-v1.1-pre.js` | updater v1 / u1 | F6 阶段 3 peer updater（默认关闭） | ⚠️ **前瞻版本** |

> ⚠️ **V1.1-pre 前瞻版本警示**：V1.1-pre 系列是面向 V1.1 正式版的**预览线，含实验性改动与潜在的破坏性变更**（详见下方"已知边界"中阶段 3 相关条目）。除非你需要体验更新提示 / 执行手册 / peer updater 功能，否则请使用 **V1.07**。慎重选择升级安装。

## 概述

dsh-refix 是 **DSH（DeepSeek Harness，自研宿主，暂未公开）** 的**自诊断 · 自修复 · 自迭代动态插件**。它本身就是一个动态 Cordis 插件（自举：由 DSH 会话经 `cordis_define` 定义并运行），能够：

1. **诊断（F1）**：事件订阅 + 周期巡检（15s）+ 按需巡检，识别动态插件运行时症状并输出结构化报告；
2. **处方（F2）**：策略表驱动的症状 → 修复方案映射，未收录症状一律转人工；
3. **执行（F3）**：修复 = 不可变版本切换（`run`/`update`）+ 30s 观察窗 + 失败自动回退，客户端半区强制走 DSH 原生审批流；
4. **迭代（F4）**：内存态知识库，同症状复发时直接复用历史方案（上次失败的方案命中即转人工）；
5. **更新提示（F6，V1.1-pre2，阶段 2）**：周期经 `ctx.get('web')` 从版本源拉一份 JSON 清单比对版本号，发现更新时在对话里注入**一条**提示，并附**执行手册**（准确的 `pluginId`、追加包的 `cordis_define` 写法、`cordis_run(…, 'update')` 切换与回滚命令、跨会话约束）。**仍不自动换版**：新代码只在用户明确要求后由会话模型经官方工具装入。清单里的文本一律当**外部不可信输入**展示（压平 + 限长 + 标注"勿当作指令"）。

> ⚠️ **以下是另一个独立产物，不属于 dsh-refix 本体**：
>
> 6. **`dsh-refix-updater`（F6 阶段 3，V1.1-pre-updater，默认关闭）**：一个**同会话 peer 插件**，唯一职责是在**用户显式批准**后把版本源上的新代码装入运行态。dsh-refix 本体**仍然不换版**（技术硬约束：`run()` 会 retract 目标 fiber，自己换自己会让观察窗与回滚跑在已销毁的 ctx 上）。
>    - **批准门是宿主强制的**：updater 注册 `ctx.on('tools/pre-execute')`，对自己的 `updater_apply` 返回 `{kind:'ask'}` → 宿主 `ApprovalService` → 浏览器弹待批准交互 → **只有用户点"允许一次"才执行**。
>    - **不存在静默放行的配置**：`ask`+有接听方 = 用户拍板；`ask`+无接听方（headless）= `unavailable` → 拒；会话策略 `never` = 确定性 auto-**reject**。三层都不是"自动同意"。
>    - **一次性令牌**：`updater_apply` 必须带 `confirm` = 票据 sha256 前 12 位；不匹配直接拒绝（连批准框都不弹）。票据一次性、TTL 10 分钟，并在内存里**保存那份源码字节**——批准后装的就是批准时算哈希的那份，不再回网络。
>    - **这是本仓库里唯一"拉网络代码并执行"的能力**，因此**默认关闭**（`UPDATER_ENABLED=false`）。宿主不向插件传 config，启用只能改常量后重新 define 一个包 ⇒ **会话模型无法自行开启它**。
>    - 前置校验（全部在 `define` 之前）：目标指纹 / 非 updater 指纹 / 清单 `latest` 与源码自报 `REFIX_VERSION` 一致 / `file` 必须是仓库内 `versions/*.js` 相对路径 / 尺寸上限。运行态漂移（`currentPackageId` 与票据不符）→ `refused: stale-ticket`。观察窗未通过 → 自动回滚到票据记录的旧包（单向棘轮，只回一次）。

## 硬边界（能力范围）

| # | 约束 |
|---|------|
| B1 | 只管理动态 Cordis 插件（内存中的 Plugin/Package/Run），不触碰宿主仓库文件与核心代码 |
| B2 | 诊断动作只读：仅经 `inventory()` / `snapshot()` / `inspectPlugin()` / `cordis/*` 事件与 `health` 探针获取信息 |
| B3 | 修复动作仅限 `define()` 追加版本 + `run(mode)` 切换 + `stop()` 停止；**绝不调用 `undefine()`** |
| B4 | 客户端半区修复必须走 DSH 原生审批流（`cordis/request-run`），不得绕过 |
| B5 | 不写文件系统；唯一的网络请求是 F6 的清单 GET（只取 JSON 版本号，**不取代码、不执行代码**）。清单内容一律当**外部文本**处理（压平 + 限长 + 不参与指令）。`web` 服务缺席时静默降级为 `web-service-absent` |
| B6 | 版本号严格递增；不可变旧版本即天然回滚点 |

## 诊断策略表（内置）

| 症状指纹 | 检测方法 | 修复策略 | 严重度 |
|---------|---------|---------|-------|
| `run-missing`（run 消失） | inventory 前后 diff + retract 事件 | 重新 run 原版本 | high，可自动修复 |
| `host-method-error`（宿主方法抛错） | `health` 探针 invoke 失败 | stop → run 软重置 | medium，可自动修复 |
| `render-failure`（渲染失败） | run 状态 client-render 错误 | 转人工 | medium |
| `activation-refused`（激活被拒） | 审批拒绝路径 | 转人工，不重试 | manual |
| `activation-failed` / 未知 | 兜底 | 只报告，不动手 | manual |

## 目录结构

```
QUICKSTART.md    # 60 秒上手指南（三步装好 + 高频故障；工具用法/返回值/哈希/回退/五个坑已归入本文件的「使用者参考」）
README.md        # 面向所有人的项目介绍（人性化版）
TECHNICAL.md     # 本文件：机制 / 边界 / 验收 / 已知边界（专业版）
versions/        # 插件版本源码（plain JS 函数体，经 cordis_define 挂载）
  refix-v1.01.js ~ refix-v1.07.js   # 稳定发布线 V1.0x（V1.07 当前推荐）
  refix-v1.1-pre1.js / pre2.js      # ⚠️ 前瞻版本 V1.1-pre（实验性，慎重升级）
  refix-updater-v1.1-pre.js         # ⚠️ 前瞻版本：peer updater（默认关闭）
  manifest.json        # **稳定线**的版本源清单（`latest` 与 REFIX_VERSION 同方案 pX.Y）
                       # channel: "stable"。pre 线**不进入自动提示**：探测只报稳定线，
                       # 想装 pre 版必须由用户明确指名文件（见「已知边界」一节）
  patient-v1.js        # 验收用患者插件（带 health host 方法）
  patient-v2-broken.js # 故障注入夹具（health 必现抛错）
ac/              # 验收脚本（真实 cordis Context + DynamicCordisRunnerService，不 mock runner）
  p0~p3.ac.mts         # 分阶段验收
  p3r.ac.mts           # 审查修复版验收（挂起探针/热更新/自修复拒绝/参数边界）
  p3r2.ac.mts          # 复检修复版验收（过滤/泄漏/处方降级/跨会话/批准路径）
  p3r3.ac.mts          # 第三轮验收（过滤不失盲/通道 B 留档/取消中断）
  ac52.ac.mts          # AC5.2 契约不兼容显式测试（独立进程）
  probe-pre-step.ac.mts # 探针：沙箱内能否挂 agent/pre-step + 手搓消息字段集是否合规
  upd.ac.mts           # V1.1-pre1 更新提示验收（33 项 check）
  upd2.ac.mts          # V1.1-pre2 手册版验收（46 项 check：手册 ID / 外部文本隔离 / 零自升级）
  upd3.ac.mts          # 阶段 3 updater 验收（18 项 check）
  bench.mts            # 共享 bench
reports/         # 分阶段验收报告（P0 / P1 / P2 / P3 / P4 / P3R / P3R2 / P3R3；文件名沿用原开发代号）
deploy/          # 部署辅助：tool-cordis 工具组 overlay（真机冒烟用一次性 patch）
```

## 快速开始

三步，逐字可复制的版本见 **[QUICKSTART.md](./QUICKSTART.md)**：

1. **前提自检**：`dsh web --dump-config | findstr "id: tool-cordis"` —— 有输出才能继续（缺则按下方「部署」加一行）。
2. **取源码**：只下载要装的那一个文件，**不需要克隆整个仓库**：
   `iwr -Uri https://raw.githubusercontent.com/ckk-09/dsh-refix/main/versions/refix-v1.07.js -OutFile "$env:USERPROFILE\refix-v1.07.js"`
3. **挂载**：把 QUICKSTART 第 3 步那段话术贴进 DSH 会话——它含两部分：① "让模型先读文件、把全文原样作为 `code.host` 传入"；② "装好后由模型负责 patrol / report / repair" 的授权句（v1.07 只有 15s 巡检是插件自动的，修复与报告需有人调工具；该授权句把这件事交给会话模型）。

**注意**：`cordis_define` 的 `code.host` 只接受**函数体字符串**（无文件路径参数），因此必须让模型先读取该文件再原文传入；路径给绝对路径。这一跳绕不过去 —— 见「已知边界」的 DSH 硬约束条。

挂载后可用三个模型侧工具：

| 工具 | 说明 |
|------|------|
| `refix_report` | 自诊断报告：兼容性自检（F5）、inventory 基线、诊断报告、修复记录与知识库。只读 |
| `refix_patrol` | 立即执行一轮只读巡检，返回新识别症状 |
| `refix_repair` | 按策略表或历史方案执行修复（版本切换 + 观察窗 + 失败自动回退） |

### 一句话自检

> **「调用 refix_report 给我一份 dsh-refix 的自检报告」**

返回 JSON：`contract`（F5 兼容性自检）、`baseline`（inventory 基线）、`patrolCount`、`recentEvents`、`reports`（诊断报告）、`repairs`（修复记录）、`knowledge`（知识库）。

## 部署（web profile 挂 tool-cordis 工具组）

在 `~/.dsh/profiles/web/cordis.patch.yml` 的既有 `insert:` 列表中追加：

```yaml
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

web profile 的 `patchReload: 'live'` 使该文件**保存即热加载**（config-only HMR，无需重启 dsh web），新会话即拥有 `cordis_*` 工具。运行前提：host-runner 已随 web bundle 挂载（现状已满足）。

> ⚠️ **不要为了"确保它存在"再 insert 一次 `cordis-host-runner`。** 它已由 `@deepseek-ai/dsh-web-app` bundle insert（`packages/bundle/web-app/cordis.patch.yml` L122-123）。patch 是**按层叠加进同一个数组**的（`vendor/include/src/index.ts` L96-101：bundle 层 → 用户 profile 层 → `--patch` 覆盖层），同一数组里出现两个同 id 会在装载时抛 `TypeError`（`vendor/loader/src/config/group.ts` L59-66）→ **`dsh web` 直接启动失败**（`Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: cordis-host-runner`），不是警告。2026-09-17 真机踩过。
>
> 要**改**它（而非加它）用**顶层同 id 覆盖**：`- id: cordis-host-runner` + `config: {...}`（`applyEntryPatches` L110-124 会就地合并；`buildMap(insert)` L96-101 保证前一层的 insert 行可被后一层按 id 命中）。加之前可离线核对：`dsh web --dump-config | findstr "id: cordis-host-runner"`，出现 1 次即已有（该命令在 dsh 起不来时同样可用）。

## 使用者参考（工具用法 / 返回值 / 自证 / 回退 / 常见坑）

> 本节承接 [QUICKSTART.md](./QUICKSTART.md) 精简后的细节。**装法看 QUICKSTART（三步）**，遇到具体问题时回本表查。

### 三个工具怎么用

挂载后会话里多出三个工具。都**只能由模型调用**，使用者只管说话。

#### `refix_report` — 看状态（只读，安全）

| 参数 | 必填 | 说明 |
|------|------|------|
| `limit` | 否 | 只返回最近 N 条 reports/repairs。长会话务必带上（比如 `limit: 5`），否则全量序列化会灌爆上下文 |

| 字段 | 含义 |
|------|------|
| `version` | 当前 `REFIX_VERSION`（V1.07 = `p3.4`） |
| `contract` | `{ ok, missing[] }` — F5 兼容性自检。`ok:false` 时**所有修复动作会被门控拒绝** |
| `baseline` | 当前所有动态插件的基线快照（pluginId / agentId / currentPackageId / activeRun / latestStatus） |
| `patrolCount` | 巡检轮数（每 15s 自动一轮 + 手动触发的） |
| `recentEvents` | 最近收到的 `cordis/*` 事件 |
| `reports` | F1 诊断报告：识别到的症状列表 |
| `repairs` | F3 修复记录：每次修复的动作、结果、观察窗时长 |
| `knowledge` | F4 知识库：`症状\|插件` 指纹 → 有效方案 |

一句话用法：**「调用 refix_report（limit 5）看看现在的诊断状态」**（`refix_report` 也是"挂上了没有"的判据：有返回即成功）

#### `refix_patrol` — 立刻体检一次

| 参数 | 必填 | 说明 |
|------|------|------|
| `pluginId` | 否 | 只**返回**该插件的症状。注意：检测与基线仍然全量推进，不会因为过滤而漏掉别的插件 |

返回：`{ triggered:"manual", onlyPid, newSymptoms[], patrolCount }`

> **同一症状持续期间不会重复报告。** 返回空数组 `newSymptoms: []` 是正常的，说明"没有新问题"，不是坏了。

#### `refix_repair` — 执行修复（会动东西，谨慎）

| 参数 | 必填 | 说明 |
|------|------|------|
| `pluginId` | ✅ | 目标插件 ID |
| `symptom` | 否 | 要修的症状 kind；省略 = 取该插件最近一条报告 |
| `targetPackageId` | 否 | 手动指定修到哪个版本（优先级高于知识库） |
| `observeMs` | 否 | 观察窗毫秒，默认 30000，上限 120000 |

**三条权限红线（是设计，不是 bug）**：
1. 只能修**与调用者同会话**的插件，跨会话直接 `refused: cross-session`
2. **不许修 dsh-refix 自己**（软重置会销毁自身 fiber）→ `refused: self-repair-forbidden`
3. 同一时刻只允许一个修复在跑 → `repair-in-progress`

### 怎么判断修复成功还是失败

`refix_repair` 的返回里 `outcome` 是唯一权威字段。

| `outcome` | 含义 | 该做什么 |
|-----------|------|-----------|
| `success` | 修复成功，观察窗内无症状 | 完事 |
| `awaiting-approval` | ⏸ **不是失败**。目标插件有客户端半区，已自动发起 DSH 原生审批 | 去 DSH 界面上点批准 |
| `failed` | 失败，看 `phase` 细分 | 见下表 |
| `refused` | 未动手，看 `reason` 细分 | 见下表 |

**`failed` 的 phase**：

| phase | 意思 |
|-------|------|
| `precheck` | 动手前就没过：目标版本不存在 / 目标是 dsh-refix 自身 |
| `activation` | 版本切换后激活失败 |
| `rollback` | 修复无效，而且**回退也失败了** —— 最糟的情况，需人工 |
| `repair-invalid` | 修复后症状仍在；有旧版本会已自动回退 |
| `exception` | 执行过程抛异常 |

**`refused` 的 reason**：

| reason | 意思 |
|--------|------|
| `contract-incompatible` | F5 自检不通过（宿主 API 变了），**所有修复被门控** |
| `self-repair-forbidden` | 不许修自己 |
| `repair-in-progress` | 已有修复在跑，等它结束 |
| `cross-session` | 目标插件不属于当前会话 |
| `plugin-not-found` | inventory 里没有这个插件（可能已被删除） |
| `prior-fix-failed` | 知识库里这条方案**上次失败过**，按策略转人工，不重试 |
| `manual-only` | 症状未收录进策略表，只报告不动手 |
| `no-target` | 没有原版本/成功版本可切换 |
| `owner-session-not-live` | 归属会话已下线，拿不到授权 Agent |

> **`manual-only` 是常态，不是缺陷。** 未收录的症状一律转人工——dsh-refix 不生成修复代码。

### 自证：确认装进去的确实是你想装的那一版

为什么要自证：源码是"经会话模型搬运一次"进运行态的（见「已知边界」的 DSH 硬约束条），**没有自动的字节校验**。下列信号都要对，才算装干净：

| 检查点 | 期望值（以 V1.07 为例） |
|---|---|
| dsh 控制台那行 | `dsh-refix p3.4 ready; contract OK ...` |
| `refix_report` 的 `version` | `p3.4` |
| `refix_report` 的 `contract.ok` | `true` |
| `refix_report` 的 `baseline` | 能看到目标插件行（pluginId / currentPackageId） |
| 模型回报的字节数 | 本地读：读到的文件字节数 = 下表值；网络取：回填字节数 ≈ 下表值 |

**哈希核对（只有"先下载再让模型读"这条路做得到，是最硬的证据）**——下载完先跑：

```powershell
Get-FileHash -Algorithm SHA256 "$env:USERPROFILE\refix-v1.07.js"
```

各发布版本文件的参考值（**每个版本文件已冻结、发布后不再修改，所以这些哈希不会变**；若对不上，说明下载被中间人改写或文件被人动过）：

| 文件 | 定版号 | 字节 | sha256 |
|---|---|---|---|
| `refix-v1.07.js` | V1.07（推荐） | 34210 | `8d13fec59465660ae5eb38d3e00ecda19b8d8b7002b6780b9843cf764dadeb88` |
| `refix-v1.1-pre1.js` | V1.1-pre1 ⚠️ | 46076 | `708e2c563d4995c6e8718527993297f7ab8bce27f0ac78d6b6f4f39906fd8969` |
| `refix-v1.1-pre2.js` | V1.1-pre2 ⚠️ | 53124 | `ffbbdf68664a7c28084e3dc42cd00197f7489f07aca19a6c0a95040148831e01` |
| `refix-updater-v1.1-pre.js` | V1.1-pre-updater ⚠️ | 45445 | `9785907a4ba043003262194f34863412642e2285ca868057f31fc29aa0773409` |

> 上表四个哈希已在 2026-09-17 用 GitHub raw 实际下载物逐个复算，与仓库工作区文件逐字节一致（同时排除 CRLF 污染：raw 侧 0 个 `\r\n`）。

### 回退到旧版本

版本链完整保留，V1.01 → V1.07 全部可切。回退 = 换一个 packageId 激活：

```text
用 cordis_define（kind:"existing", pluginId:"<你的 refix pluginId>"）
把 refix-v1.06.js 的内容作为 code.host 追加为新版本，
然后用 cordis_run（mode:"update"）切过去
```

> 注意两点：① 换版**必须在原会话内做**（宿主校验会话归属，跨会话追加必失败）；
> ② 回退同样要**那份源码在会话读得到的位置**——没克隆仓库的话，只下载 `refix-v1.06.js` 那一个文件即可。

因为每个 Package 是**不可变**的，旧版本天然就是回滚点——`cordis_run` 的 `mode` 用 `update` 就能在任意两个版本间来回切。

| 文件 | 定版号 | 内容 |
|------|------|------|
| `refix-v1.01.js` | V1.01 | 骨架：契约探测 + 基线 |
| `refix-v1.02.js` | V1.02 | 诊断：事件订阅 + 巡检 |
| `refix-v1.03.js` | V1.03 | 修复：策略表 + 观察窗 |
| `refix-v1.04.js` | V1.04 | 迭代：知识库 |
| `refix-v1.05.js` | V1.05 | P3R 审查修复（16 缺陷） |
| `refix-v1.06.js` | V1.06 | P3R2 复检修复 |
| **`refix-v1.07.js`** | **V1.07** | **P3R3 复检修复（当前推荐）** |

### 五个必踩的坑

**坑 1：`code.host` 只收函数体字符串，不认文件路径** ⚠️ 最容易卡

`cordis_define` 的 `code.host` 类型是 `string`，描述原文是 *Plain JavaScript function body that returns the Host-half Cordis Plugin.* —— **没有"路径"这种参数**。所以模型必须先读出文件内容、再原文塞进 `code.host`。这意味着：

- **会话必须能读到那个文件**。文件不在会话工作目录下 → 用绝对路径明确告诉它。
- 文件内容本身就是函数体（开头是几行 `//` 注释和 `const`，结尾是 `return { name, inject, apply }`），**原样粘贴即可**，不要包 `function(){}`，不要加 `import`。
- 文件里的 `const REFIX_VERSION` / `SYMPTOMS` 等常量和 `//` 注释都在函数体内，合法。

**坑 2：没有状态指示灯** —— 想知道活着没有：看 dsh 控制台那行 `dsh-refix p3.4 ready; contract OK...`，或喊一句 `refix_report`。

**坑 3：重启即失忆** —— `reports` / `repairs` / `knowledge` 全在**内存**里。dsh web 进程重启后，插件本身要**重新挂载**，之前的知识库与修复记录**全部清零**。这是 V1.0x 的已知边界（持久化在后续计划里）。

**坑 4：它不会自己发朋友圈** —— 插件只是"默默每 15s 巡检 + 记报告"，**不会主动弹消息**。必须主动问（或在挂载话术里授权会话模型替你问，见 QUICKSTART 第 3 步第 6-8 条）。

**坑 5：审批是要你点的** —— 目标插件带客户端半区时，修复返回 `awaiting-approval`，这时**什么都没发生**，等你在 DSH 界面点批准。不点就一直挂着。这是 DSH 原生审批门，不能绕过，也**不要重复发起**。

## 验收矩阵（13/13 AC）

| AC | 内容 | 证据 |
|---|---|---|
| AC1.1 / AC5.1 | 识别患者建基线 / 兼容性自检通过 | `ac/p0.ac.mts` ✅ |
| AC1.2 / AC1.3 | run 消失 / 宿主方法抛错归因 | `ac/p1.ac.mts` ✅ |
| AC2.1 / AC2.2 | restart 方案命中 / 未知症状零动作拒绝 | `ac/p2.ac.mts` ✅ |
| AC3.1~3.3 | 他人不中断 / 新旧对照 / 自动回退 | `ac/p2.ac.mts` ✅ |
| AC3.4 | 原生审批门：拒绝后状态一致、零重试 | `ac/p2.ac.mts` ✅ |
| AC4.1 | 同指纹复发复用历史方案（跳过 F2 有铁证） | `ac/p3.ac.mts` ✅ |
| AC4.2 | 重启失忆为预期行为（知识库无持久化） | 各脚本独立进程 + p3 冷启动断言 ✅ |
| AC5.2 | 契约不兼容 → 差异报告 + 全动作门控 | `ac/ac52.ac.mts` ✅ |

全量回归（2026-09-16）：`p0/p1/p2/p3/p3r/p3r2/p3r3/ac52` 八脚本连跑 **8/8 PASS**（第三方独立复跑复核，非作者自报；关键校验：`p3r2` 五项 checks 全 true，`p3r3` `p1NoBlind/channelBArchived` 为 true、`p4AbortMs=166`，`ac52` 契约不兼容门返回 `contract-incompatible`）。

V1.1-pre1 增量验收（2026-09-16）：`ac/upd.ac.mts` **33/33 check PASS**（web 缺席降级 / 更高版本建 notice / pre-step 注入形状 / 一次性消费 / 同版本不提示 / p3.10>p3.5 段位比较 / 修复主路径回归）；另将 `p3r3.ac.mts` 指向 V1.1-pre1 复跑，仍 `P3R3 SELF-CHECK PASS`（证明 V1.1-pre1 = V1.07 + 纯增量，未伤修复引擎）。

真机会话验收（2026-09-16）：V1.1-pre1 在真实 host + 真实 agent loop + 真实模型下装载，提示被提交进会话记录并进入模型请求面（见"已知边界"末条）。**唯一受控替身是版本源那一跳**（覆盖真 `ctx.web.fetch` 返回固定清单，从而让探测必然命中"有新版本"）。

V1.1-pre2 手册版增量验收（2026-09-16）：`ac/upd2.ac.mts` **46/46 check PASS**。关键项：`VB_text_has_own_plugin_id` / `VB_text_has_rollback_id`（提示里的 ID 来自本地状态——清单里根本没有这些字符串，故同时证明手册非清单驱动）；`VC_*` 外部文本隔离（恶意 notes 的换行/控制字符/指令式 payload 被压平限长、`javascript:` url 被拒、全消息零控制字符）；`VH_own_package_count_stable` + `VH_current_package_unchanged`（**零自升级行为证明**：全流程后 refix 自身包数量与 `currentPackageId` 均不变）。另将 `p3r3.ac.mts` 指向 V1.1-pre2 复跑，仍 `P3R3 SELF-CHECK PASS`（`p1NoBlind/channelBArchived` true、`p4AbortMs=167`）。

阶段 3 复跑回归（2026-09-16，晚）：`p3r3.ac.mts` 指向 V1.1-pre2 复跑（本轮验收期间再次确认）→ `P3R3 SELF-CHECK PASS`（`p1NoBlind=true`、`channelBArchived=true`、`p4AbortMs=153`）。

## 运行验收脚本

验收脚本从本地 DSH checkout 只读导入源码（tsx 直跑），不依赖仓库改动。**先把 `ac/*.mts` 与 `bench.mts` 中 `../../../deepseek-harness` 相对路径改为你的 DSH checkout 位置**（该 import 是**相对 `.mts` 文件本身**解析的，与 cwd 无关），然后在**仓库根目录**执行：

```bash
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p0.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p1.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p2.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p3.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p3r.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p3r2.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p3r3.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/ac52.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/upd.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/upd2.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/upd3.ac.mts
```

`upd3.ac.mts` 会输出插件自带的 `[cordis:…]` 日志，只关心 `PASS/FAIL` 行时可过滤：`... | Where-Object { $_ -notmatch '^\[cordis:' }`。

预期输出各脚本 `SELF-CHECK PASS`。注意脚本末尾 `process.exit(0)`：15s 巡检 interval 会吊住事件循环。

脚本清单与运行提示（V1.0x 线八个：`p0 / p1 / p2 / p3 / p3r / p3r2 / p3r3 / ac52`；F6 线三个：`upd / upd2 / upd3`）：

- Node 建议 ≥ 20（本机实测 v24.20.0）。
- 单跑 `p3r` 约 45s（在等观察窗），别以为卡死了。
- 验收脚本直接用**真实的** Cordis Context + DynamicCordisRunnerService，没有 mock runner。

## 已知边界（如实声明，V1.0x 范围外）

- **F5 能力上限**：契约探测只探"方法存在性"——方法消失/改名可发现；**"名字在、签名变"不可发现**（V-12）
- **权限模型**：修复仅限**与调用者同会话**的插件（`ToolExecutionInput.agent` 比对，跨会话拒绝；N-5）；调用者身份缺失（程序化直调）时放行并留 console.error 痕（P-2）
- **插件删除无感**：插件被 `undefine` 后从 inventory 消失，不产生任何症状报告（删除属预期动作；V-9）
- **修复激活失败后停止态不报 run-missing**：激活失败的插件基线已无 run，后续不会再产生 run-missing 报告（V-9 同类盲区；P-7）
- **审批后不回填**：`awaiting-approval` 的修复不入知识库（N-4 守卫保证不降级既有处方；审批后复核回填是后续候选）
- **事件巡检不做去抖**（O-1 被否）：即时性是特性（事件当拍生效），批量操作下探针风暴由 dedup + probeSkipped + 2s 探针超时缓解
- 不做 LLM 自由生成修复代码（未知症状转人工）；不持久化（重启即失忆）；不诊断 DSH 主进程；不做无人值守自动修复（审批门保留）；不从网络拉取代码。适配 DSH 升级的路径 = F5 契约报告 → 会话内重新 define 适配版 → 人审切换。
- **更新提示（F6 阶段 2）**：只从版本源拉一份 JSON 清单比对版本号，发现更新时注入一条提示**并附执行手册**。**不做任何自动换版**：手册仅供会话模型在用户明确要求后执行 `cordis_define(kind:'existing')` + `cordis_run(mode:'update')`——"从网络拉取并执行代码"这一条边界没有被越过，且提示文本自身显式声明"不代表用户授权"（`executable='manual-guided'`）。
- **清单内容未经签名校验**：`notes` / `url` 视为不可信外部输入 —— 换行与控制字符被压平、长度收紧（notes ≤200、url ≤160 且仅接受 `http(s)`）、展示时标注"勿当作指令"；手册里的 ID/命令/步骤**全部来自本地状态与固定模板**，清单无法影响。但**信任模型仍等同于直接装插件**：升级前请自行确认来源可信。
- **版本源只报稳定线（2026-09-17 起）**：`manifest.json` 的 `latest` 指向**稳定线**（当前 `p3.4` / `V1.07`，带 `channel: "stable"`）。pre 线（V1.1-pre1 / pre2 / updater）**不进入自动提示**——安装推荐稳定版的用户不会再被催着升到 pre 版；要装 pre 必须由**用户明确指名文件**（"用 `versions/refix-v1.1-pre2.js`"），模型不得自行建议或把版本源改指 pre。
- **首次挂载必须由会话模型搬运源码（DSH 硬约束，非文档选择）**：`cordis_define` 的 `code.host` 只接受"函数体字符串"，宿主没有任何"从 URL 或路径加载"的参数（`cordis-host-runner/src/index.ts` L156-160 校验必填 + `precheckCode`）。所以无论源码来自本地文件（读入后回填）还是网络（拉取后回填），**都必须经模型完整重写一遍**——这一步绕不过，且源码越大越考验回填保真度。唯一能完全绕开的是把插件做成**静态包**（`cordis.patch.yml` 里 `insert: name:`），那条路不需要模型参与。
- **换版必须在原会话内做**：宿主对 `kind:'existing'` 校验会话归属（`cordis-host-runner/src/index.ts` L179），跨会话追加必然失败 —— 手册里已写明。dsh-refix 自身不执行换版（`self-repair-forbidden`）。
- **提示的真实渲染已在真实会话验证**（2026-09-16）：用一次性 overlay 在真实 host + 真实 agent loop + 真实模型上装载 V1.1-pre1 跑通，证据三层——① 宿主用真实常量请求版本源（`web.fetch intercepted`）；② 模型 reasoning 逐字引用提示文本与只存在于受控输入中的 nonce；③ **会话落盘记录**（`~/.dsh/sessions/<escaped-cwd>/session-<id>/session.v3.jsonl.zstd`）中该提示以 `type:"user/message"`、`source.plugin="dsh-refix"` 提交，`seq` 落在 `request/header` 之前（已进入模型请求面）。声明：验证中**只有"版本源这一跳"是受控替身**（overlay 覆盖了真 `ctx.web.fetch` 方法返回固定清单），其余路径全真实；源码逐字节未改写。
- **阶段 3（updater）只在 web 会话里可用**：批准门依赖**接听方**。`approval` 服务由 base bundle 无条件挂载（`packages/bundle/base/cordis.patch.yml` L224-227），但**浏览器接听方只在 `web-app` bundle**（同仓库 `packages/bundle/web-app/cordis.patch.yml` L252-253）。headless / 纯 CLI 有服务无接听方 → `unavailable` → **一律拒绝**（安全，但功能不可用）。
- **阶段 3 的批准门已真机全链路验证**（2026-09-16）：headless 真会话 + 真模型 + 真 `cordis-host-runner`，overlay 注入四替身（版本源 / approval 接听方 / 目标种子 / updater 静态装载，源码逐字节不改写——仅 updater 的 `UPDATER_ENABLED` 常量内存单点替换为 true）。三个 run 覆盖三种结局：① **拒绝路径**：宿主 `tools/pre-execute` → `approval/request` 真实触发，reason 形状完整（版本对/sha256/回滚命令/RCE 声明），答案方拒后模型 fail-closed——不重试、不改走手动换版、report 佐证 `executions:[]`；② **放行路径**：答案方独立对"将执行的字节"算 sha256 前 16 位与 reason 比对成立 → `allowed-once` → `define pkg-2` → `run(update)` → 500ms 观察窗存活 → `outcome:success`、票据一次性消费、回滚点 `pkg-1` 完好；③ **无目标路径**：不装目标时 `target-not-found`（同会话防御）。注意：浏览器 `ui-approval` 按钮本身仍未点过（headless 用 approval/request 接听方模拟"用户拍板"，语义等价、跳线不同）；签名边界仍待确认。
- **阶段 3 的全局钩子有爆炸半径**：宿主把动态包挂在 rootCtx 下的 `cordis-dynamic` 组（`cordis-host-runner/src/index.ts` L1238），因此 updater 的 `tools/pre-execute` 钩子是**全局**的，会经过**每个 agent 的每次工具调用**。已按"非 `updater_apply` 一律 `next()` 直通；钩子体任何异常只对本工具 fail-closed、绝不外溢"收口，但这仍是一个应当知晓的架构代价。
- **阶段 3 无清单签名**：哈希绑定只能保证"批准的就是将执行的"（防传递途中替换、防清单与代码不一致）；**不能**保证代码本身可信 —— 清单与源码同源（同一 GitHub 仓库），仓库被控时哈希会与被篡改的代码一起被控。验签扩展位已留在 `PLACEHOLDER_VERIFY_MANIFEST`，阶段 3 恒放行并在输出里显式标注 `unsigned`。**该边界待用户确认接受。**
- **阶段 3 启用是人工动作**：`UPDATER_ENABLED=false` 是源码常量；宿主 `startHostHalf` 不向 `apply` 传 config，所以启用只能"改常量 → 重新 define 一个 updater 包"。好处是会话模型无法自行开启这条 RCE 通道；代价是没有开关 UI。

## 阶段状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 骨架 | 定义+运行、契约探测、inspect provider | ✅ 验收通过 |
| P1 诊断 | 事件订阅 + 周期巡检 + 症状识别 | ✅ 验收通过 |
| P2 修复 | 策略表 + 版本切换 + 观察窗 + 自动回退 | ✅ 验收通过 |
| P3 迭代 | 知识库 + 历史方案复用 + 失败学习 | ✅ 验收通过 |
| P4 收尾 | 全量回归 + 部署说明 + AC 矩阵 | ✅ 验收通过 |
| P3R 审查修复 | 16 缺陷 + 7 优化逐条核验处置（V1.05） | ✅ 验收通过 |
| P3R2 复检修复 | 复检 4 缺陷 + 6 加固（V1.06） | ✅ 验收通过 |
| P3R3 第三轮复检 | 结论更正裁决 + P-1 失盲 + 6 加固（V1.07） | ✅ 验收通过 |
| F6 阶段 1 更新提示 | 版本探测 + `agent/pre-step` 提示注入，**不含自动换版**（V1.1-pre1） | ⏳ 本地 33/33 AC 通过 + **真实会话渲染已验证**，未发布 |
| F6 阶段 2 手册版 | 提示附执行手册（准确 `pluginId` / 回滚 `packageId` / 切换命令 / 跨会话约束）+ 外部文本隔离（V1.1-pre2） | ⏳ 本地 46/46 AC 通过 + p3r3 回归 PASS，未发布 |
| F6 阶段 3 peer updater | 独立插件 `dsh-refix-updater`，宿主 `tools/pre-execute` 强制批准门 + sha256 一次性令牌；**非**全自动——每次都问（默认关闭） | ✅ 18/18 AC + **真机全链路验证**（批准/拒绝/无目标三路径，见"已知边界"）；浏览器按钮跳线未点（headless 以接听方等价模拟）；签名边界待确认；已发布 |

### 阶段 3 的取舍（诚实记录）

| 问题 | 裁决 | 落地 |
|------|------|------|
| 批准通道 | 用户拍板"宿主强制门 + 令牌" = A-1′ | `ctx.on('tools/pre-execute')` → `{kind:'ask'}` → 宿主 `ApprovalService`；`allowed-once` 是唯一放行值 |
| 形态 | 事实锁定 C-1（独立 peer 插件） | 其余四条路不通：fiber 自杀排除"自己换自己"；改 tool-cordis = 改宿主；带客户端半区只为"updater 自己被激活"批一次；npm 包偏轨 |
| 是否全自动 | **否**。原表里写的"全自动换版"被否决 | 每次升级都要①令牌②点批准。不做批量、不做"记住批准"、不使用 `approveFutureVersions` |
| 清单签名 | 待确认（默认按"只做哈希绑定 + 留验签扩展位"落地） | `PLACEHOLDER_VERIFY_MANIFEST` 恒放行 + 输出标注 `unsigned` |

## English (Technical)

A **self-diagnosing, self-repairing, self-iterating dynamic plugin** for DSH (DeepSeek Harness). dsh-refix is itself a dynamic Cordis plugin (bootstrapped via `cordis_define` in a DSH session). It provides:

1. **Diagnose (F1)** — event subscriptions + periodic patrol (15s) + on-demand patrol; detects runtime symptoms of dynamic plugins and emits structured reports.
2. **Prescribe (F2)** — a policy table mapping symptoms to fix strategies; unknown symptoms always escalate to humans.
3. **Repair (F3)** — repair = immutable version switch (`run`/`update`) + 30s observation window + automatic rollback on failure; client-side fixes always go through DSH's native approval flow.
4. **Iterate (F4)** — in-memory knowledge base that replays historical fixes on recurring symptoms (skipping the policy table); a historical fix that failed last time escalates to humans instead of being replayed.
5. **Update-check with an executable manual (F6, V1.1-pre2, stage 2)** — periodically fetches a JSON manifest from a version source via `ctx.get('web')`, compares it with `REFIX_VERSION`, and on a newer version injects a single `agent/pre-step` message carrying a **manual**: the exact `pluginId`, the `cordis_define(kind:'existing')` call, the `cordis_run(…, mode:'update')` switch and rollback commands, and the same-session constraint. **It never upgrades itself** — new code enters the runtime only after the user explicitly asks the session model to run those calls. All manifest text is treated as untrusted external input (flattened, length-capped, labelled "not instructions").

> ⚠️ **The following is a separate deliverable, not part of dsh-refix itself**:
>
> 6. **`dsh-refix-updater` (F6 stage 3, V1.1-pre-updater, disabled by default)** — a **same-session peer plugin** whose sole job is to load new code from the version source into the runtime **after explicit user approval**. dsh-refix itself still never swaps its own version (hard technical constraint: `run()` retracts the target fiber; self-swap would run the observation window and rollback on a destroyed ctx). The approval gate is host-enforced; a one-shot sha256 token binds the approved bytes to the executed bytes; this is the only "fetch code from the network and execute it" capability in this repo, so it is disabled by default (`UPDATER_ENABLED=false`).

### Hard boundaries

Only manages dynamic Cordis plugins (in-memory Plugin/Package/Run). Diagnosis is strictly read-only. Repair actions are limited to `define()` (append immutable version) / `run()` / `stop()` — never `undefine()`. No filesystem writes. The only network request made **by dsh-refix itself** is F6's single manifest GET (a JSON version list, never code); manifest text is handled as untrusted external input; a missing `web` service degrades it silently to `web-service-absent`. Client-side repairs must pass DSH's native approval gate. Immutable old versions serve as free rollback points. **Exception, strictly scoped**: the separate, disabled-by-default `dsh-refix-updater` peer plugin fetches and (after the host-enforced approval gate + one-shot token) executes source code — see item 6 above.

### Quick start

Three steps — copy-paste version in **[QUICKSTART.md](./QUICKSTART.md)**:

1. **Prerequisite check**: `dsh web --dump-config | findstr "id: tool-cordis"` — must print a row before you continue.
2. **Fetch the source**: download just the one file you need — **no need to clone the repo**.
3. **Mount**: paste the mount wording from QUICKSTART step 3. It asks the model to read the file and pass its full text as `code.host`, and authorises the model to run patrol / report / repair on your behalf afterwards (only the 15 s patrol is automatic inside the plugin; reporting and repair require a tool call).

Then the session has the `refix_report` / `refix_patrol` / `refix_repair` tools. One-sentence self-check: **"Call refix_report and show me dsh-refix's self-check report"**.

See the Chinese 「使用者参考」 section above for tool parameters, the `outcome` / `phase` / `reason` tables, hash verification, rollback and the five pitfalls.

Stage-3 acceptance (2026-09-16): `ac/upd3.ac.mts` **18/18 check PASS** on a real cordis Context + real ToolRuntime + real DynamicCordisRunnerService — default-off registers no global hook, the pure-JS SHA-256 matches `node:crypto` bit-for-bit, no approval channel fails closed with zero `define`, token mismatch denies without asking, an approved apply performs a real `define` + `run(update)` + observation window, observation failure rolls back automatically. The browser approval box itself is the one step not yet verified on a real machine.

See the Chinese sections above for the full symptom policy table, acceptance scripts, and stage reports.

## License

[MIT](./LICENSE)
