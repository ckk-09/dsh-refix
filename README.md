# dsh-refix

**中文** | [English](#english)

> 🚀 **第一次用？先看 [QUICKSTART.md](./QUICKSTART.md)** —— 面向零基础的上手指南：能不能开箱即用、怎么挂载、三个工具怎么用、`outcome` 怎么读、五个必踩的坑。

dsh-refix 是 **DSH（DeepSeek Harness，自研宿主，暂未公开）** 的**自诊断 · 自修复 · 自迭代动态插件**。它本身就是一个动态 Cordis 插件（自举：由 DSH 会话经 `cordis_define` 定义并运行），能够：

1. **诊断（F1）**：事件订阅 + 周期巡检（15s）+ 按需巡检，识别动态插件运行时症状并输出结构化报告；
2. **处方（F2）**：策略表驱动的症状 → 修复方案映射，未收录症状一律转人工；
3. **执行（F3）**：修复 = 不可变版本切换（`run`/`update`）+ 30s 观察窗 + 失败自动回退，客户端半区强制走 DSH 原生审批流；
4. **迭代（F4）**：内存态知识库，同症状复发时直接复用历史方案（上次失败的方案命中即转人工）；

## 硬边界（能力范围）

| # | 约束 |
|---|------|
| B1 | 只管理动态 Cordis 插件（内存中的 Plugin/Package/Run），不触碰宿主仓库文件与核心代码 |
| B2 | 诊断动作只读：仅经 `inventory()` / `snapshot()` / `inspectPlugin()` / `cordis/*` 事件与 `health` 探针获取信息 |
| B3 | 修复动作仅限 `define()` 追加版本 + `run(mode)` 切换 + `stop()` 停止；**绝不调用 `undefine()`** |
| B4 | 客户端半区修复必须走 DSH 原生审批流（`cordis/request-run`），不得绕过 |
| B5 | 不写文件系统、不发起网络请求 |
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
  refix-v7-p3r3.js     # v7（当前，p3.4）：P3R3 第三轮复检修复版（见 reports/P3R3.md）
  patient-v1.js        # 验收用患者插件（带 health host 方法）
  patient-v2-broken.js # 故障注入夹具（health 必现抛错）
ac/              # 验收脚本（真实 cordis Context + DynamicCordisRunnerService，不 mock runner）
  p0~p3.ac.mts         # 分阶段验收
  p3r.ac.mts           # 审查修复版验收（挂起探针/热更新/自修复拒绝/参数边界）
  p3r2.ac.mts          # 复检修复版验收（过滤/泄漏/处方降级/跨会话/批准路径）
  p3r3.ac.mts          # 第三轮验收（过滤不失盲/通道 B 留档/取消中断）
  ac52.ac.mts          # AC5.2 契约不兼容显式测试（独立进程）
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
```

预期输出各脚本 `SELF-CHECK PASS`。注意脚本末尾 `process.exit(0)`：15s 巡检 interval 会吊住事件循环。

## 已知边界（如实声明，v1 范围外）

- **F5 能力上限**：契约探测只探"方法存在性"——方法消失/改名可发现；**"名字在、签名变"不可发现**（V-12）
- **权限模型**：修复仅限**与调用者同会话**的插件（`ToolExecutionInput.agent` 比对，跨会话拒绝；N-5）；调用者身份缺失（程序化直调）时放行并留 console.error 痕（P-2）
- **插件删除无感**：插件被 `undefine` 后从 inventory 消失，不产生任何症状报告（删除属预期动作；V-9）
- **修复激活失败后停止态不报 run-missing**：激活失败的插件基线已无 run，后续不会再产生 run-missing 报告（V-9 同类盲区；P-7）
- **审批后不回填**：`awaiting-approval` 的修复不入知识库（N-4 守卫保证不降级既有处方；审批后复核回填是 v2 候选）
- **事件巡检不做去抖**（O-1 被否）：即时性是特性（事件当拍生效），批量操作下探针风暴由 dedup + probeSkipped + 2s 探针超时缓解
- 不做 LLM 自由生成修复代码（未知症状转人工）；不持久化（重启即失忆）；不诊断 DSH 主进程；不做无人值守自动修复（审批门保留）；不从网络拉取代码。适配 DSH 升级的路径 = F5 契约报告 → 会话内重新 define 适配版 → 人审切换。

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

### Hard boundaries

Only manages dynamic Cordis plugins (in-memory Plugin/Package/Run). Diagnosis is strictly read-only. Repair actions are limited to `define()` (append immutable version) / `run()` / `stop()` — never `undefine()`. No filesystem writes, no network requests. Client-side repairs must pass DSH's native approval gate. Immutable old versions serve as free rollback points.

### Quick start

In a DSH session, ask the model:

> Define and run dsh-refix via cordis_define, host-side code from `versions/refix-v7-p3r3.js`

See **[QUICKSTART.md](./QUICKSTART.md)** for the beginner-facing guide (mount wording, tool usage, reading `outcome`, common pitfalls).

Then use the `refix_report` / `refix_patrol` / `refix_repair` tools. One-sentence self-check: **"Call refix_report and show me dsh-refix's self-check report"**.

See the Chinese sections above for the full symptom policy table, acceptance scripts, and stage reports.
