/**
 * dsh-refix P3R2 复检修复版验收（v6 = p3.3）
 * 覆盖复检报告：N-3 过滤真生效 / N-1 泄漏不吞真实症状 / N-4 处方不降级 /
 * N-5 同会话强制校验 / 批准路径（resolveRequestRun ok:true）/ V-2 自身拒绝。
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p3r2.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, AGENT_B, callTool, defineAndRun, definePkg, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V5 = readFileSync(new URL('../versions/refix-v5-p3r.js', import.meta.url), 'utf8')
const REFIX_V6 = readFileSync(new URL('../versions/refix-v6-p3r2.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')

const h = await setup()
const v5ref = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V5 })
await runPkg(h, v5ref.pluginId, v5ref.packageId, 'run')
const v6ref = definePkg(h, { kind: 'existing', pluginId: v5ref.pluginId }, 'dsh-refix (P3R2 复检修复)', { host: REFIX_V6 })
await runPkg(h, v5ref.pluginId, v6ref.packageId, 'update')

async function repair(args: any, agent: any = AGENT_A) {
  return JSON.parse(await callTool(h, 'refix_repair', args, agent))
}

// ── 基础回归：v6 修复能力完好（显式传 AGENT_A = 同会话强制校验路径）──────────
const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })
await h.runner.stop(AGENT_A, patient.pluginId)
let r = await repair({ pluginId: patient.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'success', 'v6 基础 restart 修复应成功: ' + JSON.stringify(r))

// ── N-5：跨会话强制校验 ─────────────────────────────────────────────────────
r = await repair({ pluginId: patient.pluginId, observeMs: 300 }, AGENT_B)
assert.equal(r.outcome, 'refused', '跨会话修复应被拒绝')
assert.equal(r.reason, 'cross-session', '拒绝原因应为 cross-session')
// 自身拒绝（V-2 name 锚点，v6 仍有效）
r = await repair({ pluginId: v5ref.pluginId, observeMs: 300 })
assert.equal(r.reason, 'self-repair-forbidden', '对自身修复应拒绝（name 锚点）')

// ── N-3：refix_patrol pluginId 过滤真生效（双向断言）────────────────────────
// 用 reportRenderFailure 制造"无事件伴随"的症状（事件巡检不会抢先落册），
// 过滤巡检的排除向与返回向才都可断言。
const patientC = await defineAndRun(h, 'patnc', 'dsh-patient-c', { host: PATIENT_OK })
const patientD = await defineAndRun(h, 'patnd', 'dsh-patient-d', { host: PATIENT_OK })
await callTool(h, 'refix_patrol', {}) // 全量基线（无症状）
await h.runner.reportRenderFailure(AGENT_A, patientD.pluginId, patientD.receipt.pluginRunId, {
  slot: 'root', message: 'render broke (N-3 filter test)',
})
const filteredC = JSON.parse(await callTool(h, 'refix_patrol', { pluginId: patientC.pluginId }))
assert.equal(filteredC.newSymptoms.length, 0,
  '排除向：过滤巡检 patientC 不得返回 patientD 的症状: ' + JSON.stringify(filteredC.newSymptoms))
const filteredD = JSON.parse(await callTool(h, 'refix_patrol', { pluginId: patientD.pluginId }))
assert.equal(filteredD.newSymptoms.length, 1, '返回向：过滤巡检 patientD 应恰好返回其 1 条新症状')
assert.equal(filteredD.newSymptoms[0].pluginId, patientD.pluginId, '返回症状应属于目标插件')
assert.equal(filteredD.newSymptoms[0].kind, 'render-failure', '症状应为 render-failure')

// ── N-1：停止态修复（泄漏路径）后，真实停机仍必须报出 ──────────────────────
const D2 = definePkg(h, { kind: 'existing', pluginId: patientD.pluginId }, 'dsh-patient-d v2', { host: PATIENT_OK }).packageId
await h.runner.stop(AGENT_A, patientD.pluginId) // 停止态（外部 stop，事件巡检正常落册 run-missing）
r = await repair({ pluginId: patientD.pluginId, symptom: 'run-missing', targetPackageId: D2, observeMs: 300 })
assert.equal(r.outcome, 'success', '停止态切换修复应成功: ' + JSON.stringify(r))
// 旧代码缺陷：此时 expectedRetracts 泄漏 1（宿主 retract() 对无 run 早退不发事件）
// patientD 现运行 D2；随后真实停机必须立即报出 run-missing（泄漏则被抑制窗口静默吞掉）
await h.runner.stop(AGENT_A, patientD.pluginId)
const reportD = await refixReport(h)
const realMiss = reportD.reports.filter((x: any) => x.kind === 'run-missing' && x.pluginId === patientD.pluginId)
assert.ok(realMiss.length >= 1, 'N-1: 泄漏路径修复后，真实停机的 run-missing 必须立即报出'
  + '（若计数泄漏会被抑制窗口静默吞掉）: ' + JSON.stringify(reportD.reports.map((x: any) => x.kind + '@' + x.pluginId)))

// ── N-4 + 批准路径：awaiting-approval 不降级既有处方；批准后激活成功 ─────────
const patientE = await defineAndRun(h, 'patne', 'dsh-patient-e', { host: PATIENT_OK })
await h.runner.stop(AGENT_A, patientE.pluginId)
r = await repair({ pluginId: patientE.pluginId, observeMs: 300 }) // restart 处方入册
assert.equal(r.outcome, 'success')
await h.runner.stop(AGENT_A, patientE.pluginId)
r = await repair({ pluginId: patientE.pluginId, observeMs: 300 }) // 命中复用
assert.equal(r.knowledgeHit !== null, true, '第二次修复应命中知识库')
const clientPkg = definePkg(h, { kind: 'existing', pluginId: patientE.pluginId }, 'dsh-patient-e (client fix)', {
  host: PATIENT_OK, client: 'return () => {}',
}).packageId
await h.runner.stop(AGENT_A, patientE.pluginId)
r = await repair({ pluginId: patientE.pluginId, targetPackageId: clientPkg, observeMs: 300 })
assert.equal(r.outcome, 'awaiting-approval', '客户端半区修复应进入审批流')
const req = h.events.filter(([n]: any) => n === 'cordis/request-run').slice(-1)[0][1]
let report = await refixReport(h)
const priorRestart = report.knowledge.find((k: any) => k.fingerprint === 'run-missing|' + patientE.pluginId
  && k.action === 'restart')
assert.ok(priorRestart && priorRestart.outcome === 'success',
  'N-4: awaiting-approval 修复不得把既有成功处方降级: ' + JSON.stringify(priorRestart))
// 批准路径（p2 只测过拒绝）：通道 A = 带 requestId 调 runHostHalf（宿主 L324）。
// 注（P3R3 更正）：resolveRequestRun(ok:true, pluginRunId) 是通道 B（客户端回执），
// 适用于批准激活后的 client-pending 阶段（plugin.run 已建立，L420 runId 闸门可过）；
// 审批 pending 阶段 plugin.run 未建立（run() L301 先于 startHost 返回）故通道 B 不通。
const started = await (h.runner as any).runHostHalf(AGENT_A, patientE.pluginId, clientPkg, 'update', req.requestId, false)
assert.equal(started.ok, true, '批准后 runHostHalf 应激活成功: ' + JSON.stringify(started))
await sleep(50)
report = await refixReport(h)
assert.equal(report.baseline[patientE.pluginId].activeRun.packageId, clientPkg, '批准后应激活客户端半区版本')
// 既有处方仍然可用：批准激活后再停机，显式 symptom 绕开"最近报告=activation-refused"
// （宿主在 stop 时会取消残留 pending request 并标记 approval-phase——宿主语义，非 refix 缺陷）
await h.runner.stop(AGENT_A, patientE.pluginId)
r = await repair({ pluginId: patientE.pluginId, symptom: 'run-missing', observeMs: 300 })
assert.equal(r.outcome, 'success', '处方未降级：复发修复应成功: ' + JSON.stringify(r))
assert.ok(r.knowledgeHit && r.knowledgeHit.action === 'restart', '仍应命中 restart 历史方案: ' + JSON.stringify(r.knowledgeHit))

console.log('P3R2 SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v5ref.pluginId, v5: v5ref.packageId, v6: v6ref.packageId },
  checks: { n3Filter: true, n1Leak: true, n4NoDowngrade: true, n5CrossSession: true, approvalAccept: true },
}, null, 2))
process.exit(0)
