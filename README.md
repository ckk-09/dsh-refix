# dsh-refix — 给你的 DSH 插件请一位"全科医生"

> **一句话**：它是一个会**自己体检、自己开药、自己记病历**的 DSH 插件保姆，别的插件出事了它先发现，能修的它自己修，修不好它会老实告诉你。

[![GitHub topics](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/ckk-09/dsh-refix) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

**中文** | [English](#english)

---

## 它能帮你做什么？

想象你的 DSH 会话里跑着好几个动态插件。突然某个插件罢工了、报错了、页面渲染挂了——以前你要自己盯、自己查、自己修。现在有了 dsh-refix：

| 就像医生会… | dsh-refix 会… | 背后的能力 |
|---|---|---|
| 🩺 **定期体检** | 每 15 秒 + 出事瞬间自动巡检所有插件，发现"某某插件停了""某某方法报错了" | F1 诊断 |
| 💊 **按方开药** | 每种常见病症都有现成的处理方案，没见过的病症**绝不动手**，只向你报告 | F2 处方 |
| 🏥 **治病留观** | 修复 = 切换到新版本，然后观察 30 秒确认真的好了；没修好**自动退回旧版本**，绝不越修越坏 | F3 执行 |
| 📒 **记住病历** | 同一个毛病第二次犯，直接用上次有效的药方；上次治坏了的方子，它不会再试 | F4 迭代 |
| 📢 **提醒复查** | 出现新版本时在对话里提醒你，并附上**一步步的升级手册**（但绝不擅自升级） | F6 更新提示 |

**三条铁律贯穿始终**：诊断只看不碰、修复绝不删库（永不 `undefine`）、牵涉浏览器的操作必须你亲自点头。

## 三分钟上手

**前提**：你的 DSH 会话里已经有 `cordis_*` 工具（怎么开：见 [QUICKSTART.md](./QUICKSTART.md) 第 0 步）。

**第 1 步**：对 DSH 模型说——

> 用 cordis_define 定义并运行 dsh-refix，宿主半代码取自 `versions/refix-v1.07.js`

**第 2 步**：对模型说——

> 调用 refix_report 给我一份 dsh-refix 的自检报告

看到一坨 JSON？恭喜，医生已经上岗了。接下来它会自动干活，你只需要在它报告症状时决定"修不修"。

**第 3 步（可选）**：想知道某插件现在的健康状况？说"用 refix_patrol 巡检一轮"；想修某个插件？说"用 refix_repair 修复 xxx 插件"。

卡住了？→ [QUICKSTART.md](./QUICKSTART.md) 有完整话术、返回值怎么读、五个必踩的坑。

## 选哪个版本？

### ✅ 稳定版（推荐所有人使用）

| 定版号 | 文件 | 一句话说明 |
|--------|------|-----------|
| V1.01 | `versions/refix-v1.01.js` | 最小骨架：体检报告能用 |
| V1.02 | `versions/refix-v1.02.js` | 加入自动巡检 |
| V1.03 | `versions/refix-v1.03.js` | 会治病了（观察窗 + 自动回退） |
| V1.04 | `versions/refix-v1.04.js` | 会记病历（知识库复用） |
| V1.05 | `versions/refix-v1.05.js` | 第一轮安全大修 |
| V1.06 | `versions/refix-v1.06.js` | 第二轮复检修复 |
| **V1.07** | `versions/refix-v1.07.js` | **第三轮复检修复 —— V1.0x 最终版，推荐挂载这个** |

### ⚠️ 前瞻版本（尝鲜专用，慎重选择升级安装）

> **🚧 警告：以下是 V1.1 的预览版（pre），包含实验性改动与潜在的破坏性变更，随时可能调整甚至回退。**
> **不确定就别用；要试，请先看完 [TECHNICAL.md](./TECHNICAL.md) 的「已知边界」一节。稳定永远选 [V1.07](#-稳定版推荐所有人使用)。**

| 定版号 | 文件 | 新增了什么 | 风险提示 |
|--------|------|-----------|---------|
| V1.1-pre1 | `versions/refix-v1.1-pre1.js` | 更新探测 + 对话内更新提示 | 实验性功能，未正式发布 |
| V1.1-pre2 | `versions/refix-v1.1-pre2.js` | 更新提示附带**可执行手册** + 外部文本隔离 | 同上 |
| V1.1-pre-updater | `versions/refix-updater-v1.1-pre.js` | 独立的"自动装新版"助手（**默认关闭**，每次都需你点批准） | **这是全仓库唯一会"从网络拉代码并执行"的能力**，含实验性破坏，慎重启用 |

## 它不会做什么？（免得你担心）

- ❌ 不会删除任何插件（修复只换版本，旧版本永远留着当后悔药）
- ❌ 不会联网拉代码来执行（唯一的例外是那个默认关闭、每次都要你点"允许一次"的 updater）
- ❌ 不会在你不知情时动你的插件（浏览器半区的操作必须走 DSH 原生审批，你说了算）
- ❌ 不会无中生有编修复方案（没见过的病症只报告，交给人）
- ✅ 重启后"失忆"（病历不落盘）——这是刻意设计：不留任何痕迹在你机器上

## 想深入了解？

| 想知道… | 去看 |
|---|---|
| 一步步怎么装、报错怎么办 | [QUICKSTART.md](./QUICKSTART.md) |
| 全部技术细节：硬边界 B1~B6、诊断策略表、13/13 验收矩阵、8/8 回归、已知边界 | [TECHNICAL.md](./TECHNICAL.md) |
| 每个阶段干了什么、踩过什么坑 | [reports/](./reports/) 目录（P0~P4 + P3R/P3R2/P3R3） |
| 验收怎么跑 | [TECHNICAL.md 的「运行验收脚本」](./TECHNICAL.md#运行验收脚本) |

## License

[MIT](./LICENSE)

---

<a id="english"></a>

# dsh-refix — a "family doctor" for your DSH plugins

> **In one sentence**: a plugin caretaker that **checks health on its own, prescribes its own fixes, and keeps its own medical records**. When another plugin goes down, it notices first, fixes what it safely can, and honestly reports what it can't.

[![GitHub topics](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/ckk-09/dsh-refix) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## What does it do for you?

Imagine several dynamic plugins running inside your DSH session. One crashes, another throws, a third fails to render — previously you had to watch, diagnose and fix everything yourself. With dsh-refix:

| Like a doctor who… | dsh-refix… | Capability |
|---|---|---|
| 🩺 **runs regular check-ups** | patrols every 15s + instantly on events, spotting "plugin X stopped", "method Y throws" | F1 Diagnose |
| 💊 **prescribes from a formulary** | has a ready fix for every known symptom; unknown symptoms are **never touched**, only reported | F2 Prescribe |
| 🏥 **treats, then observes** | a fix = a version switch followed by a 30s observation window; if it didn't hold, it **rolls back automatically** | F3 Repair |
| 📒 **keeps medical records** | a recurring symptom reuses the proven fix; a fix that failed last time is never retried | F4 Iterate |
| 📢 **calls for follow-ups** | injects an update notice with a **step-by-step manual** when a new version exists (never upgrades by itself) | F6 Update-check |

**Three iron rules throughout**: diagnosis is strictly read-only; repair never deletes (never `undefine`); anything touching the browser requires your explicit approval.

## Up and running in 3 minutes

**Prerequisite**: your DSH session already has the `cordis_*` tools (how to enable them: step 0 of [QUICKSTART.md](./QUICKSTART.md)).

**Step 1** — tell the DSH model:

> Define and run dsh-refix via cordis_define, host-side code from `versions/refix-v1.07.js`

**Step 2** — tell the model:

> Call refix_report and show me dsh-refix's self-check report

Seeing a JSON blob? Congratulations — the doctor is on duty. It works automatically from here; you only decide "fix or not" when it reports a symptom.

**Step 3 (optional)**: "Patrol once with refix_patrol" for an instant health check; "Repair plugin X with refix_repair" to fix it.

Stuck? → [QUICKSTART.md](./QUICKSTART.md) has the full wording, how to read `outcome`, and five pitfalls you will hit.

## Which version should I pick?

### ✅ Stable line (recommended for everyone)

| Release | File | In one line |
|---------|------|-------------|
| V1.01 | `versions/refix-v1.01.js` | minimal skeleton: report tool works |
| V1.02 | `versions/refix-v1.02.js` | adds automatic patrol |
| V1.03 | `versions/refix-v1.03.js` | can treat (observe window + auto-rollback) |
| V1.04 | `versions/refix-v1.04.js` | keeps records (knowledge base) |
| V1.05 | `versions/refix-v1.05.js` | first security hardening pass |
| V1.06 | `versions/refix-v1.06.js` | second review-fix pass |
| **V1.07** | `versions/refix-v1.07.js` | **third review-fix pass — final of the V1.0x line, mount this one** |

### ⚠️ Preview line (experimental — upgrade with caution)

> **🚧 Warning: the V1.1-pre series is a preview of V1.1 with experimental, potentially breaking changes, subject to change or rollback at any time.**
> **If unsure, stay on [V1.07](#-stable-line-recommended-for-everyone). If you must try, read the "Known limits" section of [TECHNICAL.md](./TECHNICAL.md) first.**

| Release | File | What's new | Risk note |
|---------|------|-----------|-----------|
| V1.1-pre1 | `versions/refix-v1.1-pre1.js` | update probe + in-conversation update notice | experimental, unreleased |
| V1.1-pre2 | `versions/refix-v1.1-pre2.js` | notice carries a **step-by-step manual** + external-text isolation | same |
| V1.1-pre-updater | `versions/refix-updater-v1.1-pre.js` | separate "install new version" helper (**off by default**, asks for approval every time) | **the only capability in this repo that fetches code from the network and executes it** — experimental, potentially breaking; enable with care |

## What it will NOT do (so you can relax)

- ❌ Never deletes a plugin (repair only switches versions; old versions stay as undo points)
- ❌ Never fetches and executes code from the network (the only exception is the off-by-default updater that asks for your explicit "allow once" every time)
- ❌ Never touches your plugins without your consent (browser-side operations go through DSH's native approval flow — you decide)
- ❌ Never invents fixes (unknown symptoms are reported, handled by a human)
- ✅ Forgets everything on restart (records are not persisted) — by design: nothing is left on your machine

## Want to dig deeper?

| Looking for… | Go to |
|---|---|
| Step-by-step install and troubleshooting | [QUICKSTART.md](./QUICKSTART.md) |
| Full technical detail: boundaries B1~B6, symptom policy table, 13/13 AC matrix, 8/8 regression, known limits | [TECHNICAL.md](./TECHNICAL.md) |
| What each stage did and what pitfalls were hit | [reports/](./reports/) (P0~P4 + P3R/P3R2/P3R3) |
| How to run acceptance | [Run the acceptance scripts](./TECHNICAL.md#运行验收脚本) |

## License

[MIT](./LICENSE)
