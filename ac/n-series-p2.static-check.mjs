#!/usr/bin/env node
/**
 * N 系列 · Phase 2 结构化断言（P0 生成式定版 / P1 F7 / P2 探针两级 / P3 持久化 / P4 协作放行）
 * 含反向对照：对基线 refix-v1.08.js 断言"Phase 2 标志不存在"，证明断言真的会咬。
 * 用法：node ac/n-series-p2.static-check.mjs
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

const v110 = src('versions/refix-v1.10.js')
const v108 = src('versions/refix-v1.08.js')
const pre3 = src('versions/refix-v1.1-pre3.js')
const gen = src('tools/gen-pre.mjs')
const f6seg = src('tools/segments/f6.mjs')
const manifest = JSON.parse(src('versions/manifest.json'))
const built = src('packages/dsh-refix/lib/index.js')

console.log('[P0] 生成式定版')
ok('base 含 7 处 @refix-gen 锚点', (v110.match(/@refix-gen:/g) || []).length === 7)
ok('锚点为惰性注释（node 语法合法由外层 --check 保证）', v110.includes('// @refix-gen:constants'))
ok('pre3 无残留锚点（全部被消费）', !pre3.includes('@refix-gen:'))
ok('pre3 带生成横幅（勿手改警示）', pre3.includes('本文件由 tools/gen-pre.mjs 生成'))
ok('gen-pre 带逐行验签防漂移守卫', gen.includes('禁止盲替') && gen.includes('未消费的 @refix-gen 锚点'))
ok('段落库单源 F6（resolveSelfIdentity 复用 base 反查）', f6seg.includes('resolveSelfPluginId()') && !/packages\[\]\.name/.test(f6seg.split('resolveSelfIdentity')[1] || ''))
ok('pre3 自报 p3.9', /const REFIX_VERSION = 'p3\.9'/.test(pre3))
ok('反向对照：v1.08 无生成横幅', !v108.includes('gen-pre.mjs 生成'))

console.log('[P1] F7 主动告警')
ok('告警状态：pendingAlerts + alertedKeys（JSON 结构化去重）', /const pendingAlerts = \[\]/.test(v110) && /const alertedKeys = new Set\(\)/.test(v110))
ok('仅高危症状入队（run-missing / host-method-error）', /kind === 'run-missing' \|\| kind === 'host-method-error'/.test(v110))
ok('队列环形上限 CAPS.alerts', v110.includes('const CAPS = { reports: 100, repairs: 100, knowledge: 100, keys: 1000, alerts: 10 }') && v110.includes('pendingAlerts.length > CAPS.alerts) pendingAlerts.shift()'))
ok('pre-step 注入监听（一次性 splice 消费）', /pendingAlerts\.splice\(0, pendingAlerts\.length\)/.test(v110) && /refix\.ev-pre-step-alert/.test(v110))
ok('注入消息 plugin source 标注（与真实用户输入区分）', /kind: 'plugin',\s*\n\s*plugin: SELF_PLUGIN_NAME/.test(v110))
ok('selfCheck 暴露 alerts 视图', /alerts: \{ pending: pendingAlerts\.length, alerted: Array\.from\(alertedKeys\) \}/.test(v110))
ok('反向对照：v1.08 无 F7 监听', !v108.includes('refix.ev-pre-step-alert'))

console.log('[P2] 探针两级化')
ok('标定缓存 probeMethodCache（per 版本）', /const probeMethodCache = new Map\(\)/.test(v110))
ok('L2 结构面：标定 null 后零调用', /probeMethodCache\.get\(probeKey\) === null\) return/.test(v110))
ok('L1 失败标定 + 每版本一次留痕', /method-not-found/.test(v110) && /转入 L2 结构面存活判定（零探针，每版本留痕一次）/.test(v110))
ok('标定缓存环形逐出（CAPS.keys）', /probeMethodCache\.size > CAPS\.keys/.test(v110))
ok('宿主事实注释在场（handlers 私有，反射不可实现）', /run\.handlers 私有/.test(v110))
ok('反向对照：v1.08 无标定缓存', !v108.includes('probeMethodCache'))

console.log('[P3] 知识库持久化（方案 C）')
ok('导出工具 refix_export（schemaVersion 1）', /name: 'refix_export'/.test(v110) && /schemaVersion: 1/.test(v110))
ok('回填工具 refix_restore', /name: 'refix_restore'/.test(v110))
ok('逐条校验 normalizeKnowledgeEntry（bad-action 等拒绝面）', /function normalizeKnowledgeEntry/.test(v110) && /'bad-action'/.test(v110))
ok('同指纹保守跳过（不覆盖本地）', /latestKnowledge\(n\.entry\.fingerprint\)/.test(v110))
ok('本地重编号 + restoredFrom 留档', /restoredFrom: typeof e\.id === 'string' \? e\.id : null/.test(v110))
ok('嵌套 object 属性显式 additionalProperties（宿主 DSL 约束）', /additionalProperties: true, description: 'refix_export 的完整输出对象/.test(v110))
ok('反向对照：v1.08 无导出/回填工具', !v108.includes('refix_export'))

console.log('[P4] AgentTeams 同队放行')
ok('trySameTeamAllow（可选服务，不进 inject）', /function trySameTeamAllow/.test(v110) && !/inject: \[[^\]]*'agentTeams'/.test(v110))
ok('TeamId 比对（root 会话 id 同队判定）', /String\(callerM\.id\) !== String\(ownerM\.id\)/.test(v110))
ok('cross-session 分支先探同队（放行不早于拒绝判断）', /teamTrace = trySameTeamAllow\(exec\.agent, row\.agentId\)/.test(v110) && /if \(!teamTrace\)/.test(v110))
ok('代修留痕 record.viaTeam', /viaTeam: teamTrace/.test(v110))
ok('console 留痕（同 Team 代修放行）', /同 Team 代修放行/.test(v110))
ok('反向对照：v1.08 无同队放行', !v108.includes('trySameTeamAllow'))

console.log('[manifest] Phase 2 升级')
ok('latest = p3.8', manifest.latest === 'p3.8')
ok('version = V1.10', manifest.version === 'V1.10')
ok('file 指向 refix-v1.10.js', manifest.file === 'versions/refix-v1.10.js')
ok('static 1.4.0 / V1.4 / sourceFile v1.10', manifest.static.packageVersion === '1.4.0' && manifest.static.releaseTag === 'V1.4' && manifest.static.sourceFile === 'versions/refix-v1.10.js')

console.log('[build] 静态包产物一致性')
ok('构建产物自报 p3.8', built.includes("'p3.8'"))
ok('构建产物含 5 工具注册面', ['refix_repair', 'refix_report', 'refix_patrol', 'refix_export', 'refix_restore'].every(t => built.includes(`'${t}'`)))
ok('构建产物含 F7 监听', built.includes('refix.ev-pre-step-alert'))
ok('构建产物含 P4 放行', built.includes('trySameTeamAllow'))

console.log('')
if (failures > 0) { console.error(`n-series-p2: ${failures}/${checks} FAILED`); process.exit(1) }
console.log(`n-series-p2: ${checks}/${checks} passed`)
