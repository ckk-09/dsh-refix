#!/usr/bin/env node
/**
 * dsh-refix 静态包离线冒烟测试。
 *
 * 不启动 dsh，用一份**假 ctx**（实现 cordis ctx 的最小可用面）驱动静态包模块，
 * 断言它在真实 ctx 语义下能完成挂载：兼容性自检通过、5 个工具注册（V1.10 起 +export/restore）、
 * inspect provider 注册、15s 巡检定时器、就绪行打印，并且工具真的能执行。
 *
 * 两种模式：
 *   默认           —— 走真 defineTool 路径（L1 裸说明符或 L2 投影目录命中，应无降级告警）
 *   --fallback     —— 把模块复制到 os.tmpdir() 下的隔离目录再加载，**并把两级解析都隔离掉**
 *                     （DSH_HOME / HOME / USERPROFILE 指向空目录），强制走内置兜底编译器
 *
 * 用法：
 *   node deploy/static/test-static.mjs [模块绝对路径]
 *   node deploy/static/test-static.mjs --fallback [模块绝对路径]
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const FALLBACK = argv.includes('--fallback')

// 构建产物入口。按「当前布局 → 历史布局」排序：
//   packages/dsh-refix   —— 现行落点（awesome-dsh-plugin CI 要从 packages/ 子包抓 dsh.bundle）
//   deploy/static/dist   —— df843d2 之前的旧落点，保留只为兼容老检出
// 旧版这里写死的是第二条，导致布局变更后 `test-static` 不带参数直接 ERR_MODULE_NOT_FOUND。
const BUNDLE_CANDIDATES = [
  join(import.meta.dirname, '..', '..', 'packages', 'dsh-refix', 'lib', 'index.js'),
  join(import.meta.dirname, 'dist', 'dsh-refix', 'lib', 'index.js'),
]
const explicit = argv.find((a) => !a.startsWith('--'))
let modulePath
if (explicit) {
  modulePath = resolve(explicit)
} else {
  const hit = BUNDLE_CANDIDATES.find((p) => existsSync(p))
  if (!hit) {
    console.error('test-static: FAIL — 找不到构建产物入口，已尝试：')
    for (const p of BUNDLE_CANDIDATES) console.error('  - ' + p)
    console.error('  先跑 `node deploy/static/build-static.mjs` 生成产物；')
    console.error('  或显式传入入口：node deploy/static/test-static.mjs <模块绝对路径>')
    process.exit(2)
  }
  modulePath = hit
}

let failures = 0
let checks = 0

/**
 * 断言并记录。
 * @param {boolean} condition - 条件。
 * @param {string} label - 断言描述。
 * @param {unknown} [detail] - 失败时附带的实际值。
 * @returns {void}
 */
function ok(condition, label, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  PASS  ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL  ${label}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}\n`)
}

/** 深比较为 JSON 等价。 */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── 假 ctx ─────────────────────────────────────────────────────────────────
const CALLS = { tools: [], inspect: [], intervals: [], events: [], effects: [] }
const READY_LINES = []

/** 假 dynamicCordisRunner：CONTRACT 里点名的每个方法都要是函数（自检会逐个 typeof 检查）。
 * V1.08（I-1）起 CONTRACT 收录 invoke——真实宿主本就有该方法（V1.07 探针即无条件调用），
 * mock 必须补上，否则 F5 会正确地报 contract-incompatible 并降级只读。 */
const runner = {
  define() {}, undefine() {}, run() {}, stop() {},
  invoke() { return { ok: true } },
  inventory() { return [] },
  snapshot() { return {} },
  listPlugins() { return [] },
  inspectPlugin() { return {} },
  inspectPackage() { return {} },
  reference() { return {} },
}

/** 假 cordisInspect：register/list/query。 */
const inspectService = {
  register(provider) { CALLS.inspect.push(provider); return () => {} },
  list() { return [] },
  query() { return {} },
}

/**
 * 假 ctx：生命周语动词 + `ctx.get` + **按 inject 门禁的服务属性访问**。
 *
 * 门禁必须照真 cordis 抄，不能照沙箱 facade 抄 —— 沙箱对 `ctx.tools` 是无条件放行的
 * （`guard.ts` L755），真 ctx 是 `cannot get property "X" without inject`。
 * 照沙箱抄就会漏掉"源码 inject 少写一个服务"，而那正是真机启动当场炸掉整棵插件树的那类 bug。
 * @param {readonly string[]} declared - 被加载模块自己声明的 inject 列表。
 * @returns {object} ctx 代理。
 */
function makeCtx(declared) {
  const services = {
    dynamicCordisRunner: runner,
    cordisInspect: inspectService,
    tools: { register(tool) { CALLS.tools.push(tool); return () => {} } },
  }
  const declaredSet = new Set(declared)
  const verbs = {
    // ctx.get 是可选查找，不要求声明（与真 ctx 一致）。
    get: name => services[name],
    provide: () => () => {},
    on(event) { CALLS.events.push(event); return () => {} },
    effect(callback, label) { CALLS.effects.push(label); const dispose = callback(); return dispose ?? (() => {}) },
    timeout: ms => new Promise(resolveTimeout => setTimeout(resolveTimeout, Math.min(ms, 5))),
    interval(_callback, ms) { CALLS.intervals.push({ ms }); return () => {} },
  }
  return new Proxy(verbs, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      if (services[prop] !== undefined) {
        if (!declaredSet.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return services[prop]
      }
      return undefined
    },
  })
}

// 捕获就绪行与降级告警（模块自身只做 console.log/error，不改写）。
const realLog = console.log
const realError = console.error
const ERROR_LINES = []
console.log = (...args) => {
  READY_LINES.push(args.map(String).join(' '))
  realLog(...args)
}
console.error = (...args) => {
  ERROR_LINES.push(args.map(String).join(' '))
  realError(...args)
}

// ── 加载 ───────────────────────────────────────────────────────────────────
process.stdout.write(`test-static: mode=${FALLBACK ? 'fallback-compiler' : 'real-defineTool'}\n`)
process.stdout.write(`  module ${modulePath}\n`)

let mod
let scratch = null
if (FALLBACK) {
  // 必须把**两级**解析都隔离掉，否则兜底模式会假绿：
  //   L1 裸说明符 —— 副本落在 os.tmpdir()，父级链路上没有 @deepseek-ai/*；
  //   L2 投影目录 —— DSH_HOME / HOME / USERPROFILE 全指向 scratch 下的空目录，
  //                  使 createRequire 按 `<$home>/profiles/node_modules` 解析必然失败。
  scratch = join(tmpdir(), `refix-static-fallback-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const emptyHome = join(scratch, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  process.env.DSH_HOME = join(scratch, 'empty-dsh')
  process.env.HOME = emptyHome
  process.env.USERPROFILE = emptyHome
  const copy = join(scratch, 'index.mjs')
  copyFileSync(modulePath, copy)
  // 以一个 .mjs 副本作 ESM 入口；模块内部只剩裸说明符 import，按父级查找解析。
  mod = await import(pathToFileURL(copy).href)
} else {
  mod = await import(pathToFileURL(modulePath).href)
}

