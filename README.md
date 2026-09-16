# dsh-refix

**中文** | [English](#english)

> 🚀 **第一次用？先看 [QUICKSTART.md](./QUICKSTART.md)** —— 面向零基础的上手指南：能不能开箱即用、怎么挂载、三个工具怎么用、`outcome` 怎么读、五个必踩的坑。

dsh-refix 是 **DSH（DeepSeek Harness，自研宿主，暂未公开）** 的**自诊断 · 自修复 · 自迭代动态插件**。它本身就是一个动态 Cordis 插件（自举：由 DSH 会话经 `cordis_define` 定义并运行），能够：

1. **诊断（F1）**：事件订阅 + 周期巡检（15s）+ 按需巡检，识别动态插件运行时症状并输出结构化报告；
2. **处方（F2）**：策略表驱动的症状 → 修复方案映射，未收录症状一律转人工；
3. **执行（F3）**：修复 = 不可变版本切换（`run`/`update`）+ 30s 观察窗 + 失败自动回退，客户端半区强制走 DSH 原生审批流；
4. **迭代（F4）**：内存态知识库，同症状复发时直接复用历史方案（上次失败的方案命中即转人工）；
5. **更新提示（F6，v9 = p3.6，阶段 2）**：周期经 `ctx.get('web')` 从版本源拉一份 JSON 清单比对版本号，发现更新时在对话里注入**一条**提示，并附**执行手册**（准确的 `pluginId`、追加包的 `cordis_define` 写法、`cordis_run(…, 'update')` 切换与回滚命令、跨会话约束）。**仍不自动换版**：新代码只在用户明确要求后由会话模型经官方工具装入。清单里的文本一律当**外部不可信输入**展示（压平 + 限长 + 标注"勿当作指令"）。

> ⚠️ **以下是另一个独立产物，不属于 dsh-refix 本体**：
>
> 6. **`dsh-refix-updater`（F6 阶段 3，v1/u1，默认关闭）**：一个**同会话 peer 插件**（`versions/refix-updater-v1.js`），唯一职责是在**用户显式批准**后把版本源上的新代码装入运行态。dsh-refix 本体**仍然不换版**（技术硬约束：`run()` 会 retract 目标 fiber，自己换自己会让观察窗与回滚跑在已销毁的 ctx 上）。
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
QUICKSTART.md    # 零基础上手指南（挂载 / 工具用法 / 返回值解读 / 常见坑）
versions/        # 插件版本源码（plain JS 函数体，经 cordis_define 挂载）
  refix-v1-p0.js       # v1：契约探测 + 基线 + inspect provider + refix_report
  refix-v2-p1.js       # v2：事件订阅 + 周期巡检 + 五类症状识别
  refix-v3-p2.js       # v3：策略表处方 + refix_repair + 观察窗 + 自动回退
  refix-v4-p3.js       # v4：F4 内存态知识库 + 历史方案复用 + 失败学习
  refix-v5-p3r.js      # v5：P3R 审查修复版
  refix-v6-p3r2.js     # v6：P3R2 复检修复版（见 reports/P3R2.md）
  refix-v7-p3r3.js     # v7（当前挂载推荐，p3.4）：P3R3 第三轮复检修复版（见 reports/P3R3.md）
  refix-v8-upd.js      # v8（p3.5）：F6 更新探测 + 提示注入（阶段 1；**真实会话渲染已验证** 2026-09-16）
  refix-v9-upd2.js     # v9（p3.6，待发布）：F6 阶段 2 —— 提示附执行手册 + 外部文本隔离（仍不自动换版）
  manifest.json        # v8 起的版本源清单（`latest` 与 REFIX_VERSION 同方案 pX.Y）
  refix-updater-v1.js  # F6 阶段 3：peer updater（独立插件，idPrefix `refupd`，默认关闭；宿主批准门 + 一次性令牌）
  patient-v1.js        # 验收用患者插件（带 health host 方法）
  patient-v2-broken.js # 故障注入夹具（health 必现抛错）
ac/              # 验收脚本（真实 cordis Context + DynamicCordisRunnerService，不 mock runner）
  p0~p3.ac.mts         # 分阶段验收
  p3r.ac.mts           # 审查修复版验收（挂起探针/热更新/自修复拒绝/参数边界）
  p3r2.ac.mts          # 复检修复版验收（过滤/泄漏/处方降级/跨会话/批准路径）
  p3r3.ac.mts          # 第三轮验收（过滤不失盲/通道 B 留档/取消中断）
  ac52.ac.mts          # AC5.2 契约不兼容显式测试（独立进程）
  probe-pre-step.ac.mts # 探针：沙箱内能否挂 agent/pre-step + 手搓消息字段集是否合规
  upd.ac.mts           # v8 更新提示验收（33 项 check）
  upd2.ac.mts          # v9 手册版验收（46 项 check：手册 ID / 外部文本隔离 / 零自升级）
  bench.mts            # 共享 bench
reports/         # 分阶段验收报告（P0 / P1 / P2 / P3 / P4 / P3R / P3R2 / P3R3）
deploy/          # 部署辅助：tool-cordis 工具组 overlay（真机冒烟用一次性 patch）
```

## 快速开始

在 DSH 会话中对模型说：

> 用 cordis_define 定义并运行 dsh-refix，宿主半代码取自 `versions/refix-v7-p3r3.js`

**注意**：`cordis_define` 的 `code.host` 只接受**函数体字符串**（无文件路径参数），因此需让模型先读取该文件再原文传入；路径建议给绝对路径。完整话术与逐项排错见 **[QUICKSTART.md](./QUICKSTART.md)**。

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

v8 增量验收（2026-09-16）：`ac/upd.ac.mts` **33/33 check PASS**（web 缺席降级 / 更高版本建 notice / pre-step 注入形状 / 一次性消费 / 同版本不提示 / p3.10>p3.5 段位比较 / 修复主路径回归）；另将 `p3r3.ac.mts` 指向 v8 复跑，仍 `P3R3 SELF-CHECK PASS`（证明 v8 = v7 + 纯增量，未伤修复引擎）。

真机会话验收（2026-09-16）：v8 在真实 host + 真实 agent loop + 真实模型下装载，提示被提交进会话记录并进入模型请求面（见"已知边界"末条）。**唯一受控替身是版本源那一跳**（覆盖真 `ctx.web.fetch` 返回固定清单，从而让探测必然命中"有新版本"）。

v9 手册版增量验收（2026-09-16）：`ac/upd2.ac.mts` **46/46 check PASS**。关键项：`VB_text_has_own_plugin_id` / `VB_text_has_rollback_id`（提示里的 ID 来自本地状态——清单里根本没有这些字符串，故同时证明手册非清单驱动）；`VC_*` 外部文本隔离（恶意 notes 的换行/控制字符/指令式 payload 被压平限长、`javascript:` url 被拒、全消息零控制字符）；`VH_own_package_count_stable` + `VH_current_package_unchanged`（**零自升级行为证明**：全流程后 refix 自身包数量与 `currentPackageId` 均不变）。另将 `p3r3.ac.mts` 指向 v9 复跑，仍 `P3R3 SELF-CHECK PASS`（`p1NoBlind/channelBArchived` true、`p4AbortMs=167`）。

阶段 3 复跑回归（2026-09-16，晚）：`p3r3.ac.mts` 指向 v9 复跑（本轮验收期间再次确认）→ `P3R3 SELF-CHECK PASS`（`p1NoBlind=true`、`channelBArchived=true`、`p4AbortMs=153`）。

## 运行验收脚本

验收脚本从本地 DSH checkout 只读导入源码（tsx 直跑），不依赖仓库改动。先把 `ac/*.mts` 与 `bench.mts` 中 `../../../deepseek-harness` 相对路径改为你的 DSH checkout 位置，然后：

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

## 已知边界（如实声明，v1 范围外）

- **F5 能力上限**：契约探测只探"方法存在性"——方法消失/改名可发现；**"名字在、签名变"不可发现**（V-12）
- **权限模型**：修复仅限**与调用者同会话**的插件（`ToolExecutionInput.agent` 比对，跨会话拒绝；N-5）；调用者身份缺失（程序化直调）时放行并留 console.error 痕（P-2）
- **插件删除无感**：插件被 `undefine` 后从 inventory 消失，不产生任何症状报告（删除属预期动作；V-9）
- **修复激活失败后停止态不报 run-missing**：激活失败的插件基线已无 run，后续不会再产生 run-missing 报告（V-9 同类盲区；P-7）
- **审批后不回填**：`awaiting-approval` 的修复不入知识库（N-4 守卫保证不降级既有处方；审批后复核回填是 v2 候选）
- **事件巡检不做去抖**（O-1 被否）：即时性是特性（事件当拍生效），批量操作下探针风暴由 dedup + probeSkipped + 2s 探针超时缓解
- 不做 LLM 自由生成修复代码（未知症状转人工）；不持久化（重启即失忆）；不诊断 DSH 主进程；不做无人值守自动修复（审批门保留）；不从网络拉取代码。适配 DSH 升级的路径 = F5 契约报告 → 会话内重新 define 适配版 → 人审切换。
- **更新提示（F6 阶段 2）**：只从版本源拉一份 JSON 清单比对版本号，发现更新时注入一条提示**并附执行手册**。**不做任何自动换版**：手册仅供会话模型在用户明确要求后执行 `cordis_define(kind:'existing')` + `cordis_run(mode:'update')`——"从网络拉取并执行代码"这一条边界没有被越过，且提示文本自身显式声明"不代表用户授权"（`executable='manual-guided'`）。
- **清单内容未经签名校验**：`notes` / `url` 视为不可信外部输入 —— 换行与控制字符被压平、长度收紧（notes ≤200、url ≤160 且仅接受 `http(s)`）、展示时标注"勿当作指令"；手册里的 ID/命令/步骤**全部来自本地状态与固定模板**，清单无法影响。但**信任模型仍等同于直接装插件**：升级前请自行确认来源可信。
- **换版必须在原会话内做**：宿主对 `kind:'existing'` 校验会话归属（`cordis-host-runner/src/index.ts` L179），跨会话追加必然失败 —— 手册里已写明。dsh-refix 自身不执行换版（`self-repair-forbidden`）。
- **提示的真实渲染已在真实会话验证**（2026-09-16）：用一次性 overlay 在真实 host + 真实 agent loop + 真实模型上装载 v8 跑通，证据三层——① 宿主用真实常量请求版本源（`web.fetch intercepted`）；② 模型 reasoning 逐字引用提示文本与只存在于受控输入中的 nonce；③ **会话落盘记录**（`~/.dsh/sessions/<escaped-cwd>/session-<id>/session.v3.jsonl.zstd`）中该提示以 `type:"user/message"`、`source.plugin="dsh-refix"` 提交，`seq` 落在 `request/header` 之前（已进入模型请求面）。声明：验证中**只有"版本源这一跳"是受控替身**（overlay 覆盖了真 `ctx.web.fetch` 方法返回固定清单），其余路径全真实；v8 源码逐字节未改写。

- **阶段 3（updater）只在 web 会话里可用**：批准门依赖**接听方**。`approval` 服务由 base bundle 无条件挂载（`packages/bundle/base/cordis.patch.yml` L224-227），但**浏览器接听方只在 `web-app` bundle**（同仓库 `packages/bundle/web-app/cordis.patch.yml` L252-253）。headless / 纯 CLI 有服务无接听方 → `unavailable` → **一律拒绝**（安全，但功能不可用）。
- **阶段 3 的批准框本身未真机验证**：验收跑的是真 host 代码路径（真 `ToolRuntime.execute` → 真 `tools/pre-execute` waterfall → 真 `serviceAsk`）与真 ApprovalService **seam**（`ctx.provide('approval', …)`），**没有**真的开浏览器点 `ui-approval` 的按钮。这一条是本轮唯一未闭环的验证。
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
| P3R 审查修复 | 16 缺陷 + 7 优化逐条核验处置（v5 = p3.2） | ✅ 验收通过 |
| P3R2 复检修复 | 复检 4 缺陷 + 6 加固（v6 = p3.3） | ✅ 验收通过 |
| P3R3 第三轮复检 | 结论更正裁决 + P-1 失盲 + 6 加固（v7 = p3.4） | ✅ 验收通过 |
| F6 阶段 1 更新提示 | 版本探测 + `agent/pre-step` 提示注入，**不含自动换版**（v8 = p3.5） | ⏳ 本地 33/33 AC 通过 + **真实会话渲染已验证**，未发布 |
| F6 阶段 2 手册版 | 提示附执行手册（准确 `pluginId` / 回滚 `packageId` / 切换命令 / 跨会话约束）+ 外部文本隔离（v9 = p3.6） | ⏳ 本地 46/46 AC 通过 + p3r3 回归 PASS，未发布 |
| F6 阶段 3 peer updater | 独立插件 `dsh-refix-updater`（u1），宿主 `tools/pre-execute` 强制批准门 + sha256 一次性令牌；**非**全自动——每次都问（`versions/refix-updater-v1.js`，默认关闭） | ⏳ 本地 18/18 AC 通过；**批准框未真机验证**；签名边界待确认；未发布 |

### 阶段 3 的取舍（诚实记录）

| 问题 | 裁决 | 落地 |
|------|------|------|
| 批准通道 | 用户拍板"宿主强制门 + 令牌" = A-1′ | `ctx.on('tools/pre-execute')` → `{kind:'ask'}` → 宿主 `ApprovalService`；`allowed-once` 是唯一放行值 |
| 形态 | 事实锁定 C-1（独立 peer 插件） | 其余四条路不通：fiber 自杀排除"自己换自己"；改 tool-cordis = 改宿主；带客户端半区只为"updater 自己被激活"批一次；npm 包偏轨 |
| 是否全自动 | **否**。原表里写的"全自动换版"被否决 | 每次升级都要①令牌②点批准。不做批量、不做"记住批准"、不使用 `approveFutureVersions` |
| 清单签名 | 待确认（默认按"只做哈希绑定 + 留验签扩展位"落地） | `PLACEHOLDER_VERIFY_MANIFEST` 恒放行 + 输出标注 `unsigned` |


## License

[MIT](./LICENSE)

---

<a id="english"></a>

# dsh-refix (English)

A **self-diagnosing, self-repairing, self-iterating dynamic plugin** for DSH (DeepSeek Harness). dsh-refix is itself a dynamic Cordis plugin (bootstrapped via `cordis_define` in a DSH session). It provides:

1. **Diagnose (F1)** — event subscriptions + periodic patrol (15s) + on-demand patrol; detects runtime symptoms of dynamic plugins and emits structured reports.
2. **Prescribe (F2)** — a policy table mapping symptoms to fix strategies; unknown symptoms always escalate to humans.
3. **Repair (F3)** — repair = immutable version switch (`run`/`update`) + 30s observation window + automatic rollback on failure; client-side fixes always go through DSH's native approval flow.
4. **Iterate (F4)** — in-memory knowledge base that replays historical fixes on recurring symptoms (skipping the policy table); a historical fix that failed last time escalates to humans instead of being replayed.
5. **Update-check with an executable manual (F6, v9 / p3.6, stage 2)** — periodically fetches a JSON manifest from a version source (GitHub raw) via `ctx.get('web')`, compares it with `REFIX_VERSION`, and on a newer version injects a single `agent/pre-step` message carrying a **manual**: the exact `pluginId`, the `cordis_define(kind:'existing')` call, the `cordis_run(…, mode:'update')` switch and rollback commands, and the same-session constraint. **It never upgrades itself** — new code enters the runtime only after the user explicitly asks the session model to run those calls. All manifest text is treated as untrusted external input (flattened, length-capped, labelled "not instructions").

> ⚠️ **The following is a separate deliverable, not part of dsh-refix itself**:
>
> 6. **`dsh-refix-updater` (F6 stage 3, v1/u1, disabled by default)** — a **same-session peer plugin** (`versions/refix-updater-v1.js`) whose sole job is to load new code from the version source into the runtime **after explicit user approval**. dsh-refix itself still never swaps its own version (hard technical constraint: `run()` retracts the target fiber; self-swap would run the observation window and rollback on a destroyed ctx).
>    - **The approval gate is host-enforced**: the updater registers `ctx.on('tools/pre-execute')` and answers its own `updater_apply` with `{kind:'ask'}` → the host `ApprovalService` → the browser surfaces an approval interaction → **only an explicit "allow once" proceeds**.
>    - **No configuration can silently pass the gate**: `ask` with an answerer = the user decides; `ask` without one (headless) = `unavailable` → denied; session policy `never` = deterministic auto-**reject**.
>    - **One-shot token**: `updater_apply` must carry `confirm` = first 12 hex chars of the ticket's sha256; mismatch → denied before the approval box is even raised. Tickets are single-use, TTL 10 min, and keep the exact source bytes in memory — what gets installed is precisely what was hashed at approval time, no second network round-trip.
>    - **This is the only "fetch code from the network and execute it" capability in this repo**, so it is **disabled by default** (`UPDATER_ENABLED=false`). The host does not pass config to plugin `apply`, so enabling means editing the constant and re-defining a package ⇒ **the session model cannot switch it on by itself**.
>    - Pre-checks (all before `define`): target fingerprint / no updater fingerprint / manifest `latest` matches the source's self-reported `REFIX_VERSION` / `file` must be an in-repo `versions/*.js` relative path / size cap. Runtime drift (`currentPackageId` ≠ ticket) → `refused: stale-ticket`. Observation-window failure → automatic rollback to the ticket's recorded old package (single-shot ratchet).

### Hard boundaries

Only manages dynamic Cordis plugins (in-memory Plugin/Package/Run). Diagnosis is strictly read-only. Repair actions are limited to `define()` (append immutable version) / `run()` / `stop()` — never `undefine()`. No filesystem writes. The only network request made **by dsh-refix itself** is F6's single manifest GET (a JSON version list, never code); manifest text is handled as untrusted external input; a missing `web` service degrades it silently to `web-service-absent`. Client-side repairs must pass DSH's native approval gate. Immutable old versions serve as free rollback points. **Exception, strictly scoped**: the separate, disabled-by-default `dsh-refix-updater` peer plugin fetches and (after the host-enforced approval gate + one-shot token) executes source code — see item 6 above.

### Quick start

In a DSH session, ask the model:

> Define and run dsh-refix via cordis_define, host-side code from `versions/refix-v7-p3r3.js`

See **[QUICKSTART.md](./QUICKSTART.md)** for the beginner-facing guide (mount wording, tool usage, reading `outcome`, common pitfalls).

Then use the `refix_report` / `refix_patrol` / `refix_repair` tools. One-sentence self-check: **"Call refix_report and show me dsh-refix's self-check report"**.

Stage-3 acceptance (2026-09-16): `ac/upd3.ac.mts` **18/18 check PASS** on a real cordis Context + real ToolRuntime + real DynamicCordisRunnerService — default-off registers no global hook, the pure-JS SHA-256 matches `node:crypto` bit-for-bit, no approval channel fails closed with zero `define`, token mismatch denies without asking, an approved apply performs a real `define` + `run(update)` + observation window, observation failure rolls back automatically. The browser approval box itself is the one step not yet verified on a real machine.

See the Chinese sections above for the full symptom policy table, acceptance scripts, and stage reports.
