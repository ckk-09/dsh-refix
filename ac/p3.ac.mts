/**
 * dsh-refix P3 验收（AC4.1：知识库 + 历史方案复用；失败方案学习转人工）
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p3.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, callTool, defineAndRun, definePkg, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V3 = readFileSync(new URL('../versions/refix-v3-p2.js', import.meta.url), 'utf8')
const REFIX_V4 = readFileSync(new URL('../versions/refix-v4-p3.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')
const PATIENT_BROKEN = readFileSync(new URL('../versions/patient-v2-broken.js', import.meta.url), 'utf8')

const h = await setup()
const v3ref = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V3 })
await runPkg(h, v3ref.pluginId, v3ref.packageId, 'run')
const v4ref = definePkg(h, { kind: 'existing', pluginId: v3ref.pluginId }, 'dsh-refix (P3)', { host: REFIX_V4 })
await runPkg(h, v3ref.pluginId, v4ref.packageId, 'update')

const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })
const A = patient.packageId

async function repair(args: any) {
  return JSON.parse(await callTool(h, 'refix_repair', { observeMs: 300, ...args }))
}
const pkgEvents = () => h.events.filter(([n]: any) => n === 'cordis/dynamic-package' || n === 'cordis/dynamic-retract')

// ── 第一次修复（冷启动，无知识）：run-missing → restart 原版本 ──────────────
await h.runner.stop(AGENT_A, patient.pluginId)
let r = await repair({ pluginId: patient.pluginId })
assert.equal(r.outcome, 'success', '首次修复应成功: ' + JSON.stringify(r))
assert.equal(r.knowledgeHit, null, '冷启动不应命中知识库（AC4.2 冷启动行为）')
let report = await refixReport(h)
assert.equal(report.knowledge.length, 1, '成功处方应入册知识库')
assert.equal(report.knowledge[0].action, 'restart')
assert.equal(report.knowledge[0].target, A)
assert.equal(report.knowledge[0].hits, 0)

// ── AC4.1：同症状复发 → 命中历史方案并直接复用 ─────────────────────────────
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId })
assert.equal(r.outcome, 'success', '复用修复应成功: ' + JSON.stringify(r))
assert.ok(r.knowledgeHit, 'AC4.1: 应报告命中历史方案')
assert.equal(r.knowledgeHit.action, 'restart', 'AC4.1: 复用的应是历史 restart 方案')
assert.equal(r.knowledgeHit.target, A, 'AC4.1: 复用的应是历史 target')
assert.equal(r.plan.fromKnowledge, r.knowledgeHit.id, '计划应标注来自知识库')
report = await refixReport(h)
assert.equal(report.knowledge[0].hits, 1, '复用计数应 +1')

// ── 显式候选版本（模型指令优先于知识库）：switch 到新版本 → 新处方入册 ──────
const B = definePkg(h, { kind: 'existing', pluginId: patient.pluginId }, 'dsh-patient v2 (healthy)', { host: PATIENT_OK }).packageId
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId, targetPackageId: B })
assert.equal(r.outcome, 'success', '显式 switch 修复应成功: ' + JSON.stringify(r))
assert.equal(r.knowledgeHit, null, '显式 target 时模型指令优先，不走知识库')
report = await refixReport(h)
assert.equal(report.knowledge.length, 2, '新处方应入册')
assert.equal(report.knowledge[1].action, 'switch')
assert.equal(report.knowledge[1].target, B)

// ── 跳过 F2 的铁证：不给 target，策略表对 run-missing 只会推 restart，
//    而本次复用得到 switch（只能来自知识库）────────────────────────────────
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId })
assert.equal(r.outcome, 'success', '二次复用应成功: ' + JSON.stringify(r))
assert.equal(r.knowledgeHit.action, 'switch', 'AC4.1: 应复用最新的 switch 历史方案')
assert.equal(r.knowledgeHit.target, B, 'AC4.1: 复用 target 应为 B')
assert.equal(r.plan.action, 'switch', '跳过 F2 铁证：无显式 target 却得到 switch 计划（策略表推不出）')
report = await refixReport(h)
assert.equal(report.baseline[patient.pluginId].activeRun.packageId, B, '复用后应运行 B')

// ── 从失败中学习：历史方案上次失败 → 命中即转人工，不执行 ──────────────────
const brokenC = await defineAndRun(h, 'brkpc', 'dsh-patient-broken', { host: PATIENT_BROKEN })
r = await repair({ pluginId: brokenC.pluginId }) // 最近报告 host-method-error → soft-reset
assert.equal(r.outcome, 'failed', '软重置坏患者应失败（health 仍抛错）')
report = await refixReport(h)
const failedK = report.knowledge.find((k: any) => k.fingerprint === 'host-method-error|' + brokenC.pluginId)
assert.ok(failedK && failedK.outcome === 'failed', '失败处方应入册并标记 failed')
const eventsBefore = pkgEvents().length
r = await repair({ pluginId: brokenC.pluginId })
assert.equal(r.outcome, 'refused', '命中失败历史方案应拒绝执行')
assert.equal(r.reason, 'prior-fix-failed', '拒绝原因应为 prior-fix-failed')
assert.ok(r.detail.includes('转人工'), '应明示转人工')
assert.equal(pkgEvents().length, eventsBefore, '转人工拒绝时不得产生任何 runner 动作')

console.log('P3 SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v3ref.pluginId, v3: v3ref.packageId, v4: v4ref.packageId },
  patient: { pluginId: patient.pluginId, versions: [A, B] },
  knowledge: (await refixReport(h)).knowledge.map((k: any) => ({
    fingerprint: k.fingerprint, action: k.action, target: k.target, outcome: k.outcome, hits: k.hits,
  })),
}, null, 2))
process.exit(0)
