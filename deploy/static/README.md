# dsh-refix 静态包（profile 层插件）

把同一个 dsh-refix 插件从「动态包（`cordis_define` + `cordis_run`）」变成「静态包（随 dsh 启动自动加载）」，
目的是**去掉"第 3 步必须贴一段挂载话术"和"源码必须经模型回填一次"这两个障碍**：
装它不需要任何模型参与，装完即随 dsh 启动自动起来。

> 源码是**同一个**：`versions/refix-v1.08.js`（V1.08 / p3.7）。
> 本目录里的脚本只做「形态转换 + 验证」，不改插件逻辑 —— 插件体 654 行逐字节照搬。

**当前发布：V1.3**（产物 `dist/dsh-refix-1.3.0.tgz`）。安装就一条命令：

```bash
dsh plugin --profile web add https://raw.githubusercontent.com/ckk-09/dsh-refix/main/deploy/static/dist/dsh-refix-1.3.0.tgz
```

**两条版本线，别混**：

- **V1.3** —— 静态包（本目录）的**发布线**，记在 `versions/manifest.json` 的 `static` 段；
- **V1.08 / p3.7** —— 插件**逻辑**版本，源码是 `versions/refix-v1.08.js`。
  V1.3 的插件体与它 **654 行逐字节相同**，随源码带上六项独立审查修复。

构建器据此分开取值：`pkgVersion` 优先读 `manifest.static.packageVersion`，插件自报版本仍从源码里抠。

---

## 一、本目录文件

| 文件 | 作用 |
|---|---|
| `build-static.mjs` | 转换器：`versions/refix-v*.js` → 静态包目录（默认 `packages/dsh-refix/`），`--pack` 顺带出 tgz |
| `test-static.mjs` | 离线冒烟测试：用**假 ctx** 驱动真实模块，两条路径（真 `defineTool` / 内置兜底编译器） |
| `boot-test.mjs` | 真机启动验证：隔离 profile 起真 dsh，**不过滤**日志抓就绪行 / 降级告警 / 树加载失败 |
| `dump-config-check.mjs` | 配置树探针：`--dump-config` 离线核对 `- id: <x>` 计数，专治 `duplicate loader entry id` |
| `packages/dsh-refix/` | 构建产物（**入库**：根 `package.json` 与 `packages/` 子包是 DSH 插件市场的 CI 拾取面） |
| `dist/dsh-refix-<ver>.tgz` | **发布物**（入库）—— "一行命令安装"的载体。当前为 `dsh-refix-1.3.0.tgz` |

---

## 二、构建与验证（三条腿，缺一条都别发布）

```bash
# 1) 结构断言（不落盘）：源哈希、inject 补齐、3 个 defineTool 调用点、禁用 API 零命中
node deploy/static/build-static.mjs --check

# 2) 构建 + 打包（产出 packages/dsh-refix/ 与 dist/dsh-refix-<ver>.tgz，并打印 tgz sha256）
node deploy/static/build-static.mjs --pack

# 3) 离线冒烟：真 defineTool 路径（应无降级告警）
#    注意：必须显式给出模块入口；脚本内置默认值仍指向 df843d2 之前的旧产物目录
node deploy/static/test-static.mjs packages/dsh-refix/lib/index.js
#    离线冒烟：强制兜底编译器路径（应**有**降级告警且仍注册 3 个工具）
node deploy/static/test-static.mjs --fallback packages/dsh-refix/lib/index.js

# 4) 真机启动（需要已装进某个 profile，见第三节）
node deploy/static/boot-test.mjs --profile <隔离profile>
```

`--check` 会打印**源文件 sha256**，必须与 `versions/manifest.json` 对应版本一致，否则说明源被改过。

---

## 三、安装 / 卸载（宿主原生，一条命令）

`dsh plugin` 是宿主的 pnpm 转发器，装完会把声明了 `dsh.bundle` 的依赖**自动并进** `dsh.profile.bundles`；
卸载时**自动摘除**。都不需要手改任何配置文件。

```bash
# 装（tgz 形式，推荐；<profile> 换成你的 profile 名，一般就是 web）
dsh plugin --profile <profile> add https://raw.githubusercontent.com/ckk-09/dsh-refix/main/deploy/static/dist/dsh-refix-1.3.0.tgz

# 装（本地 tgz：网络到 raw.githubusercontent.com 不通时，先下下来再装）
dsh plugin --profile <profile> add "<本地 tgz 的绝对路径>"

# 装（目录形式：便于本地构建后直接调试）
dsh plugin --profile <profile> add "<你的 dist/dsh-refix 目录绝对路径>"

# 卸载
dsh plugin --profile <profile> remove dsh-refix
```

