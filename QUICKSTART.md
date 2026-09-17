# dsh-refix 上手指南（60 秒版）

> 目标：**一条命令装好**，之后由 dsh 里的模型替你照看它。
>
> 适用版本：静态包 **V1.2**（`dsh-refix-1.2.0.tgz`）—— 插件逻辑同 V1.07（自报 `p3.4`）。
> 本页只讲"怎么装上"；工具参数、返回值含义、哈希核对、回退、全部坑 → 见 **[TECHNICAL.md](./TECHNICAL.md) 的「使用者参考」一节**。
> 本页命令与结论于 2026-09-16 / 09-17 在本机实跑验证（离线 34/34 + 35/35、三次真机启动 PASS）。

---

## 方式 A（推荐）：一条命令装静态包

这条路**什么前提都不需要**：不用检查 profile 缺不缺工具组，不用下载源码，不用贴挂载话术。
（已实测：装它的 profile 里 `tool-cordis` 根本不存在，插件照样正常起来。）

### 第 1 步 · 装

```bash
dsh plugin --profile web add https://raw.githubusercontent.com/ckk-09/dsh-refix/main/deploy/static/dist/dsh-refix-1.2.0.tgz
```

- `web` 是 profile 名；不确定就用 `web`。
- 直连失败就给终端挂代理。也可以先把 tgz 下到本地，再：
  `dsh plugin --profile web add "<本地 tgz 的绝对路径>"`
- 这条命令走 pnpm 装包，并会把 `dsh-refix` **自动加进该 profile 的 bundles** —— 你不需要改任何配置文件。

### 第 2 步 · 正常启动 dsh

没有额外步骤。插件**随启动自动加载**。

### 第 3 步 · 看到这一行就成了

```
dsh-refix p3.4 ready; contract OK (兼容性自检通过); baseline plugins: N; patrol every 15000ms
```

看到它就说明插件已起来、15s 巡检已开始。

### 不想用了

```bash
dsh plugin --profile web remove dsh-refix
```

bundles 里的那条会自动摘掉。

---

## 方式 B：动态包（要热切换 / 回退版本时用）

静态包换版本得重装；**动态包能在会话里随时换版本、一键回退**。代价是多一个前提 + 多两步操作。

### 第 1 步 · 前提自检（只有方式 B 需要）

```bash
dsh web --dump-config | findstr "id: tool-cordis"
```

- **有输出** → 直接下一步。
- **没输出** → 你的 web profile 缺 `tool-cordis` 工具组（没有它，第 3 步那段话术一句也用不了）。照 [TECHNICAL.md「部署」](./TECHNICAL.md) 加**一行**，重跑本命令确认后再继续。

> ⚠️ 只加 `tool-cordis` 那一行。**不要顺手加 `cordis-host-runner`** —— web profile 自带它，加重复会让 `dsh web` **直接起不来**（报 `duplicate loader entry id`）。原因与救援方式见 TECHNICAL.md 部署节的警告。

### 第 2 步 · 下载源码（复制这一行）

Windows PowerShell：

```powershell
iwr -Uri https://raw.githubusercontent.com/ckk-09/dsh-refix/main/versions/refix-v1.07.js -OutFile "$env:USERPROFILE\refix-v1.07.js"
```

或系统自带 curl：

```bash
curl.exe -fsSL -o "%USERPROFILE%\refix-v1.07.js" https://raw.githubusercontent.com/ckk-09/dsh-refix/main/versions/refix-v1.07.js
```

记下落盘路径（例：`C:\Users\你的名字\refix-v1.07.js`）。直连失败就给终端挂代理。

### 第 3 步 · 粘给 dsh（复制这一段）

把话术第一行的 `<你的文件完整路径>` 换成上一步的**完整路径**（含文件名、必须是绝对路径、不加引号）：

```text
请帮我装一个 DSH 插件 dsh-refix，装好后由你负责照看它。

一、安装
1. 先读取文件 <你的文件完整路径> 的全部内容
2. 该文件内容本身就是一段「返回 Cordis Plugin 的 JavaScript 函数体」，
   原样作为 code.host 传入（一个字都别改，不要加 import/export）
3. plugin 参数：kind:"new", idPrefix:"refix"
   name: "dsh-refix"
   purpose: "DSH 自诊断/自修复/自迭代动态插件"
4. 用 cordis_define 返回的 pluginId / packageId 调 cordis_run，mode 用 "run"
5. 告诉我 pluginId，并回报你读到的文件字节数

二、装好后由你（模型）负责照看它，不用我每次提醒
6. 本次会话先调一次 refix_patrol，有新症状就汇报
7. 之后我说"看看插件情况"时，调 refix_report（limit 5）汇报
8. 巡检到可修症状（run-missing / host-method-error）时直接调 refix_repair 修好，
   然后把 outcome 和做了什么告诉我；需要我点批准的，明确说"去界面点同意"
9. 遇到 manual-only 或未收录症状，只报告，不要自己写修复代码
```

