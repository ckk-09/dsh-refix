# dsh-refix

**中文** | [English](#english)

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
versions/        # 插件版本源码（plain JS 函数体，经 cordis_define 挂载）
  refix-v1-p0.js       # v1：契约探测 + 基线 + inspect provider + refix_report
  refix-v2-p1.js       # v2：事件订阅 + 周期巡检 + 五类症状识别
  refix-v3-p2.js       # v3：策略表处方 + refix_repair + 观察窗 + 自动回退
  refix-v4-p3.js       # v4（当前）：F4 内存态知识库 + 历史方案复用 + 失败学习
  patient-v1.js        # 验收用患者插件（带 health host 方法）
  patient-v2-broken.js # 故障注入夹具（health 必现抛错）
ac/              # 验收脚本（真实 cordis Context + DynamicCordisRunnerService，不 mock runner）
  p0~p3.ac.mts         # 分阶段验收
  ac52.ac.mts          # AC5.2 契约不兼容显式测试（独立进程）
  bench.mts            # 共享 bench
reports/         # 分阶段验收报告（P0 / P1 / P2 / P3 / P4）
deploy/          # 部署辅助：tool-cordis 工具组 overlay（真机冒烟用一次性 patch）
```

## 快速开始

在 DSH 会话中对模型说：

> 用 cordis_define 定义并运行 dsh-refix，宿主半代码取自 `versions/refix-v4-p3.js`

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

全量回归（2026-09-16）：`p0/p1/p2/p3` 四脚本连跑 **4/4 PASS**。

## 运行验收脚本

验收脚本从本地 DSH checkout 只读导入源码（tsx 直跑），不依赖仓库改动。先把 `ac/*.mts` 与 `bench.mts` 中 `../../../deepseek-harness` 相对路径改为你的 DSH checkout 位置，然后：

```bash
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p0.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p1.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p2.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p3.ac.mts
node --import "file://<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/ac52.ac.mts
```

预期输出 `P0/P1/P2/P3 SELF-CHECK PASS` 与 `AC5.2 SELF-CHECK PASS`。注意脚本末尾 `process.exit(0)`：15s 巡检 interval 会吊住事件循环。

## 阶段状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 骨架 | 定义+运行、契约探测、inspect provider | ✅ 验收通过 |
| P1 诊断 | 事件订阅 + 周期巡检 + 症状识别 | ✅ 验收通过 |
| P2 修复 | 策略表 + 版本切换 + 观察窗 + 自动回退 | ✅ 验收通过 |
| P3 迭代 | 知识库 + 历史方案复用 + 失败学习 | ✅ 验收通过 |
| P4 收尾 | 全量回归 + 部署说明 + AC 矩阵 | ✅ 验收通过 |

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

> Define and run dsh-refix via cordis_define, host-side code from `versions/refix-v4-p3.js`

Then use the `refix_report` / `refix_patrol` / `refix_repair` tools. One-sentence self-check: **"Call refix_report and show me dsh-refix's self-check report"**.

See the Chinese sections above for the full symptom policy table, acceptance scripts, and stage reports.