**零前提**：静态包不需要 `tool-cordis`，也不需要模型参与或任何挂载话术。
（已实测：装它的 profile 配置树里 `tool-cordis` 是 `MISSING(0)`，插件照样正常起来 ——
它唯一依赖的宿主服务 `cordis-host-runner` 由 web profile 自带。）

**装好的标志** —— 启动 dsh 后控制台出现这一行（宿主输出，不是模型说的话）：

```
dsh-refix p3.7 ready; contract OK (兼容性自检通过); baseline plugins: N; patrol every 15000ms
```

⚠️ 用 `--profile web` 前建议先确认目标 profile 名；想试又不想动自己的配置，可用隔离 profile：

```bash
dsh --profile <任意新名字> --from-default-profile web --dump-config   # 造一份隔离 profile
```

---

## 四、与动态包的语义差异（只有两处，都是被真机逼出来的）

| 项 | 动态包（沙箱） | 静态包（真实 ctx） |
|---|---|---|
| `ctx.tools` | 沙箱 facade **无条件**放行（`guard.ts` L755），所以源码 `inject` 里没有它 | 真实 ctx 里是服务属性，**未声明就抛** `cannot get property "tools" without inject` → 整树加载失败 ⇒ **构建期自动补进 inject** |
| `harness.defineTool` | 沙箱注入，等于宿主的真 `defineTool` | 模块顶层**两级解析**宿主的 `@deepseek-ai/dsh-tools`（见第五节）；调用点逐字节未改写 |
| 其余 ctx 用法 | — | 真实 ctx 与沙箱 facade 语义一致，**未改写** |

> 补齐 inject 是**机器做**的、可核对的：`--check` 会打印 `inject source [...] → static [...] ← +tools`。
> 第一版没补，真机直接把整棵插件树加载干崩（`plugin tree failed to load`），所以这条是硬要求。

---

## 五、运行期依赖与降级（`@deepseek-ai/dsh-tools`）

取它的 `defineTool` 做 DSL→JSON Schema 编译与**参数校验**。解析分两级：

1. **裸说明符** —— 本包以实体目录安装时命中（实测 tgz 安装走这条）。
2. **`$DSH_HOME/profiles/node_modules`** —— 宿主启动时把安装侧依赖闭包投影在这里
   （`healProfilesModuleFallback`，`app-boot/src/profile.ts` L547）。
   **pnpm 以 symlink 安装本包时第 1 级必然失败**：Node 会先把模块 realpath 回源目录，再沿
   **源目录**链路找依赖，而那条链路上没有 `@deepseek-ai/*`。实测过 `dsh plugin add <目录>` 就是这个形态。

两级都不可达时，插件**仍会加载并正常巡检**，只是工具 schema 走内置编译器、参数不做运行期校验，
控制台打印一行 `[refix] 静态包：未能解析 …`。看到它不影响使用；要消除它，确认
`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` 存在即可。

---

## 六、分发与校验

- **必须入库的是 tgz**（见 `.gitignore` 注释）。只入库展开目录没用：用户拿不到单个文件，
  就得逐文件下载 4 个东西，这个方案相对动态包就白做了。
- **tgz 的 sha256 不可复现**（tar header 带文件 mtime，重打一次哈希就变），所以
  **不要把 tgz 哈希写进文档做校验**。要校验就校验**解包后的 `lib/index.js`**：
  它与 `versions/refix-v1.08.js` 的源哈希一一对应（`--check` 会打印两者）。
- 已冻结的源文件 sha256 见 `TECHNICAL.md`；`lib/index.js` 的字节数随构建器逻辑与头部注释变化而变化
  （两级解析后 40725B，V1.2 加发布版本行后 40771B，V1.3 = 43574B，最初是 38797B），因此**它只与同一构建器版本可比**。

---

## 七、已知边界

- **只有周期巡检是真自动**（`PATROL_PERIOD_MS = 15000`，插件自己起定时器）。
  出报告（`refix_report`）、执行修复（`refix_repair`）都要会话模型按需调用 —— 插件源码里
  没有 prompt/systemPrompt 注入，**它不会主动说话**。静态包不改变这条边界。
- 静态包**不替代**动态包：动态包可以在会话里热切换版本、即时回滚；静态包要换版本得重新装。
  要热切换/回退就用动态包（见 `TECHNICAL.md`）。
- `boot-test.mjs` 抓不到真实多轮巡检输出（测试 profile 的 `baseline plugins: 0`），
  它验证的是"就绪 + 定时器已注册 + 无降级 + 无树加载失败"。
