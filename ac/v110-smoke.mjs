#!/usr/bin/env node
/**
 * V1.10 快速冒烟：fake-ctx 驱动 refix-v1.10.js，断言
 *   1) 注册面：3 工具 + 4 cordis 事件 + F7 pre-step 监听 + 1 interval；
 *   2) refix_report 可执行且含 alerts 字段（F7 视图）与 contract OK（I-1 invoke 契约）；
 *   3) F7 行为：fake runner 报 method-not-found → 巡检产出 host-method-error？
 *      否（method-not-found 不算症状）——改为直接驱动 addReport 路径：
 *      构造 inventory diff 触发 run-missing → alerts.pending=1 → pre-step 消费后归零。
 * 用法：node ac/v110-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'versions', 'refix-v1.10.js'), 'utf8')

/** fake inventory 行 */
const rowOf = (pid, active) => ({
  pluginId: pid, agentId: 'S-a',
  currentPackageId: 'pkg-1',
  activeRun: active ? { pluginRunId: 'run-1', packageId: 'pkg-1' } : null,
  latestRun: active ? { status: 'ok', pluginRunId: 'run-1' } : null,
})

function build(invokeImpl, inventoryRows) {
  const registered = { tools: [], events: [], effects: [], intervals: [] }
  let preStepHandler = null
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke: invokeImpl || (() => Promise.resolve({ ok: true })),
      inventory: () => inventoryRows,
      snapshot() { return {} }, listPlugins() { return [] },
      inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: (id) => (id === 'S-a' ? { id: 'S-a' } : undefined), list: () => [{ id: 'S-a' }] },
  }
  const ctx = {
    get: (n) => services[n],
    on: (name, fn) => {
      registered.events.push(name)
      if (name === 'agent/pre-step') preStepHandler = fn
      return () => {}
    },
    effect: (fn, id) => { registered.effects.push(id); fn() },
    interval: (fn, ms) => { registered.intervals.push(ms) },
    timeout: () => Promise.resolve(),
    tools: { register: (d) => { registered.tools.push(d.name) } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  const factory = new Function('harness', source)
  const plugin = factory({ defineTool: (d) => d })
  plugin.apply(ctx)
  return { registered, getReport: () => registered.tools.includes('refix_report') && reportTool(ctx), preStepHandler, ctx, services }
}
let reportDef = null
function reportTool() { return reportDef }

// ── 场景 1：注册面 + 报告视图 ────────────────────────────────────────────
{
  reportDef = null
  const orig = build(() => Promise.resolve({ ok: true }), [])
  // report 工具句柄要从 tools.register 拿：重跑一次带捕获
  const cap = { tools: [], events: [], effects: [], intervals: [] }
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke: () => Promise.resolve({ ok: true }),
      inventory: () => [],
      snapshot() { return {} }, listPlugins() { return [] },
      inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: () => undefined, list: () => [] },
  }
  const ctx = {
    get: (n) => services[n],
    on: (n) => { cap.events.push(n); return () => {} },
    effect: (fn, id) => { cap.effects.push(id); fn() },
    interval: () => {},
    timeout: () => Promise.resolve(),
    tools: { register: (d) => { cap.tools.push(d); } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  const factory = new Function('harness', source)
  factory({ defineTool: (d) => d }).apply(ctx)
  assert.deepEqual(cap.tools.map(t => t.name),
    ['refix_repair', 'refix_report', 'refix_patrol', 'refix_export', 'refix_restore'], '工具注册面不符')
  assert.ok(cap.events.includes('agent/pre-step'), 'F7 pre-step 监听未注册')
  assert.equal(cap.events.filter(n => n === 'agent/pre-step').length, 1, 'pre-step 注册次数异常')
  const report = cap.tools.find(t => t.name === 'refix_report')
  const json = JSON.parse(await report.execute({}, {}))
  assert.equal(json.version, 'p3.8', '版本自报不符')
  assert.equal(json.contract.ok, true, '契约自检未过（I-1 invoke 应在 fake runner 中）')
  assert.ok(json.alerts && json.alerts.pending === 0 && Array.isArray(json.alerts.alerted), 'F7 alerts 视图缺失')
  console.log('  ✓ 注册面 + 报告视图（p3.8 / contract OK / alerts 字段）')
}

// ── 场景 2：F7 告警全链路（run-missing 落册 → 入队 → pre-step 消费）──────
{
  const rows0 = [rowOf('patient-1', true)]
  const rows1 = [rowOf('patient-1', false)] // run 消失
  let inv = rows0
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke: () => Promise.resolve({ ok: true, value: null }),
      inventory: () => inv,
      snapshot() { return {} }, listPlugins() { return [] },
      inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: (id) => (id === 'S-a' ? { id: 'S-a' } : undefined), list: () => [{ id: 'S-a' }] },
  }
  let reportToolRef = null
  let patrolToolRef = null
  let varPreStep = null
  const ctx = {
    get: (n) => services[n],
    on: (name, fn) => { if (name === 'agent/pre-step') varPreStep = fn; return () => {} },
    effect: (fn) => fn(),
    interval: () => {},
    timeout: () => Promise.resolve(),
    tools: { register: (d) => { if (d.name === 'refix_patrol') patrolToolRef = d; if (d.name === 'refix_report') reportToolRef = d } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  const factory = new Function('harness', source)
  factory({ defineTool: (d) => d }).apply(ctx)
  assert.ok(varPreStep && patrolToolRef && reportToolRef, '关键句柄未注册')

  // 首轮基线（无 prev → 无症状）
  await patrolToolRef.execute({}, {})
  // 第二轮：run 消失 → run-missing 落册 + F7 入队
  inv = rows1
  const round = JSON.parse(await patrolToolRef.execute({}, {}))
  assert.equal(round.newSymptoms.length, 1, 'run-missing 未检出')
  assert.equal(round.newSymptoms[0].kind, 'run-missing', '症状类型不符')
  const after = JSON.parse(await reportToolRef.execute({}, {}))
  assert.equal(after.alerts.pending, 1, 'F7 告警未入队')
  assert.equal(after.alerts.alerted.length, 1, 'F7 去重键未记录')
  // pre-step 消费：decision 附加一条 plugin source 消息
  const decision = { kind: 'continue', messages: [] }
  const out = await varPreStep({ signal: null }, async () => decision)
  assert.equal(out.messages.length, 1, 'F7 未注入消息')
  assert.equal(out.messages[0].source.kind, 'plugin', '注入消息 source 标注缺失')
  assert.ok(out.messages[0].content[0].text.includes('run-missing @ patient-1'), '告警文本缺关键定位')
  assert.ok(out.messages[0].content[0].text.includes('refix_repair'), '告警文本缺修复指引')
  const consumed = JSON.parse(await reportToolRef.execute({}, {}))
  assert.equal(consumed.alerts.pending, 0, 'F7 告警未一次性消费')
  // 去重：同插件同症状再次发生不再入队（消费后 alertedKeys 仍挡）
  inv = rows0
  await patrolToolRef.execute({}, {})
  inv = rows1
  await patrolToolRef.execute({}, {})
  const dedup = JSON.parse(await reportToolRef.execute({}, {}))
  assert.equal(dedup.alerts.pending, 0, 'F7 同症状重复入队（应会话期一次）')
  console.log('  ✓ F7 全链路：落册→入队→pre-step 注入→一次性消费→同症状去重')
}

// ── 场景 3：P2 探针两级（method-not-found → L2 结构面，后续零调用）──────
{
  let inv = [rowOf('nohealth-1', true)]
  let invokeCount = 0
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke: () => { invokeCount += 1; return Promise.resolve({ ok: false, code: 'method-not-found', message: 'no health' }) },
      inventory: () => inv,
      snapshot() { return {} }, listPlugins() { return [] },
      inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: (id) => (id === 'S-a' ? { id: 'S-a' } : undefined), list: () => [{ id: 'S-a' }] },
  }
  let patrolToolRef = null
  const ctx = {
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => fn(),
    interval: () => {},
    timeout: () => Promise.resolve(),
    tools: { register: (d) => { if (d.name === 'refix_patrol') patrolToolRef = d } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  const factory = new Function('harness', source)
  factory({ defineTool: (d) => d }).apply(ctx)
  await patrolToolRef.execute({}, {}) // L1 首探：method-not-found → 标定 L2
  assert.equal(invokeCount, 1, 'L1 首探次数异常')
  await patrolToolRef.execute({}, {}) // L2：零调用
  await patrolToolRef.execute({}, {}) // L2：零调用
  assert.equal(invokeCount, 1, 'L2 结构面后仍发起探针（应为零调用）')
  console.log('  ✓ P2 探针两级：method-not-found 标定后转入 L2 零调用（10 轮盲区消除）')
}

// ── 场景 4：P3 知识库导出/回填（校验拒绝脏数据 + 同指纹跳过 + 环形上限）──
{
  let exportToolRef = null
  let restoreToolRef = null
  let reportToolRef = null
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke: () => Promise.resolve({ ok: true }), inventory: () => [],
      snapshot() { return {} }, listPlugins() { return [] },
      inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: () => undefined, list: () => [] },
  }
  const ctx = {
    get: (n) => services[n],
    on: () => () => {}, effect: (fn) => fn(), interval: () => {}, timeout: () => Promise.resolve(),
    tools: { register: (d) => { if (d.name === 'refix_export') exportToolRef = d; if (d.name === 'refix_restore') restoreToolRef = d; if (d.name === 'refix_report') reportToolRef = d } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  const factory = new Function('harness', source)
  factory({ defineTool: (d) => d }).apply(ctx)
  const empty = JSON.parse(await exportToolRef.execute({}, {}))
  assert.equal(empty.schemaVersion, 1, '导出缺 schemaVersion')
  assert.equal(empty.count, 0, '初始知识库应为空')
  // 回填：2 合法 + 1 脏数据（bad-action）+ 1 重复指纹
  const snap = {
    schemaVersion: 1, version: 'p3.7', exportedAt: 1, count: 4,
    knowledge: [
      { id: 'refix-k1', fingerprint: 'run-missing|p-a', symptom: 'run-missing', action: 'restart', target: 'pkg-1', outcome: 'success', hits: 2, attempts: 2, successes: 2, failures: 0, ts: 1, fromRepair: 'refix-x1' },
      { id: 'refix-k2', fingerprint: 'host-method-error|p-b', symptom: 'host-method-error', action: 'soft-reset', target: 'pkg-2', outcome: 'failed', hits: 0, attempts: 1, successes: 0, failures: 1, ts: 2, fromRepair: 'refix-x2' },
      { id: 'refix-k3', fingerprint: 'run-missing|p-c', symptom: 'run-missing', action: 'explode', target: null, outcome: 'success', ts: 3 },
      { id: 'refix-k1-dup', fingerprint: 'run-missing|p-a', symptom: 'run-missing', action: 'restart', target: 'pkg-1', outcome: 'success', ts: 4 },
    ],
  }
  const r1 = JSON.parse(await restoreToolRef.execute({ snapshot: snap }, {}))
  assert.equal(r1.outcome, 'ok', '回填拒绝合法快照')
  assert.equal(r1.accepted, 2, '接受数不符')
  assert.equal(r1.skippedDuplicate, 1, '同指纹跳过数不符')
  assert.equal(r1.rejected, 1, '脏数据拒绝数不符')
  assert.equal(r1.reasons['bad-action'], 1, '拒绝原因归类缺失')
  // 重复整包回填 → 全部 duplicate
  const r2 = JSON.parse(await restoreToolRef.execute({ snapshot: snap }, {}))
  assert.equal(r2.accepted, 0, '二次回填不应重复接受')
  assert.equal(r2.skippedDuplicate, 3, '二次回填同指纹跳过数不符（2 接受过 + 1 原跳过）')
  // 导出可见回填成果，且本地重编号（restoredFrom 留档）
  const after = JSON.parse(await exportToolRef.execute({}, {}))
  assert.equal(after.count, 2, '回填后知识库条数不符')
  assert.ok(after.knowledge.every(k => k.restored === true && k.restoredFrom), 'restoredFrom 留档缺失')
  const view = JSON.parse(await reportToolRef.execute({}, {}))
  assert.equal(view.knowledge.length, 2, 'selfCheck.knowledge 与知识库不同步')
  console.log('  ✓ P3 导出/回填：schemaVersion 校验 + 脏数据拒绝 + 同指纹保守跳过 + restoredFrom 留档')
}

// ── 场景 5：P4 同 Team 代修门禁（同队放行越过会话闸；无 agentTeams/跨队仍拒）──
{
  const rowB = { pluginId: 'patient-1', agentId: 'S-b', currentPackageId: 'pkg-1', activeRun: null, latestRun: null }
  async function repairOutcome(withTeams) {
    let repairToolRef = null
    const teamsSvc = withTeams ? { tryMembership: (agent) => (agent.id === 'S-a' ? { root: agent, id: 'team-1', role: 'lead', name: 'lead' } : { root: agent, id: 'team-1', role: 'teammate', name: 'qa' }) } : null
    const services = {
      dynamicCordisRunner: {
        define() {}, undefine() {}, run() {}, stop() {},
        invoke: () => Promise.resolve({ ok: true }), inventory: () => [rowB],
        snapshot() { return {} }, listPlugins() { return [] },
        inspectPlugin() { return {} }, inspectPackage() { return {} }, reference() { return {} },
      },
      cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
      agents: { get: (id) => (id === 'S-a' || id === 'S-b' ? { id: id } : undefined), list: () => [] },
    }
    const ctx = {
      get: (n) => (n === 'agentTeams' ? teamsSvc : services[n]),
      on: () => () => {}, effect: (fn) => fn(), interval: () => {}, timeout: () => Promise.resolve(),
      tools: { register: (d) => { if (d.name === 'refix_repair') repairToolRef = d } },
      cordisInspect: services.cordisInspect,
      dynamicCordisRunner: services.dynamicCordisRunner,
      agents: services.agents,
      timer: {},
    }
    const factory = new Function('harness', source)
    factory({ defineTool: (d) => d }).apply(ctx)
    const out = await repairToolRef.execute({ pluginId: 'patient-1', symptom: 'run-missing' }, { agent: { id: 'S-a' } })
    return JSON.parse(out)
  }
  const refused = await repairOutcome(false)
  assert.equal(refused.reason, 'cross-session', '无 agentTeams 时跨会话应拒绝')
  const allowed = await repairOutcome(true)
  assert.notEqual(allowed.reason, 'cross-session', '同 Team 成员应越过会话闸')
  // 放行后推进到执行链（fake runner 下 outcome=failed/exception 即已越过全部门禁）
  assert.ok(allowed.outcome === 'failed' || allowed.outcome === 'refused', '同队放行后应推进到执行链或下一道闸')
  console.log('  ✓ P4 同 Team 代修门禁：同队越过会话闸并推进执行链（无 agentTeams/异队仍 cross-session 拒绝）')
}

console.log('v110-smoke: PASS')
