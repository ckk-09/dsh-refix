# dsh-refix 上手指南（面向零基础）

> 目标：**从"文件躺在硬盘上"到"dsh 会话里能用三个工具"**，全程只需要复制粘贴两段话。
>
> 适用版本：`versions/refix-v7-p3r3.js`（v7 / p3.4，当前推荐）
> 本文所有命令与结论均于 2026-09-16 在本机实跑验证（8/8 验收脚本 PASS）。

---

## 0. 先确认三个前提

| # | 前提 | 怎么确认 |
|---|------|---------|
| 1 | 你有一个能跑的 DSH，且知道它的安装目录 | 例如 `D:\AI-Workspace\deepseek-harness` |
| 2 | DSH 的 web profile 挂了 **tool-cordis** 工具组 | 打开 `~/.dsh/profiles/web/cordis.patch.yml`，`insert:` 列表里应有 `id: tool-cordis` |
| 3 | 本仓库已克隆到本地 | 例如 `D:\AI-Workspace\workspace\dsh-refix` |

**第 2 条是硬前提。** 没有 `cordis_*` 工具，后面的挂载话术一句也用不了。补法：在 `cordis.patch.yml` 的 `insert:` 下追加（该文件 `patchReload: live`，保存即热加载，新开会话生效）：

```yaml
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

**第 3 条的关键点**：dsh-refix 是"动态插件"，它的源码**必须由会话里的模型读进上下文**才能挂载（原因见第 5 节坑 1）。所以文件得放在模型读得到的地方——放 `D:\AI-Workspace\workspace\dsh-refix\versions\` 下、用绝对路径引用，最省事。

---

## 1. 挂载（复制这段，粘进 DSH 会话）

开一个 DSH 会话，把下面整段发给模型：

```text
请用 cordis_define 定义并运行 dsh-refix，步骤：

1. 先读取文件 D:\AI-Workspace\workspace\dsh-refix\versions\refix-v7-p3r3.js 的全部内容
2. 该文件的全部内容本身就是一段「返回 Cordis Plugin 的 JavaScript 函数体」，
   原样作为 code.host 传入（不要改一个字，不要加 import/export）
3. plugin 参数：kind:"new", idPrefix:"refix"
   name: "dsh-refix"
   purpose: "DSH 自诊断/自修复/自迭代动态插件"
