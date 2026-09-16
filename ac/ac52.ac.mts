/**
 * dsh-refix AC5.2 验收：契约探测发现不兼容 → 输出差异报告，不盲目执行修复动作
 * 构造方式：以 v4 源码为底，把契约清单中的 'inventory' 改成 'inventory2'，
 * 等价模拟"DSH 升级后 dynamicCordisRunner.inventory 消失"——走的是同一探测代码路径。
 * 独立进程运行（避免与健康实例的工具重名冲突）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, callTool, defineAndRun, refixReport, setup } from './bench.mts'

const REFIX_V4 = readFileSync(new URL('../versions/refix-v4-p3.js', import.meta.url), 'utf8')
const BROKEN_VARIANT = REFIX_V4.replace("'inventory',", "'inventory2',")
assert.notEqual(BROKEN_VARIANT, REFIX_V4, '变体构造应生效')

const h = await setup()
const broken = await defineAndRun(h, 'refbrk', 'dsh-refix (contract-broken variant)', { host: BROKEN_VARIANT })
assert.equal((broken.receipt as any).status, 'running', '契约不兼容时插件仍应能启动（只报告不动手）')

// 差异报告：contract.ok=false + 缺失清单
const report = JSON.parse(await callTool(h, 'refix_report', {}))
assert.equal(report.contract.ok, false, '兼容性自检应判定不通过')
assert.ok(
  report.contract.missing.some((m: string) => m === 'dynamicCordisRunner.inventory2:missing'),
  '差异报告应列出缺失方法: ' + JSON.stringify(report.contract.missing),
)

// 诊断动作被门控：巡检不执行
const patrol = JSON.parse(await callTool(h, 'refix_patrol', {}))
assert.deepEqual(patrol.newSymptoms, [], '契约不兼容时巡检应被门控（不执行任何诊断动作）')

// 修复动作被门控：拒绝执行
const repair = JSON.parse(await callTool(h, 'refix_repair', { pluginId: broken.pluginId, observeMs: 300 }))
assert.equal(repair.outcome, 'refused', '契约不兼容时修复应拒绝执行')
assert.equal(repair.reason, 'contract-incompatible', '拒绝原因应为 contract-incompatible')
assert.deepEqual(repair.missing, report.contract.missing, '拒绝结果应携带完整差异清单')

console.log('AC5.2 SELF-CHECK PASS')
console.log(JSON.stringify({ contract: report.contract, repairRefused: repair.reason }, null, 2))
process.exit(0)