**装好的标志**：和方式 A 是同一行就绪行（见上）。

> **顺手核一个数**：V1.07 的源码是 **34210** 字节 —— 第 3 步第 5 条让模型回报的字节数就该是这个。对不上，或想核对 sha256 → TECHNICAL.md「使用者参考 → 自证」。

---

## 关于"自动"，先说清楚

| 行为 | 实际是谁在做 |
|---|---|
| 每 15s 巡检 + 记账 | **插件自己**，真自动 |
| 出报告、执行修复 | 授权给了**会话模型**；你开口就行，不用记工具名 |
| 主动弹消息给你 | **不会**。插件不主动说话；想知道情况就问模型 |

⚠️ **方式 B（动态包）在 dsh 重启后要重新装**（话术再粘一次）：动态插件的状态全在内存里，进程一重启就清零。
**方式 A（静态包）不受影响** —— 它跟着 profile 落盘，重启后自动加载。

---

## 出问题再看

**装静态包时 `dsh plugin add` 下载失败** → 到 `raw.githubusercontent.com` 的网络不通，挂代理；或先把 tgz 下到本地，再用本地路径装（见方式 A 第 1 步）。

**装完启动后没看到就绪行** → 先确认装到了**你正在启动的那个 profile**（`dsh plugin --profile X add` 的 `X` 要和 `dsh --profile X` 对得上）。再看控制台有没有 `[refix] 静态包：未能解析 …`：那行只是说明宿主工具包没解析到、schema 走了内置编译器，**不影响巡检**；要消除它，确认 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` 存在。

**模型说"我读不到这个文件"**（方式 B）→ 给它**完整绝对路径**，别用相对路径。或者干脆不下载：把第 3 步第 1 条换成——"用 web_fetch 抓 `https://raw.githubusercontent.com/ckk-09/dsh-refix/main/versions/refix-v1.07.js`，丢掉返回内容第一行的 `Fetched <url> (HTTP 200)` 头部（以及任何截断提示行），余下全文原样作为 code.host 传入"。

**`dsh web` 起不来了，报 `duplicate loader entry id: xxx`** → 你在 `cordis.patch.yml` 里 insert 了一个**已经被某个 bundle 层 insert 过**的 id（最典型就是 `cordis-host-runner`）。把重复的那几行删掉即可，dsh 从不改写你的配置文件。定位：

```bash
dsh web --dump-config | findstr "id: <那个 id>"
```

出现 **2 次**就是重复了（正常应为 1 次）。这条命令是离线合成，**dsh 已经起不来它也能跑**，所以别慌。

**`refix_report` 里 `contract.ok` 是 `false`** → DSH 升级后宿主 API 变了。这时所有修复动作会被门控拒绝（是保护，不是故障）。看 `contract.missing` 列出缺了哪些方法，把源码适配后重新 define 一个版本再切过去。

**`refix_repair` 总返回 `plugin-not-found`** → 目标插件不在**调用者会话**的 inventory 里（它属于别的会话，或已被删除）。

**它会不会改我的 DSH 源码 / 联网 / 写文件？** → 不会。源码里 `undefine(` / `fetch(` / `require(` / `process.` 零命中，它只操作内存里的动态插件。

其余故障（读 `outcome` / `phase` / `reason` 全表、回退到旧版本、五个坑）→ [TECHNICAL.md](./TECHNICAL.md) 的「使用者参考」一节。

---

## 相关文档

- [TECHNICAL.md](./TECHNICAL.md) —— 机制、硬边界、**使用者参考**（工具参数 / 返回值全表 / 自证与哈希 / 回退 / 五个坑）、验收矩阵、阶段状态
- [README.md](./README.md) —— 项目介绍与版本选择（V1.2 静态包 / V1.0x 动态包 / V1.1-pre 前瞻线）
- [deploy/static/README.md](./deploy/static/README.md) —— 静态包怎么构建、怎么自己验证、tgz 怎么分发
- [versions/](./versions/) —— 全部插件版本源码
- [reports/](./reports/) —— 各阶段验收报告（P0~P4 / P3R / P3R2 / P3R3）