4. 用 cordis_define 返回的 pluginId / packageId 调 cordis_run，mode 用 "run"
5. 把最终的 pluginId 告诉我
```

> **路径要改**：第 1 步的路径换成你自己的实际路径。Windows 路径带反斜杠没问题，别加引号。

---

## 2. 验证挂上了没有

挂载成功后，dsh 进程日志里会出现这样一行（不是模型输出，是宿主控制台）：

```
dsh-refix p3.4 ready; contract OK (兼容性自检通过); baseline plugins: N; patrol every 15000ms
```

然后回到会话，发这句话做一次自检：

```text
调用 refix_report，给我一份 dsh-refix 的自检报告
```

**只要这个调用有返回 → 挂载成功。** 报告里 `contract.ok` 为 `true` 就说明宿主契约齐全（F5 自检通过）。

---

## 3. 三个工具怎么用

挂载后，会话里多出三个工具。都**只能由模型调用**，你只管说话。

### 3.1 `refix_report` — 看状态（只读，安全）

| 参数 | 必填 | 说明 |
|------|------|------|
| `limit` | 否 | 只返回最近 N 条 reports/repairs。长会话务必带上（比如 `limit: 5`），否则全量序列化会灌爆上下文 |

**什么时候用**：想知道"现在有没有问题""之前修过什么""遇到过哪些症状"。

返回字段：

| 字段 | 含义 |
|------|------|
| `version` | `p3.4` |
| `contract` | `{ ok, missing[] }` — F5 兼容性自检。`ok:false` 时**所有修复动作会被门控拒绝** |
| `baseline` | 当前所有动态插件的基线快照（pluginId / agentId / currentPackageId / activeRun / latestStatus） |
| `patrolCount` | 巡检轮数（每 15s 自动一轮 + 手动触发的） |
| `recentEvents` | 最近收到的 `cordis/*` 事件 |
| `reports` | F1 诊断报告：识别到的症状列表 |
| `repairs` | F3 修复记录：每次修复的动作、结果、观察窗时长 |
| `knowledge` | F4 知识库：`症状|插件` 指纹 → 有效方案 |

一句话用法：**「调用 refix_report（limit 5）看看现在的诊断状态」**

### 3.2 `refix_patrol` — 立刻体检一次

| 参数 | 必填 | 说明 |
|------|------|------|
| `pluginId` | 否 | 只**返回**该插件的症状。注意：检测与基线仍然全量推进，不会因为过滤而漏掉别的插件 |

返回：`{ triggered:"manual", onlyPid, newSymptoms[], patrolCount }`

**什么时候用**：你觉得"刚刚好像有插件出问题了"，不想等 15s 的自动巡检。

**要点**：**同一症状持续期间不会重复报告。** 返回空数组 `newSymptoms: []` 是正常的，说明"没有新问题"，不是坏了。

### 3.3 `refix_repair` — 执行修复（会动东西，谨慎）

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

一句话用法：**「对插件 xxx 执行 refix_repair 修复 run-missing」**

---

## 4. 怎么判断成功还是失败

`refix_repair` 的返回里 `outcome` 是唯一权威字段。

| `outcome` | 含义 | 你该做什么 |
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

---

## 5. 五个必踩的坑

### 坑 1：`code.host` 只收**函数体字符串**，不认文件路径 ⚠️ 最容易卡

DSH 的 `cordis_define` 参数里 `code.host` 的类型是 `string`，描述原文：

> *Plain JavaScript function body that returns the Host-half Cordis Plugin.*

它**没有"路径"这种参数**。所以模型必须先读出文件内容、把内容塞进 `code.host`。这意味着：

- **会话必须能读到那个文件**。文件不在会话工作目录下 → 用绝对路径明确告诉它。
- 文件内容本身就是函数体（开头是几行 `//` 注释和 `const`，结尾是 `return { name, inject, apply }`），**原样粘贴即可**，不要包 `function(){}`，不要加 `import`。
- 文件里的 `const REFIX_VERSION` / `SYMPTOMS` 等常量和 `//` 注释都在函数体内，合法。

### 坑 2：没有状态指示灯

DSH 没有给动态插件做"红绿灯"UI。想知道活着没有：

- 看 dsh 控制台那行 `dsh-refix p3.4 ready; contract OK...`
- 或随时喊一句 `refix_report`

### 坑 3：重启即失忆

`reports` / `repairs` / `knowledge` 全在**内存**里，没有持久化。dsh web 进程重启后：

- 插件本身要**重新挂载**（重跑第 1 节的话术）
- 之前学到的知识库、修过的记录 **全部清零**

这是 v1 的已知边界，不是 bug。（持久化在 v2 计划里。）

### 坑 4：它不会自己发朋友圈

dsh-refix 只是"默默在后台每 15s 巡检 + 记报告"。**它不会主动弹消息给你。** 你必须主动问：

- "最近有没有症状？" → `refix_report`
- "现在立刻体检一次" → `refix_patrol`

### 坑 5：审批是要你点的

如果目标插件带客户端半区（浏览器侧），修复会返回 `awaiting-approval`。这时**什么都没发生**，等你在 DSH 界面点批准。不点，就一直挂着。这是 DSH 原生审批门，不能绕过，也**不要重复发起**。

---

## 6. 想回退到旧版本

版本链完整保留，v1 → v7 全部可切。回退 = 换一个 packageId 激活：

```text
用 cordis_define（kind:"existing", pluginId:"<你的 refix pluginId>"）
把 versions/refix-v6-p3r2.js 的内容作为 code.host 追加为新版本，
然后用 cordis_run（mode:"update"）切过去
```

因为每个 Package 是**不可变**的，旧版本天然就是回滚点——`refix_run` 的 `mode` 用 `update` 就能在任意两个版本间来回切。

各版本对应关系：

| 文件 | 版本 | 说明 |
|------|------|------|
| `refix-v1-p0.js` | v1 | 骨架：契约探测 + 基线 |
| `refix-v2-p1.js` | v2 | 诊断：事件订阅 + 巡检 |
| `refix-v3-p2.js` | v3 | 修复：策略表 + 观察窗 |
| `refix-v4-p3.js` | v4 | 迭代：知识库 |
| `refix-v5-p3r.js` | v5 | P3R 审查修复（16 缺陷） |
| `refix-v6-p3r2.js` | v6 | P3R2 复检修复 |
| **`refix-v7-p3r3.js`** | **v7** | **P3R3 复检修复（当前推荐）** |

---

## 7. 想自己跑验收（可选，需要 Node）

```bash
cd <仓库>/ac

# 脚本用相对路径导入 DSH 源码：../../../deepseek-harness
# 若你的 DSH 不在这个相对位置，先改 ac/*.mts 与 bench.mts 顶部的 import 路径

node --import "file:///<DSH-checkout>/node_modules/tsx/dist/loader.mjs" ac/p0.ac.mts
```

八个脚本：`p0 / p1 / p2 / p3 / p3r / p3r2 / p3r3 / ac52`，预期各自输出 `SELF-CHECK PASS`。

- Node 版本建议 ≥ 20（本机实测 v24.20.0）。
- 单跑 `p3r` 约 45s（在等观察窗），别以为卡死了。
- 脚本末尾有 `process.exit(0)`：15s 巡检 interval 会吊住事件循环，没有它退不出来。
- 验收脚本直接用**真实的** Cordis Context + DynamicCordisRunnerService，没有 mock runner。

---

## 8. 常见问题

**Q：模型说"我读不到这个文件"？**
把你的真实路径告诉它，或者把文件复制到会话的当前工作目录下再挂。

**Q：`refix_report` 里 `contract.ok` 是 `false` 怎么办？**
说明 DSH 升级后宿主 API 变了。这时所有修复动作都会被门控拒绝（这是保护，不是故障）。要做的是：看 `contract.missing` 列出缺了哪些方法，把 v7 源码里对应的调用适配后重新 `define` 一个版本再切过去。

**Q：挂上了但 `refix_repair` 总返回 `plugin-not-found`？**
目标插件不在**调用者会话**的 inventory 里。它可能属于别的会话，或者已经被删除。

**Q：能不能让它自动修，不用我管？**
不能。未收录症状一律转人工，客户端半区修复必过审批门。这是硬边界（B4）。

**Q：它会不会改我的 DSH 源码 / 联网 / 写文件？**
不会。源码里 `undefine(` / `fetch(` / `require(` / `process.` 零命中。它只操作内存里的动态插件。

---

## 相关文档

- [README.md](./README.md) —— 完整能力矩阵、策略表、13 条 AC 验收矩阵
- [reports/](./reports/) —— 各阶段验收报告（P0~P4 / P3R / P3R2 / P3R3）
- [versions/](./versions/) —— 全部插件版本源码
