# dsh-refix P3R 审查修复报告（v5 = p3.2）

日期：2026-09-16　依据：《dsh-refix 代码审查报告》（16 缺陷 + 7 优化 + 6 盲区）
状态：**逐条核验处置完毕，6/6 全量回归 PASS**

## 处置总表

| 编号 | 级别 | 处置 | 实现 |
|---|---|---|---|
| V-1 挂起探针永久自锁 | 🔴 | ✅ 修复 | 探针 2s `Promise.race` 超时（超时留痕不计症状）+ drain 5s 兜底 + 有界等待保证 `finally` 必然复位 `repairing`（T-1 实测 patrol 2004ms 返回，修复不被锁） |
| V-2 自修复行为未定义 | 🔴 | ✅ 双层防御 | ① `dynamic-package` payload.name 前缀匹配捕获自身 pluginId → 拒绝 `self-repair-forbidden`；② 行为指纹兜底：目标包 host 源码含 `refix_report` → 视为自身拒绝（不依赖命名，T-3 实证） |
| V-3 observeMs 无界 | 🔴 | ✅ 修复 | `isFinite` 检查 + clamp [0, 120000]（T-5 实证：`-5`→即时完成，null→默认） |
| V-4 窗口误算窗外症状 | 🟡 | ✅ 修复（方案优于报告） | 报告建议指纹集合差；实现改为 `evidence.pluginRunId === newRunId`——只认**本次激活 attempt** 的报告，比集合差更精确（旧 run 的迟落册探针报告天然排除） |
| V-5 抑制整段修复期 | 🟡 | ✅ 修复 | `suppressRunMissing` 整段屏蔽 → `expectedRetracts` 计数：refix 自己发起的 stop / update-mode run 各登记一次，retract 事件当拍消费（同步 emit 保证抑制窗口恰好覆盖事件，无泄漏） |
| V-6 probeSkipped 永久失能 | 🟡 | ✅ 修复 | 键改 `pluginId\|packageId`——插件新版本注册 health 后探针自动复活（p3r 实证：v1 无 health → v2 抛错 health → host-method-error 报出） |
| V-7 一次失败永久棘轮 | 🟡 | ✅ 部分采纳 | 加 `attempts/successes/failures` 计数（审计透明）；行为保持"一次失败转人工"（保守方向 + AC 兼容；显式 `targetPackageId` 本就可覆盖） |
| V-8 内存无界 + 上下文灌爆 | 🟡 | ✅ 修复 | reports/repairs/knowledge 环形上限 100/100/100 + `refix_report` 可选 `limit` 参数（默认全量，向后兼容） |
| V-9 插件删除无感 | 🟡 | 📄 如实声明 | README 已知边界：undefine 属预期动作，不产症状报告 |
| V-10 runner 异常丢审计 | 🟡 | ✅ 修复 | `executeRepair` 外层 catch → `{outcome:'failed', phase:'exception'}` 照常入 `repairs` |
| V-11 跨会话权限 | 🟡 | 📄 如实声明 | `defineTool.execute` 无调用者身份上下文（核验属实）→ 无法比对；工具描述 + README 明示"以目标插件归属会话的授权执行" |
| V-12 F5 只探存在性 | 🟢 | 📄 如实声明 | README 已知边界：签名变化不可发现 |
| V-13 fallback === target 假回退 | 🟢 | ✅ 修复 | `fallback = current === target ? null : current`（derivePlan 与知识库复用两处；T-5 实证 target=current 时 fallback null） |
| V-14 run-missing 死代码 | 🟢 | 📄 澄清 | 并非死代码：模型显式 `symptom:'run-missing'` 且插件运行中时可达（语义=重启），已加注释 |
| V-15 去重键 split 解析 | 🟢 | 📄 注释 | 消费方只读前两段，message 含 `\|` 实际安全；已注释说明 |
| V-16 awaiting-approval 不入知识库 | 🟢 | 📄 如实声明 | 审批后复核回填是 v2 范围；README 已知边界 |
| O-1 事件去抖 | ⚙️ | ❌ 有据拒绝 | 与"事件当拍生效"的即时性设计直接冲突（审查报告"值得保留 #4"自己也肯定了它）；探针风暴已由 dedup + probeSkipped + 2s 超时三重缓解 |
| O-2 目标包预校验 | ⚙️ | ✅ 采纳 | switch 前 `inspectPackage` 预校验 → `refused 'target-not-found'`（T-5 实证） |
| O-3/O-4/O-5/O-6 | ⚙️ | ❌ v1 范围外 | snapshot 富诊断/策略表 config 化/per-plugin 锁/自适应观察窗：记录为 v2 候选 |
| O-7 patrol 过滤 | ⚙️ | ✅ 采纳 | `refix_patrol` 可选 `pluginId` 参数（lastSeen 仍全量维护，基线一致性不受影响） |

## 补的测试盲区（T-1/T-2/T-3/T-5 + V-6/V-8）

`ac/p3r.ac.mts` 全部通过：
- **T-1** health 永不 resolve 的插件 → `refix_patrol` 2004ms 有界返回、探针超时不计症状、随后修复正常（无自锁）
- **T-2** 运行中热更新 → 零 run-missing 误报（IN_FLIGHT 白名单 + expectedRetracts 双路径首次被验证）
- **T-3** 对 refix 自身修复 → `self-repair-forbidden`（双层：name 锚点 + 源码指纹）
- **T-5** `observeMs: -5` → clamp 0 即时完成；不存在的 targetPackageId → `target-not-found`；target=当前版本 → `fallback: null`（假回退消除）
- **V-6** 无 health v1 → 升级 v2（health 抛错）→ 探针复活报出 host-method-error
- **V-8** `refix_report {limit:1}` → reports 长度 1

## 实现中发现的额外问题（报告未覆盖，已一并修复）

1. **name 锚点脆弱**：V-2 初版用 `payload.name === 'dsh-refix'` 精确匹配——define 时 name 带后缀即失效（p3r 首跑 T-3 当场暴露：返回 `manual-only`）。修复 = 前缀匹配 + 行为指纹双层。
2. **死参数**：`patrol(trigger, suppressPid, onlyPid)` 的 suppressPid 从未使用（抑制实际由 Map 在 detectRowSymptoms 内完成）——已删除，时序注释说明抑制窗口恰好覆盖事件当拍。

## 全量回归

```
p0 => PASS   p1 => PASS   p2 => PASS   p3 => PASS   p3r => PASS   ac52 => PASS
```

## 交付物

| 文件 | 说明 |
|---|---|
| `versions/refix-v5-p3r.js` | v5（p3.2）：审查修复版（当前推荐挂载版本） |
| `ac/p3r.ac.mts` | 审查修复验收脚本 |
| `reports/P3R.md` | 本报告 |
| `README.md` | 已知边界扩充 + 版本演进更新 |
