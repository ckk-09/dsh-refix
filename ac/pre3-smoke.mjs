#!/usr/bin/env node
/**
 * pre3 语义等价冒烟（Phase 2 版）：同一 fake-ctx 驱动 pre2（手工基线）与 pre3
 * （gen-pre 生成 = V1.10 base + F6 段落）。base 已从 V1.08 演进到 V1.10（含
 * F7/探针两级/持久化/协作放行），故断言口径为【超集等价】：
 *   1) pre2 的全部注册面 ⊆ pre3 注册面；F6 新增符号在 pre3 全部在场；
 *   2) refix_report 双方均可执行，update 段结构等价（enabled/self/rollback），
 *      pre3 额外携带 alerts（F7）视图；
 *   3) V1.08 修复符号 + V1.10 新能力符号随生成继承。
 * 用法：node ac/pre3-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(join(root, 'versions', p), 'utf8')

function fakeCtx(capture) {
  const services = {
    dynamicCordisRunner: {
      define() {}, undefine() {}, run() {}, stop() {},
      invoke() { return Promise.resolve({ ok: true }) },
      inventory() { return [] }, snapshot() { return {} },
      listPlugins() { return [] }, inspectPlugin() { return {} },
      inspectPackage() { return {} }, reference() { return {} },
    },
    cordisInspect: { register() { return () => {} }, list() { return [] }, query() { return {} } },
    agents: { get: () => undefined, list: () => [] },
  }
  const ctx = {
    get: (n) => services[n],
    on: (name) => { capture.events.push(name); return () => {} },
    effect: (fn, id) => { capture.effects.push(id); fn() },
    interval: () => { capture.intervals.push(1) },
    timeout: () => Promise.resolve(),
    tools: { register: (d) => { capture.tools.push(d.name); if (d.name === 'refix_report') capture.report = d } },
    cordisInspect: services.cordisInspect,
    dynamicCordisRunner: services.dynamicCordisRunner,
    agents: services.agents,
    timer: {},
  }
  return ctx
}

function load(file) {
  const capture = { tools: [], events: [], effects: [], intervals: [], report: null }
  const factory = new Function('harness', src(file))
  const plugin = factory({ defineTool: (d) => d })
  plugin.apply(fakeCtx(capture))
  return capture
}

const pre2 = load('refix-v1.1-pre2.js')
const pre3 = load('refix-v1.1-pre3.js')

// 1) 超集注册面
for (const t of pre2.tools) assert.ok(pre3.tools.includes(t), `pre3 缺 pre2 工具 ${t}`)
assert.ok(pre3.tools.includes('refix_export') && pre3.tools.includes('refix_restore'), 'pre3 缺 V1.10 新工具')
for (const e of pre2.events) assert.ok(pre3.events.includes(e), `pre3 缺 pre2 事件 ${e}`)
assert.ok(pre3.events.includes('agent/pre-step'), 'pre3 缺 pre-step 注入（F6+F7 双监听）')
assert.ok(pre3.effects.length >= pre2.effects.length, 'effect 数量回退')
console.log(`  ✓ 注册面超集：pre3 tools=${pre3.tools.length}(+${pre3.tools.length - pre2.tools.length}) events=${pre3.events.length} effects=${pre3.effects.length}（pre2: ${pre2.tools.length}/${pre2.events.length}/${pre2.effects.length}）`)

// 2) 报告可执行 + update 段等价 + pre3 独有 alerts
async function reportOf(file) {
  const capture = { tools: [], events: [], effects: [], intervals: [], report: null }
  const factory = new Function('harness', src(file))
  factory({ defineTool: (d) => d }).apply(fakeCtx(capture))
  const report = capture.report
  assert.ok(report, 'refix_report 未注册')
  return JSON.parse(await report.execute({}, {}))
}
const r2 = await reportOf('refix-v1.1-pre2.js')
const r3 = await reportOf('refix-v1.1-pre3.js')
assert.equal(r2.version, 'p3.6', 'pre2 版本自报不符')
assert.equal(r3.version, 'p3.9', 'pre3 版本自报不符')
assert.equal(r3.update.enabled, true, 'pre3 update 段缺失')
assert.ok(r3.update.self && 'pluginId' in r3.update.self && 'rollback' in r3.update, 'pre3 update.self/rollback 缺失（U-7/U-8 语义）')
assert.ok(r3.alerts && Array.isArray(r3.alerts.alerted), 'pre3 缺 F7 alerts 视图')
console.log('  ✓ refix_report 双方可执行：update 段等价（enabled/self/rollback），pre3 额外携带 alerts（F7）')

// 3) 符号继承矩阵
const p3 = src('refix-v1.1-pre3.js')
const inherits = [
  ['I-1 CONTRACT 补 invoke', /dynamicCordisRunner:\s*\[[^\]]*'invoke'/],
  ['I-2 report 走 patrol', /await patrol\('report'\)/],
  ['I-3 resolveSelfPluginId', /function resolveSelfPluginId\(\)/],
  ['I-5 cancelled 分账', /outcome: 'cancelled', phase: 'cancelled'/],
  ['I-7 结构化键', /JSON\.stringify\(\[kind, pluginId,/],
  ['P1 F7 告警', /refix\.ev-pre-step-alert/],
  ['P2 探针标定缓存', /probeMethodCache/],
  ['P3 导出/回填', /schemaVersion: 1/],
  ['P4 同 Team 放行', /trySameTeamAllow/],
]
for (const [name, re] of inherits) assert.ok(re.test(p3), `${name} 未随生成继承`)
console.log('  ✓ 继承矩阵：V1.08 六项修复 + V1.10 四项能力全部随生成继承')

console.log('pre3-smoke: PASS（pre2 ↔ pre3 超集等价）')