// ── 断言：模块形态 ─────────────────────────────────────────────────────────
ok(mod.name === 'dsh-refix', 'export name === "dsh-refix"', mod.name)
ok(typeof mod.apply === 'function', 'export apply 是函数')
ok(mod.default === undefined, '没有 default 导出（只导出 name/inject/apply）', mod.default !== undefined)

// inject 必须覆盖体里读到的每个服务。tools 是构建期补齐项：沙箱无条件给，真 ctx 要声明。
ok(Array.isArray(mod.inject), 'export inject 是数组', mod.inject)
ok(mod.inject.includes('tools'),
  'inject 含 "tools"（真实 ctx 下 ctx.tools 需声明，沙箱才无条件放行）', mod.inject)
for (const required of ['dynamicCordisRunner', 'cordisInspect', 'timer']) {
  ok(mod.inject.includes(required), `inject 含 "${required}"`, mod.inject)
}

// ── 断言：挂载（ctx 按真 cordis 门禁，未声明的服务属性会被拒）──────────────
mod.apply(makeCtx(mod.inject))

ok(CALLS.inspect.length === 1, 'cordisInspect.register 恰被调用 1 次', CALLS.inspect.length)
ok(CALLS.inspect[0]?.manifest?.id === 'Refix', 'inspect provider manifest.id === "Refix"', CALLS.inspect[0]?.manifest?.id)
ok(CALLS.intervals.length === 1 && CALLS.intervals[0].ms === 15000, 'patrol 定时器 = 15000ms', CALLS.intervals)
ok(CALLS.events.includes('cordis/dynamic-package') && CALLS.events.includes('cordis/dynamic-retract'),
  '订阅 cordis/dynamic-package + cordis/dynamic-retract', CALLS.events)

const toolNames = CALLS.tools.map(t => t.name)
ok(eq(toolNames, ['refix_repair', 'refix_report', 'refix_patrol', 'refix_export', 'refix_restore']), '注册 5 个工具且顺序正确（V1.10: +export/restore）', toolNames)

const readyLine = READY_LINES.find(line => line.includes('ready; contract'))
ok(readyLine !== undefined && readyLine.includes('dsh-refix p3.8 ready; contract OK (兼容性自检通过)'),
  '就绪行含 "contract OK (兼容性自检通过)"', readyLine)
ok(readyLine !== undefined && readyLine.includes('patrol every 15000ms'), '就绪行含 "patrol every 15000ms"', readyLine)

// ── 断言：工具 schema 形状 ─────────────────────────────────────────────────
/** 与源码 describe 一致地重建每个工具的期望参数 schema。 */
const EXPECTED_PARAMS = {
  refix_repair: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: '目标动态插件 ID（须与调用者同会话；不得为 dsh-refix 自身）' },
      symptom: { type: 'string', description: '要修复的症状 kind（省略=该插件最近一条报告）' },
      targetPackageId: { type: 'string', description: '候选修复版本 packageId（省略=策略表/历史方案）' },
      observeMs: { type: 'integer', description: '观察窗时长 ms，默认 30000，上限 120000' },
    },
    required: ['pluginId'],
  },
  // refix_restore 不进逐字段比对（兜底编译器对嵌套 object 产出与真路径不同形），见下方特例断言
  refix_patrol: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: '只返回该插件的症状（省略=全量）' },
    },
  },
}

