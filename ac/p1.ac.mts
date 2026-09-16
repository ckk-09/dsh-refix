/**
 * dsh-refix P1 验收（AC1.2 + AC1.3，附测：渲染失败 / 激活被拒 / 周期巡检自治 / update 版本切换）
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p1.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, defineAndRun, definePkg, refixPatrol, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V1 = readFileSync(new URL('../versions/refix-v1-p0.js', import.meta.url), 'utf8')
const REFIX_V2 = readFileSync(new URL('../versions/refix-v2-p1.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')
const PATIENT_BROKEN = readFileSync(new URL('../versions/patient-v2-broken.js', import.meta.url), 'utf8')

const h = await setup()

// ── 准备：refix 以"追加版本 + update 切换"升到 v2（顺带验证不可变版本机制）──
const v1 = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V1 })
await runPkg(h, v1.pluginId, v1.packageId, 'run')
const v2 = definePkg(h, { kind: 'existing', pluginId: v1.pluginId }, 'dsh-refix (P1)', { host: REFIX_V2 })
const updateReceipt = await runPkg(h, v1.pluginId, v2.packageId, 'update')
assert.equal(updateReceipt.status, 'running', 'refix v2 update 后应运行中')
assert.equal(updateReceipt.currentPackageId, v2.packageId, 'update 后 current 应指向 v2')

// ── 准备：健康患者 ──────────────────────────────────────────────────────────
const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })

// 基线巡检：无症状
let patrol = await refixPatrol(h)
assert.equal(patrol.newSymptoms.length, 0, '健康基线不应有症状')

// ── 附测：渲染失败（模拟浏览器 reportRenderFailure 上报路径）────────────────
await h.runner.reportRenderFailure(AGENT_A, patient.pluginId, patient.receipt.pluginRunId, {
  slot: 'test-slot', message: 'render boom（验收注入）', abdicated: true,
})
patrol = await refixPatrol(h)
const renderSymptom = patrol.newSymptoms.find((s: any) => s.kind === 'render-failure' && s.pluginId === patient.pluginId)
assert.ok(renderSymptom, '渲染失败应被巡检捕获')
assert.equal(renderSymptom.severity, 'medium')

// ── AC1.2：stop 模拟意外停机 → 事件触发巡检 → 报告 run 消失 ─────────────────
const stopReceipt = await h.runner.stop(AGENT_A, patient.pluginId)
assert.equal(stopReceipt.ok, true)
let report = await refixReport(h)
// stop() 的 retract 事件同步触发巡检，无需手动再巡检
const missing = report.reports.filter((r: any) => r.kind === 'run-missing' && r.pluginId === patient.pluginId)
assert.ok(missing.length >= 1, 'AC1.2: run 消失应被报告（事件即时触发）')
assert.equal(missing[0].evidence.before.pluginRunId, patient.receipt.pluginRunId, '证据应含消失前的 activeRun')
assert.equal(missing[0].evidence.after.activeRun, null, '证据应含消失后 diff（activeRun=null）')
assert.ok(missing[0].evidence.observedVia.includes('dynamic-retract'), '证据应标注事件来源')

// ── AC1.3：坏患者 health 抛错 → 巡检 invoke 失败 → 归因到正确 pluginId ──────
const broken = await defineAndRun(h, 'brkpt', 'dsh-patient-broken', { host: PATIENT_BROKEN })
await refixPatrol(h)            // 触发探针
await sleep(80)                 // 等探针 promise 落地
report = await refixReport(h)
const handlerErr = report.reports.filter((r: any) => r.kind === 'host-method-error')
assert.ok(handlerErr.length >= 1, 'AC1.3: 宿主方法抛错应被捕获')
assert.ok(handlerErr.every((r: any) => r.pluginId === broken.pluginId), '归因必须指向坏患者，不得误伤他人: ' + JSON.stringify(handlerErr.map((r: any) => r.pluginId)))
assert.ok(handlerErr[0].evidence.message.includes('必现故障'), '证据应含抛错信息')

// 去重：同症状持续期间不重复报告
patrol = await refixPatrol(h)
await sleep(80)
patrol = await refixPatrol(h)
const before = report.reports.length
report = await refixReport(h)
assert.equal(report.reports.length, before, '持续中的症状不得重复报告')

// ── 附测：包激活被拒（客户端半区审批拒绝路径，AC3.4 的前半段）───────────────
const clientPkg = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient (client)', {
  host: PATIENT_OK,
  client: 'return () => {}',
})
const awaiting = await runPkg(h, patient.pluginId, clientPkg.packageId, 'update')
assert.equal(awaiting.status, 'awaiting-approval', '未授权的客户端半区应进入审批')
const requestRun = h.events.find(([name]: any) => name === 'cordis/request-run')
assert.ok(requestRun, '应发出 cordis/request-run 事件')
// 模拟浏览器拒绝（与真实 client runner 拒绝路径一致）
await h.runner.resolveRequestRun(requestRun[1].requestId, { ok: false, reason: 'rejected', message: 'not now（验收拒绝）' })
patrol = await refixPatrol(h)
const refused = patrol.newSymptoms.find((s: any) => s.kind === 'activation-refused' && s.pluginId === patient.pluginId)
assert.ok(refused, '激活被拒应被巡检捕获且不重试')
assert.equal(refused.severity, 'manual')

// ── 附测：周期巡检自治（interval 真实滴答）──────────────────────────────────
report = await refixReport(h)
const countBefore = report.patrolCount
await sleep(16500)
report = await refixReport(h)
assert.ok(report.patrolCount > countBefore, `15s 周期巡检应自治运行（${countBefore} → ${report.patrolCount}）`)

// ── 无误报：refix 自身经历 define/update/retract，不得产生针对自身的症状 ────
report = await refixReport(h)
const selfReports = report.reports.filter((r: any) => r.pluginId === v1.pluginId)
assert.equal(selfReports.length, 0, 'refix 自身不应被报告症状')

console.log('P1 SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v1.pluginId, v1: v1.packageId, v2: v2.packageId, current: updateReceipt.currentPackageId },
  patient: { pluginId: patient.pluginId, packageId: patient.packageId },
  broken: { pluginId: broken.pluginId },
  symptomKinds: report.reports.map((r: any) => r.kind),
  patrolCount: report.patrolCount,
}, null, 2))
process.exit(0) // 15s 巡检 interval 会吊住事件循环，验收完成后显式退出
