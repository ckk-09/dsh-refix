# dsh-refix Phase 2 架构定稿（t2 · 基于宿主源码与 Inspect 实证）

> 隔离区：`<隔离副本目录>`（复制自本体 @ `c722e01 release(V1.08)`，本体 CLEAN）
> 宿主事实来源：DSH checkout 源码（packages/experimental/agent-team、packages/storage/*）+ cordis Inspect Provider 目录

---

## 宿主能力探查结论（P3/P4 方案依据）

### P4 AgentTeams 放行 —— ✅ 可行（agentTeams 服务实证存在）
- `ctx.get('agentTeams')`（可选服务，本部署 web 组合已激活——AgentTeams 就在跑）；
- 契约（experimental/agent-team/src/roster.ts L29-34, L92-120）：`tryMembership(agent) → {root, id, role:'lead'|'teammate', name} | undefined`；
- **TeamId = root 会话 id** → 同队判定 = `callerM.id === ownerM.id`；
- 设计：refix_repair 的 cross-session 分支前插**同队放行**——
  ```js
  const teams = ctx.get('agentTeams')            // 可选，不进 inject（无 teams 组合照常工作）
  if (teams && exec && exec.agent) {
    const callerM = teams.tryMembership(exec.agent)          // 内部已校验 agent 活性（L93）
    const ownerAgent = ctx.agents.get(row.agentId)
    const ownerM = ownerAgent ? teams.tryMembership(ownerAgent) : undefined
    if (callerM && ownerM && callerM.id === ownerM.id) → 放行，record.viaTeam = callerM.role + '/' + callerM.name 留痕
  }
  ```
- 安全边界：仅同 TeamId 放行（成员由 Lead 亲自 roster，信任锚点成立）；审计必留痕；工具描述同步声明；无 agentTeams 服务时行为与 V1.08 完全一致。

### P3 知识库持久化 —— ⚠️ 方案A 受阻，落地方案 C（双形态通用）
- 实证：`storage`/`storageDomain` 服务存在且 web 组合随 dsh-base 挂载（bundle/web-app README L72）；
- **受阻根因**：`DomainFacility.open(spec)` 的 DomainSpec 内 record schema 是 **zod**（storage-domain/src/index.ts L5-6, L89-93），动态沙箱无 require/zod，无法构造合法 spec；静态包虽有两级模块解析机制，但仅为 harness.defineTool 设计，扩展它超出本轮范围；
- **决策：方案 C**——新增 `refix_export`（导出 knowledge 快照 JSON：schemaVersion + 全量条目）/ `refix_restore`（回填：zod 风格手工校验器逐字段验证，拒绝脏数据；同指纹策略=skip，默认不覆盖现有条目；上限 CAPS.knowledge）。实现"重启后人工移植病历"，零依赖、动态/静态形态一致；
- storageDomain 适配记为未来增强（需构建器扩展宿主模块解析），TECHNICAL 声明。

### P1 F7 注入契约（pre2 L627-646 实证）
- `ctx.on('agent/pre-step', async (payload, next) => {...})` waterfall：`const decision = await next()`；仅当有挂起告警时 `Object.assign({}, decision, { messages: decision.messages.concat([noticeMsg]) })`；
- noticeMsg 形态：`{ role:'user', id:'refix-…', content:[{type:'text',text}], source:{kind:'plugin', plugin:SELF_PLUGIN_NAME, form:'snapshot', sections:[{name,text}]} }`；
- F7 设计：复用同一通道；`pendingAlerts` 队列（同插件同症状会话期一次，Set 去重）；addReport 落册 run-missing/host-method-error 时入队；pre-step 消费时合并为一条消息（多条告警一次注入）；自身异常绝不上抛、abort 即透传。

### P2 多级探针设计
- L1 `health`（现行）→ 失败(reason=method-not-found) 进 L2；
- L2 反射：`runner.inspectPlugin(agent, pid, runId)` 的方法清单中选**只读**方法空参试探；写方法黑名单 `['define','undefine','run','stop','invoke','register','set','write','update','delete','mount','open','execute','send']` + 优先选名字含 get/list/inspect/status/info/health/describe/query 的方法；每 (pluginId,packageId) 只标定一次并缓存（选定方法写入 probeSkipped Map 的伴生结构，V-6 按版本失效）；
- L3 存活：inventory `activeRun` 存在即视为活（零调用成本），不再计入 probeSkipped 跳过；
- 结果语义不变：仅 handler-error 报 host-method-error；不触发修复（修复仍走策略表）。

### P0 生成式定版设计
- **标记体系（落地版）**：base = **当前稳定线** `versions/refix-v1.10.js`，埋 `// @refix-gen:<point>` 锚点 **7 处**：
  `constants` / `state` / `selfcheck-update` / `events` / `interval` / `body` / `ready`。
  （设计稿曾写"base = refix-v1.08.js、6 处锚点（header-version/constants/state-vars/functions/tools/events）"；
  实现时改为锚在**当前稳定线**上，见下方"落地修正"。）
- 生成器 `tools/gen-pre.mjs`（零依赖 node）：读 base → 读 `tools/segments/f6.mjs`（段落库，纯文本块导出）→
  锚点替换/插入（`interval` / `ready` 两处连锚点行 + base 语句行一起吞掉，并**逐行验签**防 base 漂移）→
  版本串参数化（`REFIX_VERSION='p3.9'`、头注）→ 写 `versions/refix-v1.1-pre3.js`。
  残留锚点即失败（`fail('存在未消费的 @refix-gen 锚点')`），保证 base 与段落库不失配。
- **落地修正（编码期决定，已实测）**：锚点从 v1.08 挪到 v1.10。原因是 pre 线必须继承**稳定线全部能力**
  （V1.08 六项修复 + V1.10 四项能力），而 v1.08 是**已发布文件、sha256 已被文档与 `--check` 钉死**；
  给它补锚点会改动发布字节（实测 37013B→37670B，哈希失效）。**结论：已发布文件一律不再改，新锚点只加在当前稳定线上。**
- 等价性口径：pre3 与 pre2 **非逐字节**（base 已含 V1.08 六项修复 + V1.10 四项能力），
  语义等价 = `ac/pre3-smoke.mjs` 超集矩阵（pre2 注册面 ⊆ pre3 + 继承矩阵）+ 全套 n-series 对 pre3 复跑。
- 版本规划：稳定线 **V1.10（自报 p3.8）**、生成 pre 线 **v1.1-pre3（自报 p3.9）**、静态包 **1.4.0**（从 V1.10 构建）。

## 实施顺序
t3 生成器+标记 → t4 V1.10（F7+多级探针编码于 base）→ t5 持久化+协作放行 → gen-pre 重生成 pre3 → t6 全量验证。
