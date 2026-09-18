#!/usr/bin/env node
/**
 * N 系列结构化断言（独立审查 2026-09-18 修复版 · 静态可离线验证部分）
 * 覆盖：I-1 CONTRACT补invoke / I-2 report走patrol / I-3 U-7反查回灌 / I-4 updater同会话校验 /
 *       I-5 cancelled分账 / I-7 结构化键+probeSkipped清理 / manifest 版本升级
 * 含反向对照：对基线 refix-v1.07.js 断言"修复标志不存在"，证明断言真的会咬。
 * 用法：node ac/n-series.static-check.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
let checks = 0
const ok = (name, cond) => {
  checks += 1
  if (!cond) { failures += 1; console.error('  ✗ ' + name) } else { console.log('  ✓ ' + name) }
}
const src = (p) => readFileSync(join(root, p), 'utf8')

const v108 = src('versions/refix-v1.08.js')
const v107 = src('versions/refix-v1.07.js')
const upd = src('versions/refix-updater-v1.1-pre.js')
const manifest = JSON.parse(src('versions/manifest.json'))
const built = src('packages/dsh-refix/lib/index.js')

console.log('[I-1] CONTRACT 补 invoke（🔴P1）')
ok('v1.08 CONTRACT 行含 invoke', /dynamicCordisRunner:\s*\[[^\]]*['"]invoke['"]/.test(v108))
ok('v1.07 基线 CONTRACT 不含 invoke（反向对照）', !/dynamicCordisRunner:\s*\[[^\]]*['"]invoke['"]/.test(v107))
ok('构建产物同样含 invoke 契约', /dynamicCordisRunner:\s*\[[^\]]*['"]invoke['"]/.test(built))

console.log('[I-2] refix_report 走 patrol 检测路径')
ok("report execute 调用 patrol('report')", /await patrol\('report'\)/.test(v108))
ok('report 不再直接 snapshotInventory 推进基线', !/if \(contractMissing\.length === 0\) snapshotInventory\(\)\n\s*const limit/.test(v108))
ok('report 等待探针 drain', /round\.drain, ctx\.timeout\(DRAIN_TIMEOUT_MS\)/.test(v108))
ok('v1.07 基线 report 为 snapshotInventory 直推（反向对照）', /if \(contractMissing\.length === 0\) snapshotInventory\(\)\n\s*const limit/.test(v107))
ok('初始基线 snapshotInventory 仍保留（启动时无 prev，合法）', /contractMissing\.length === 0\) snapshotInventory\(\)$/.test(v108.trimEnd()) || /contractMissing\.length === 0\) snapshotInventory\(\)\s*\n\s*\/\/ ── F2/.test(v108))

console.log('[I-3] U-7 身份反查兜底回灌')
ok('存在 resolveSelfPluginId 定义', /function resolveSelfPluginId\(\)/.test(v108))
ok('反查按 packages[].name 前缀匹配 SELF_PLUGIN_NAME', /p\.name\.indexOf\(SELF_PLUGIN_NAME\) === 0/.test(v108))
ok('自修复闸改用 resolveSelfPluginId', /const selfPid = resolveSelfPluginId\(\)/.test(v108) && /selfPid !== null && args\.pluginId === selfPid/.test(v108))
ok('v1.07 基线无反查兜底（反向对照）', !/resolveSelfPluginId/.test(v107))

console.log('[I-4] updater doApply 同会话校验')
ok('doApply 含 cross-session 拒绝', /exec\.agent\.id !== t\.agentId/.test(upd) && /reason: 'cross-session'/.test(upd))
ok('校验在票据消费前（consumed 赋值在校验之后）', upd.indexOf("reason: 'cross-session'") < upd.indexOf('t.consumed = true'))

console.log('[I-5] cancelled 与 failed 分账')
ok("checkAborted 异常归为 outcome:'cancelled'", /outcome: 'cancelled', phase: 'cancelled'/.test(v108))
ok('取消识别含信号位兜底（exec.signal.aborted）', /exec\.signal && exec\.signal\.aborted/.test(v108))
ok('知识库写入仅 success|failed（cancelled 自然不入库）', /result\.outcome === 'success' \|\| result\.outcome === 'failed'/.test(v108))
ok('审计 repairs 仍记录取消结果（record.outcome 赋值无过滤）', /record\.outcome = result\.outcome/.test(v108))

console.log('[I-7] 结构化键 + probeSkipped 清理')
ok('addReport 去重键 JSON 结构化', /JSON\.stringify\(\[kind, pluginId,/.test(v108))
ok('run-missing 清理用 JSON.parse 解析', /try \{ k = JSON\.parse\(key\) \} catch/.test(v108))
ok('probeSkipped 键 JSON 结构化', /JSON\.stringify\(\[row\.pluginId, row\.activeRun\.packageId\]\)/.test(v108))
ok('retract 处理器清理该插件 probeSkipped', /k\[0\] === pid\) probeSkipped\.delete\(sk\)/.test(v108))
ok("v1.07 基线仍为 '|' 拼接键（反向对照）", /key = kind \+ '\|' \+ pluginId/.test(v107))

console.log('[manifest] 版本升级')
ok('latest = p3.7', manifest.latest === 'p3.7')
ok('version = V1.08', manifest.version === 'V1.08')
ok('file 指向 refix-v1.08.js', manifest.file === 'versions/refix-v1.08.js')
ok('static packageVersion = 1.3.0', manifest.static.packageVersion === '1.3.0')
ok('static sourceFile 指向 v1.08', manifest.static.sourceFile === 'versions/refix-v1.08.js')

console.log('[build] 静态包产物一致性')
ok('构建产物自报 p3.7', built.includes("'p3.7'"))
ok('构建产物含 resolveSelfPluginId（I-3 随源码进入静态包）', built.includes('resolveSelfPluginId'))
ok('构建产物含 cancelled 分账', built.includes("outcome: 'cancelled', phase: 'cancelled'"))

console.log('')
if (failures > 0) { console.error(`n-series: ${failures}/${checks} FAILED`); process.exit(1) }
console.log(`n-series: ${checks}/${checks} passed`)
