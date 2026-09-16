/**
 * dsh-refix P2 验收（AC2.1、AC2.2、AC3.1~3.4）
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p2.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, callTool, defineAndRun, definePkg, refixPatrol, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V2 = readFileSync(new URL('../versions/refix-v2-p1.js', import.meta.url), 'utf8')
const REFIX_V3 = readFileSync(new URL('../versions/refix-v3-p2.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')
const PATIENT_BROKEN = readFileSync(new URL('../versions/patient-v2-broken.js', import.meta.url), 'utf8')

const h = await setup()

// refix 以追加版本升到 v3
const v2ref = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V2 })
await runPkg(h, v2ref.pluginId, v2ref.packageId, 'run')
const v3ref = definePkg(h, { kind: 'existing', pluginId: v2ref.pluginId }, 'dsh-refix (P2)', { host: REFIX_V3 })
await runPkg(h, v2ref.pluginId, v3ref.packageId, 'update')

// 共存插件 B（AC3.1 的"其他插件不中断"见证者）
const pluginB = await defineAndRun(h, 'plgnb', 'plugin-b', { host: PATIENT_OK })
const bRunIdBefore = pluginB.receipt.pluginRunId

// 患者 v1
const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })
const V1 = patient.packageId

async function repair(args: any) {
  return JSON.parse(await callTool(h, 'refix_repair', { observeMs: 300, ...args }))
}
const eventCount = () => h.events.length
const pkgEvents = () => h.events.filter(([n]: any) => n === 'cordis/dynamic-package' || n === 'cordis/dynamic-retract')

// ── AC2.1：run 消失命中策略表 → run(原 packageId, restart) ──────────────────
await h.runner.stop(AGENT_A, patient.pluginId)
let r = await repair({ pluginId: patient.pluginId })
assert.equal(r.outcome, 'success', 'AC2.1 修复应成功: ' + JSON.stringify(r))
assert.equal(r.plan.action, 'restart', 'AC2.1 计划应为 restart')
assert.equal(r.plan.target, V1, 'AC2.1 应重启原版本 packageId')
assert.equal(r.plan.mode, 'run', 'AC2.1 重启模式应为 run')
let report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun.packageId, V1, 'AC2.1 修复后应运行原版本')

// ── AC2.2：未知/需人工症状 → 拒绝执行，零动作 ───────────────────────────────
const eventsBefore = eventCount()
r = await repair({ pluginId: patient.pluginId, symptom: 'unknown' })
assert.equal(r.outcome, 'refused', 'AC2.2 未知症状应拒绝')
assert.equal(r.reason, 'manual-only', 'AC2.2 拒绝原因应为 manual-only')
assert.ok(r.detail.includes('不做任何修复动作'), 'AC2.2 应明示不动作')
r = await repair({ pluginId: patient.pluginId, symptom: 'render-failure' })
assert.equal(r.outcome, 'refused', 'AC2.2 渲染失败（需人工）应拒绝')
assert.equal(eventCount(), eventsBefore, 'AC2.2 拒绝时不得产生任何 runner 事件（零动作）')

// ── AC3.2：切换修复成功 + 新旧 packageId 对照 ───────────────────────────────
const v2pkg = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient v2 (healthy)', { host: PATIENT_OK }).packageId
await h.runner.stop(AGENT_A, patient.pluginId) // 制造新的 run-missing
r = await repair({ pluginId: patient.pluginId, targetPackageId: v2pkg })
assert.equal(r.outcome, 'success', 'AC3.2 切换修复应成功: ' + JSON.stringify(r))
assert.deepEqual(r.packageIdPairs, { old: V1, new: v2pkg }, 'AC3.2 应给出新旧 packageId 对照')
report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun.packageId, v2pkg, 'AC3.2 修复后应运行新版本')

// ── AC3.3：修了还坏（切到仍抛错的 v3）→ 自动 run() 回退旧版本并报告失败 ────
const v3pkg = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient v3 (broken fix)', { host: PATIENT_BROKEN }).packageId
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId, targetPackageId: v3pkg })
assert.equal(r.outcome, 'failed', 'AC3.3 修复应判定失败: ' + JSON.stringify(r))
assert.ok(r.rollback && r.rollback.to === v2pkg && r.rollback.from === v3pkg, 'AC3.3 应自动回退至 v2: ' + JSON.stringify(r.rollback))
assert.equal(r.rollback.clean, true, 'AC3.3 回退后观察窗应无症状')
report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun.packageId, v2pkg, 'AC3.3 回退后应运行旧版本 v2')

// 软重置变体：重跑仍抛错 → 如实报告失败（无旧版本可回退）
const brokenB = await defineAndRun(h, 'brkpb', 'dsh-patient-broken', { host: PATIENT_BROKEN })
await refixPatrol(h); await sleep(80) // 探针捕获 host-method-error
r = await repair({ pluginId: brokenB.pluginId }) // symptom 省略 → 最近报告 host-method-error → soft-reset
assert.equal(r.plan.action, 'soft-reset', '软重置计划应由 host-method-error 命中')
assert.equal(r.outcome, 'failed', '软重置后仍抛错应如实报告失败: ' + JSON.stringify(r))
assert.ok(JSON.stringify(r.steps).includes('run-after-stop'), '软重置应包含 stop→run 步骤')

// ── AC3.1：修复全过程 refix 自身与插件 B 不中断 ────────────────────────────
report = await refixReport(h)
assert.equal(report.baseline[pluginB.pluginId].activeRun.pluginRunId, bRunIdBefore, 'AC3.1 插件 B 的 run 不应中断')
assert.ok(report.reports.every((x: any) => x.pluginId !== pluginB.pluginId), 'AC3.1 插件 B 应无症状')
assert.equal(report.baseline[v2ref.pluginId].activeRun.packageId, v3ref.packageId, 'AC3.1 refix 自身应持续运行 v3')
await refixPatrol(h) // refix 工具链仍然可用
const bProbe = await h.runner.invoke(pluginB.pluginId, bRunIdBefore, 'health', {})
assert.equal(bProbe.ok, true, 'AC3.1 插件 B 的 health 探针应仍健康')

// ── AC3.4：客户端半区修复走原生审批流；拒绝后不执行且状态一致 ───────────────
const clientPkg = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient (client fix)', {
  host: PATIENT_OK, client: 'return () => {}',
}).packageId
await h.runner.stop(AGENT_A, patient.pluginId) // run-missing → 用客户端半区候选版本修复
const reqEventsBefore = h.events.filter(([n]: any) => n === 'cordis/request-run').length
r = await repair({ pluginId: patient.pluginId, targetPackageId: clientPkg })
assert.equal(r.outcome, 'awaiting-approval', 'AC3.4 客户端半区修复应进入原生审批流: ' + JSON.stringify(r))
assert.equal(r.plan.target, clientPkg, 'AC3.4 目标应为客户端半区候选版本')
const reqEvents = h.events.filter(([n]: any) => n === 'cordis/request-run')
assert.equal(reqEvents.length, reqEventsBefore + 1, 'AC3.4 应发出恰好一条 cordis/request-run')
report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun, null, 'AC3.4 审批期间不得激活（患者保持停止）')
assert.equal(report.baseline[patient.pluginId].currentPackageId, v2pkg, 'AC3.4 current 不得变化（状态一致）')
// 用户拒绝（真实浏览器拒绝路径）
await h.runner.resolveRequestRun(reqEvents[reqEvents.length - 1][1].requestId, { ok: false, reason: 'rejected', message: 'not now（验收拒绝）' })
// 拒绝后：患者仍停止、current 仍 v2、无第二次审批（不重试）
report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun, null, 'AC3.4 拒绝后不得激活')
assert.equal(report.baseline[patient.pluginId].currentPackageId, v2pkg, 'AC3.4 拒绝后 current 保持一致')
assert.equal(h.events.filter(([n]: any) => n === 'cordis/request-run').length, reqEventsBefore + 1, 'AC3.4 拒绝后不得重试（无第二次 request-run）')
await refixPatrol(h)
report = await refixReport(h)
assert.ok(report.reports.some((x: any) => x.kind === 'activation-refused' && x.pluginId === patient.pluginId), '拒绝应被巡检记录为 activation-refused（不重试）')

console.log('P2 SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v2ref.pluginId, v2: v2ref.packageId, v3: v3ref.packageId },
  patient: { pluginId: patient.pluginId, versions: [V1, v2pkg, v3pkg, clientPkg] },
  pluginB: { pluginId: pluginB.pluginId, runIdStable: true },
  repairs: (await refixReport(h)).repairs.map((x: any) => ({ symptom: x.symptom, outcome: x.outcome })),
}, null, 2))
process.exit(0)