for (const tool of CALLS.tools) {
  ok(tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object',
    `${tool.name}: parameters 已编译为 object-rooted JSON Schema`, tool.parameters)
  ok(typeof tool.output?.render === 'function', `${tool.name}: output.render 是函数`)
  ok(eq(tool.output?.schema, { type: 'string' }), `${tool.name}: output.schema === {type:"string"}`, tool.output?.schema)
  if (EXPECTED_PARAMS[tool.name] !== undefined) {
    ok(eq(tool.parameters, EXPECTED_PARAMS[tool.name]), `${tool.name}: 参数 Schema 与 DSL 期望值逐字段一致`, tool.parameters)
  }
}
// refix_restore 兜底例外：兜底编译器对嵌套 object 的产出（properties:{}）与真路径不同形，
// 只断言语义（snapshot 必填 + 对象类型），不逐字段比对。
const restoreTool = CALLS.tools.find(t => t.name === 'refix_restore')
if (FALLBACK) {
  ok(restoreTool.parameters?.type === 'object' && restoreTool.parameters?.required?.includes('snapshot'),
    '兜底模式：refix_restore 保留 snapshot 必填语义', restoreTool.parameters)
}

// ── 断言：工具真的能执行 ───────────────────────────────────────────────────
const report = CALLS.tools.find(t => t.name === 'refix_report')
const patrol = CALLS.tools.find(t => t.name === 'refix_patrol')

const reportOut = await report.execute({}, {})
const reportJson = JSON.parse(reportOut)
ok(reportJson.version === 'p3.8', 'refix_report 返回 version p3.8', reportJson.version)
ok(Array.isArray(reportJson.alerts?.alerted) && typeof reportJson.alerts.pending === 'number', 'refix_report 携带 F7 alerts 视图', reportJson.alerts)
ok(reportJson.contract?.ok === true && eq(reportJson.contract.missing, []), 'refix_report 自检 contract.ok === true', reportJson.contract)
// V1.08（I-2）起 refix_report 走 patrol('report') 检测路径：report 本身就是一轮真实检测
// （先判定后推进基线），与 refix_patrol 手动巡检同语义计数，故首轮 report 后 patrolCount === 1。
ok(reportJson.patrolCount === 1, 'refix_report 首轮即完成一轮检测（patrolCount === 1，I-2 行为变化）', reportJson.patrolCount)
ok(Array.isArray(reportJson.reports) && Array.isArray(reportJson.repairs), 'refix_report 返回 reports/repairs 数组')

const patrolOut = await patrol.execute({}, {})
const patrolJson = JSON.parse(patrolOut)
ok(patrolJson.triggered === 'manual' && patrolJson.onlyPid === null, 'refix_patrol 手动巡检返回结构正确', patrolJson)
ok(patrolJson.patrolCount >= 1, 'refix_patrol 推进了 patrolCount', patrolJson.patrolCount)

// ── 反向对照：证明假 ctx 的门禁真的会咬 ─────────────────────────────────────
// 去掉 inject 里的 tools 后不该能挂载成功。这条通过 = 上面那些 apply 相关的 PASS 不是假阳性，
// 也等于在离线就把"真机启动当场炸整棵插件树"那一类 bug 变成一条断言。
let gateThrew = null
try {
  mod.apply(makeCtx(mod.inject.filter(name => name !== 'tools')))
} catch (error) {
  gateThrew = error
}
ok(gateThrew !== null && /cannot get property "tools" without inject/.test(gateThrew.message),
  '反向对照：inject 缺 tools 时挂载按真 cordis 规则失败', gateThrew?.message)

// ── 断言：两条 harness 路径各自的必须证据 ──────────────────────────────────
// 真路径：不得出现降级告警（否则说明两级解析都没成，Schema 断言是在兜底编译器上过的）。
// 兜底路径：**必须**出现降级告警（否则说明这个模式没真的隔离掉两级解析）。
// 断言锚点不绑死告警措辞（措辞随解析级数演进），只锚 "[refix] 静态包：" 前缀 + 兜底编译器关键字。
const degradation = ERROR_LINES.find(line => line.includes('[refix] 静态包：')
  && line.includes('改用内置 schema 编译器'))
if (FALLBACK) {
  ok(degradation !== undefined, '兜底模式：打印了 @deepseek-ai/dsh-tools 不可达告警', ERROR_LINES)
  ok(toolNames.length === 5, '兜底模式：5 个工具仍全部注册（降级不致命）', toolNames)
} else {
  ok(degradation === undefined, '真路径：没有降级告警（harness 用的是宿主真 defineTool）', degradation)
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
console.log = realLog
console.error = realError
if (scratch !== null) rmSync(scratch, { recursive: true, force: true })

process.stdout.write(`\ntest-static: ${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
