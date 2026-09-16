/**
 * dsh-refix P3 审查修复版验收（v5 = p3.2）
 * 覆盖审查报告测试盲区：T-1 挂起探针不锁死 / T-2 运行中热更新不误报 / T-3 拒绝自修复 /
 * T-5 参数边界 / V-6 probeSkipped 按版本复活 / V-13 假回退消除 / V-8 limit 参数。
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p3r.ac.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, callTool, defineAndRun, definePkg, refixReport, runPkg, setup, sleep } from './bench.mts'

const REFIX_V4 = readFileSync(new URL('../versions/refix-v4-p3.js', import.meta.url), 'utf8')
const REFIX_V5 = readFileSync(new URL('../versions/refix-v5-p3r.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')

// T-1 夹具：health 永不 resolve（审查报告 V-1 复现用例）
const HANG = `return {
  name: 'dsh-hang',
  inject: [],
  apply(ctx) {
    harness.handle('health', function () { return new Promise(function () {}) })
  },
}`
// V-6 夹具：v1 无 health 探针，v2 注册必抛错的 health
const NOHEALTH_V1 = `return {
  name: 'dsh-nohealth',
  inject: [],
  apply(ctx) {
    harness.handle('ping', function () { return { ok: true } })
  },
}`
const NOHEALTH_V2 = `return {
  name: 'dsh-nohealth v2 (health 抛错)',
  inject: [],
  apply(ctx) {
    harness.handle('ping', function () { return { ok: true } })
    harness.handle('health', function () { throw new Error('nohealth-broken: v2 才有 health 且必抛') })
  },
}`

const h = await setup()
const v4ref = definePkg(h, { kind: 'new', idPrefix: 'refix' }, 'dsh-refix', { host: REFIX_V4 })
await runPkg(h, v4ref.pluginId, v4ref.packageId, 'run')
const v5ref = definePkg(h, { kind: 'existing', pluginId: v4ref.pluginId }, 'dsh-refix (P3 审查修复)', { host: REFIX_V5 })
await runPkg(h, v4ref.pluginId, v5ref.packageId, 'update')

async function repair(args: any) {
  return JSON.parse(await callTool(h, 'refix_repair', args))
}

// ── 基础回归：v5 修复能力完好 ───────────────────────────────────────────────
const patient = await defineAndRun(h, 'patnt', 'dsh-patient', { host: PATIENT_OK })
const V1 = patient.packageId
await h.runner.stop(AGENT_A, patient.pluginId)
let r = await repair({ pluginId: patient.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'success', 'v5 基础 restart 修复应成功: ' + JSON.stringify(r))
assert.equal(r.plan.action, 'restart')

// ── T-1：挂起的 health 不锁死 refix（V-1）──────────────────────────────────
const hang = await defineAndRun(h, 'hangp', 'dsh-hang', { host: HANG })
const t0 = Date.now()
const patrol1 = JSON.parse(await callTool(h, 'refix_patrol', {}))
const patrolMs = Date.now() - t0
assert.ok(patrolMs < 10000, '挂起探针下 refix_patrol 应在有界时间内返回（实际 ' + patrolMs + 'ms）')
assert.equal(patrol1.newSymptoms.filter((s: any) => s.pluginId === hang.pluginId).length, 0,
  '探针超时不得计为症状（策略表未收录）')
await h.runner.stop(AGENT_A, patient.pluginId)
r = await repair({ pluginId: patient.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'success', '挂起探针存在时修复仍应正常（repairing 未被锁死）')

// ── T-2：运行中热更新不误报 run-missing（IN_FLIGHT + V-5 计数）─────────────
const patientB = await defineAndRun(h, 'patnb', 'dsh-patient-b', { host: PATIENT_OK })
const B2 = definePkg(h, { kind: 'existing', pluginId: patientB.pluginId }, 'dsh-patient-b v2 (healthy)', { host: PATIENT_OK }).packageId
await runPkg(h, patientB.pluginId, B2, 'update')
await sleep(100)
await callTool(h, 'refix_patrol', {})
let report = await refixReport(h)
const missB = report.reports.filter((x: any) => x.kind === 'run-missing' && x.pluginId === patientB.pluginId)
assert.equal(missB.length, 0, '运行中热更新不得报 run-missing: ' + JSON.stringify(missB))
assert.equal(report.baseline[patientB.pluginId].activeRun.packageId, B2, '热更新后应运行 v2')

// ── T-3：拒绝对 dsh-refix 自身修复（V-2）───────────────────────────────────
r = await repair({ pluginId: v4ref.pluginId, observeMs: 300 })
assert.equal(r.outcome, 'refused', '对自身修复应被拒绝')
assert.equal(r.reason, 'self-repair-forbidden', '拒绝原因应为 self-repair-forbidden')

// ── T-5：参数边界（V-3 clamp / O-2 预校验 / V-13 假回退）───────────────────
await h.runner.stop(AGENT_A, patient.pluginId)
const t1 = Date.now()
r = await repair({ pluginId: patient.pluginId, observeMs: -5 }) // 负数 → clamp 0
assert.equal(r.outcome, 'success', 'observeMs=-5 应被钳制并正常完成')
assert.ok(Date.now() - t1 < 10000, 'clamp 0 观察窗应即时完成')
r = await repair({ pluginId: patient.pluginId, targetPackageId: 'pkg-nonexistent' })
assert.equal(r.outcome, 'refused', '不存在的目标包应被预校验拒绝')
assert.equal(r.reason, 'target-not-found', '拒绝原因应为 target-not-found')
r = await repair({ pluginId: patient.pluginId, targetPackageId: V1 }) // target === current
assert.equal(r.outcome, 'success', 'target=当前版本（重启语义）应成功')
assert.equal(r.plan.fallback, null, 'V-13: target===current 时 fallback 必须为 null（不做假回退）')

// ── V-6：插件新版本注册 health 后探针自动复活 ──────────────────────────────
const nohealth = await defineAndRun(h, 'nohlth', 'dsh-nohealth', { host: NOHEALTH_V1 })
await callTool(h, 'refix_patrol', {}) // v1 无 health → probeSkipped（按 pid|packageId 记）
const NH2 = definePkg(h, { kind: 'existing', pluginId: nohealth.pluginId }, 'dsh-nohealth v2', { host: NOHEALTH_V2 }).packageId
await runPkg(h, nohealth.pluginId, NH2, 'update') // 运行中热更新（不误报）
await sleep(50)
await callTool(h, 'refix_patrol', {}) // 触发一轮巡检（含 drain）
const hm = (await refixReport(h)).reports.filter((x: any) =>
  x.kind === 'host-method-error' && x.pluginId === nohealth.pluginId)
assert.equal(hm.length, 1, 'V-6: 新版本注册 health 后探针应复活并报出 host-method-error: '
  + JSON.stringify((await refixReport(h)).reports.map((x: any) => x.kind + '@' + x.pluginId)))

// ── V-8：refix_report limit 参数 ───────────────────────────────────────────
report = await refixReport(h)
const limited = JSON.parse(await callTool(h, 'refix_report', { limit: 1 }))
assert.equal(limited.reports.length, 1, 'limit=1 应只返回最近 1 条报告')
assert.ok(report.reports.length >= limited.reports.length, '全量报告应不少于受限报告')

console.log('P3R SELF-CHECK PASS')
console.log(JSON.stringify({
  refix: { pluginId: v4ref.pluginId, v4: v4ref.packageId, v5: v5ref.packageId },
  hangPlugin: hang.pluginId,
  t1PatrolMs: patrolMs,
  knowledge: report.knowledge.map((k: any) => ({
    fingerprint: k.fingerprint, action: k.action, outcome: k.outcome, hits: k.hits, attempts: k.attempts,
  })),
}, null, 2))
process.exit(0)
