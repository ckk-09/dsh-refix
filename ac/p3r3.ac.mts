/**
 * dsh-refix P3R3 第三轮复检修复版验收（v7 = p3.4）
 * 覆盖：P-1 过滤巡检不再失盲（可测差异断言）/ 通道 B 回执留档 / P-4 取消中断观察窗。
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p3r3.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, callTool, defineAndRun, definePkg, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V6 = readFileSync(new URL('../versions/refix-v6-p3r2.js', import.meta.url), 'utf8')
const REFIX_V7 = readFileSync(new URL('../versions/refix-v7-p3r3.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')

const h = await setup()
const v6ref = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V6 })
await runPkg(h, v6ref.pluginId, v6ref.packageId, 'run')
const v7ref = definePkg(h, { kind: 'existing', pluginId: v6ref.pluginId }, 'dsh-refix (P3R3)', { host: REFIX_V7 })
await runPkg(h, v6ref.pluginId, v7ref.packageId, 'update')

async function repair(args: any) {
  return JSON.parse(await callTool(h, 'refix_repair', args, AGENT_A))
}

// ── 基础回归 ────────────────────────────────────────────────────────────────
const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })
await h.runner.stop(AGENT_A, patient.pluginId)
let r = await repair({ pluginId: patient.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'success', 'v7 基础 restart 修复应成功: ' + JSON.stringify(r))

// ── P-1：过滤巡检不再吞他插件症状（v6/v7 可测差异）──────────────────────────
// reportRenderFailure 无事件伴随；v6 的过滤巡检会跳过他插件检测（症状不落册），
// v7 检测全量推进 → 症状落册、仅返回视图过滤。
const patx = await defineAndRun(h, 'patwx', 'dsh-patient-x', { host: PATIENT_OK })
const paty = await defineAndRun(h, 'patwy', 'dsh-patient-y', { host: PATIENT_OK })
await callTool(h, 'refix_patrol', {}) // 基线清场
await h.runner.reportRenderFailure(AGENT_A, patx.pluginId, patx.receipt.pluginRunId, {
  slot: 'root', message: 'render broke (P-1 blind-spot test)',
})
const filteredY = JSON.parse(await callTool(h, 'refix_patrol', { pluginId: paty.pluginId }))
assert.equal(filteredY.newSymptoms.length, 0, '过滤视图只返回目标插件症状')
const report1 = await refixReport(h)
const xRender = report1.reports.filter((x: any) => x.kind === 'render-failure' && x.pluginId === patx.pluginId)
assert.equal(xRender.length, 1, 'P-1: 过滤巡检期间他插件的症状必须照常落册（v6 会静默漏掉）')

// ── 通道 B 留档：runHostHalf 批准后 resolveRequestRun 回执 ──────────────────
// 机制（源码核定）：requiresApproval 时 run() 在 startHost 前返回（宿主 L301），
// plugin.run 未建立 → resolveRequestRun(ok:true) 的 runId 闸门（L420）在审批 pending
// 阶段必然失败；批准 = 通道 A runHostHalf(requestId)；通道 B = 批准激活后（client-pending，
// plugin.run 已建）的客户端回执通道。本用例复刻该序列并断言状态一致。
const clientPkg = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient (client fix)', {
  host: PATIENT_OK, client: 'return () => {}',
}).packageId
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId, targetPackageId: clientPkg, observeMs: 300 })
assert.equal(r.outcome, 'awaiting-approval', '客户端半区修复应进入审批流')
const req = h.events.filter(([n]: any) => n === 'cordis/request-run').slice(-1)[0][1]
const started = await (h.runner as any).runHostHalf(AGENT_A, patient.pluginId, clientPkg, 'update', req.requestId, false)
assert.equal(started.ok, true, '通道 A：批准 runHostHalf 应激活成功')
await sleep(50)
// 通道 B：客户端回执（真实浏览器流中发生在 runHostHalf 激活之后）
let receiptAccepted: any = 'threw'
try {
  const ack = await (h.runner as any).resolveRequestRun(req.requestId, { ok: true, pluginRunId: started.pluginRunId })
  receiptAccepted = ack.accepted
} catch (e: any) {
  receiptAccepted = 'threw: ' + ((e && e.message) || e)
}
const report2 = await refixReport(h)
assert.equal(report2.baseline[patient.pluginId].activeRun.packageId, clientPkg,
  '通道 B 回执后激活状态必须保持一致（activeRun 仍为 clientPkg）')
console.log('[archive] 通道 B resolveRequestRun 回执结果 accepted =', receiptAccepted,
  '（留档：宿主对已提交激活的二次回执行为）')

// ── P-4：取消中断观察窗 ────────────────────────────────────────────────────
// 实测宿主契约：ToolRuntime 在 signal abort 时直接中断调用并抛错（不给工具返回机会）；
// refix 内部的 race+checkAborted 是防御纵深（保证 repairing 复位与审计落册）。
const patientG = await defineAndRun(h, 'patwg', 'dsh-patient-g', { host: PATIENT_OK })
await h.runner.stop(AGENT_A, patientG.pluginId)
const aborter = new AbortController()
setTimeout(() => aborter.abort(), 150)
let abortedMsg: string | null = null
let cancelled: any = null
const t0 = Date.now()
try {
  const raw = await callTool(h, 'refix_repair', { pluginId: patientG.pluginId, observeMs: 3000 }, AGENT_A, aborter.signal)
  cancelled = JSON.parse(raw) // v7：内部 race 先赢 → 结构化 failed/exception 返回
} catch (e: any) {
  abortedMsg = (e && e.message) || String(e) // 宿主管线抢先中断的形态
}
const elapsed = Date.now() - t0
if (abortedMsg !== null) {
  assert.ok(elapsed < 2500, 'P-4: 宿主中断应即时（实际 ' + elapsed + 'ms）')
} else {
  assert.equal(cancelled.outcome, 'failed', '取消的修复应如实报告 failed: ' + JSON.stringify(cancelled))
  assert.equal(cancelled.phase, 'exception', '取消应走结构化兜底路径')
  assert.ok(cancelled.detail.includes('cancelled'), '取消详情应可见: ' + cancelled.detail)
  assert.ok(elapsed < 2500, 'P-4: 取消应中断观察窗等待（实际 ' + elapsed + 'ms，observeMs=3000）')
}
// 中断后 refix 引擎状态必须一致：取消的修复已按 failed 入审计并写回知识库
// （从失败中学习）→ 同指纹复发命中即转人工（结构化拒绝 = 引擎存活的证据）
r = await repair({ pluginId: patientG.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'refused', '复发应命中已降级的知识库处方')
assert.equal(r.reason, 'prior-fix-failed', '取消结果应已按 failed 写回知识库: ' + JSON.stringify(r))
// 修复能力完好：全新插件干净修复成功
const patientH = await defineAndRun(h, 'patwh', 'dsh-patient-h', { host: PATIENT_OK })
await h.runner.stop(AGENT_A, patientH.pluginId)
r = await repair({ pluginId: patientH.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'success', '中断后修复能力应完好（状态机复位）: ' + JSON.stringify(r))

console.log('P3R3 SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v6ref.pluginId, v6: v6ref.packageId, v7: v7ref.packageId },
  checks: { p1NoBlind: true, channelBArchived: receiptAccepted, p4AbortMs: elapsed },
}, null, 2))
process.exit(0)
