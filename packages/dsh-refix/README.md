# dsh-refix v1.3.0（静态包）

DSH 静态 profile 层构建，由 `deploy/static/build-static.mjs` 自动生成。
生成源：`versions/refix-v1.08.js`（sha256 `0cf42e50428fef2e…`）。

## 装（一条命令）

```powershell
dsh plugin --profile web add <本目录的绝对路径>
```

装完重启 `dsh web`。该命令是宿主原生能力：它把参数转发给 profile 目录里的 pnpm，
然后把声明了 `dsh.bundle` 的依赖自动并入 `dsh.profile.bundles` 层栈。

卸载：`dsh plugin --profile web remove dsh-refix`。

## 装好的标志

dsh 控制台出现：

```
dsh-refix p3.7 ready; contract OK (兼容性自检通过); baseline plugins: N; patrol every 15000ms
```

## 边界（与动态包一致）

- **周期巡检自动**：`PATROL_PERIOD_MS = 15000`，插件自己起定时器，无需任何外部触发。
- **修复与报告不自动**：修复唯一入口是 `refix_repair` 工具，报告是 `refix_report`，
  巡检是 `refix_patrol` —— 都要由会话模型按需调用。插件源码里没有 prompt/systemPrompt
  注入，所以它**不会主动对被修复的会话说话**。
  要"全自动"，请在挂载后授权会话模型：先 `refix_patrol` 建立基线，之后按需 `refix_report`、
  可修症状直接 `refix_repair`。

## 运行期依赖

`@deepseek-ai/dsh-tools`（取 `defineTool` 做 DSL→JSON Schema 编译与参数校验）。

解析分两级：① 裸说明符 —— 本包以**实体目录**安装时命中；② `$DSH_HOME/profiles/node_modules`
—— DSH 启动时把安装侧依赖闭包投影在这里（`healProfilesModuleFallback`）。
pnpm 以 symlink 安装本包时第 ① 级必然失败（Node 会把模块 realpath 回源目录再找依赖），
靠第 ② 级命中安装侧同一份。

两级都不可达时插件**仍会加载并巡检**，只是工具 schema 走内置编译器、参数不做运行期校验，
控制台打印一行 `[refix] 静态包：未能解析 …` 警告。看到它不影响使用；
要消除它，确认 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools` 存在即可。
