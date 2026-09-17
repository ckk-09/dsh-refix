/**
 * dsh-refix-updater 验收（v1，F6 阶段 3：宿主强制门 + 一次性令牌）
 *
 * 覆盖（W-A..W-R）：
 *   W-A  默认关闭（A-6）：未启用时只注册只读 updater_report；**不注册 tools/pre-execute
 *        钩子**（差分断言：同一探针调用在关闭态返回 allow，在启用态返回 ask）
 *   W-B  启用后契约自检 ok + 目标解析（按包名找到 dsh-refix 行，读出真实 currentPackageId）
 *   W-C  纯 JS SHA-256 正确性（**端到端**）：listener 报出的 sha256 必须等于 node:crypto
 *        对同一源码字符串的结果 —— 沙箱无 crypto，哈希只能来自我们自己的实现
 *   W-D  清单 file 非法（路径穿越）→ refused manifest-unsafe-file，且**不 fetch 源码**
 *   W-E  清单 latest ≠ 源码自报 REFIX_VERSION → refused version-mismatch
 *   W-F  源码不含 dsh-refix 指纹 → refused not-target-plugin
 *   W-G  源码含 updater 指纹 → refused updater-code-rejected（不把 updater 装进 refix）
 *   W-H  宿主 fail-closed（F10）：**没有批准通道**时 apply 被拒，且**没有任何 define 发生**
 *   W-I  令牌不匹配 → deny，且**批准通道未被提问**（approval.request 调用数 = 0）
 *   W-J  批准（allowed-once）→ 真执行：define 追加包 + run(update) 切换 + 观察窗通过
 *   W-K  票据一次性（A-8）：第二次 apply 被拒
 *   W-L  运行态漂移（stale ticket）→ refused stale-ticket（不用旧回滚点动手）
 *   W-M  观察窗未通过 → **自动回滚**（候选版本自停 → retract → 切回旧包）
 *   W-N  自身禁令（A-7）：目标指向 updater 自己 → refused self-upgrade-forbidden
 *   W-O  批准被拒（rejected）→ 工具报错且无 define（与 W-H 不同路径，同一 fail-closed 结论）
 *   W-P  批准提示的信息量：ask.reason 含版本对 / sha256 / 回滚命令 / "远程代码执行"声明
 *   W-Q  未知票据 → deny unknown-ticket（不弹批准框）
 *   W-R  dsh-refix 的零自升级性质未被削弱（回归）：全流程后 refix 自己仍不调 define/run，
 *        其包数量只由 updater 的合法追加改变
 *
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" upd3.ac.mts
 *
 * 局限（诚实声明）：
 *  1. 批准通道用 bench 里 `ctx.provide('approval', …)` 的**真 ApprovalService seam** 模拟
 *     （宿主 core/tools 走 ctx.get('approval') → request()），不是真浏览器 ui-approval。
 *     真机 UI 弹框未在本脚本内验证。
 *  2. 启用态（UPDATER_ENABLED=true）由本脚本对源码做**单点常量替换**得到 —— 因为宿主
 *     startHostHalf 不向 apply 传 config（cordis-host-runner/src/index.ts L1238 → 无 config），
 *     生产启用只能改常量后重新 define。替换次数被断言为 1。
 *  3. 未驱动真实 agent loop / 真实模型；工具调用走 ctx.tools.execute。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AGENT_A, defineAndRun, setup, sleep, callTool, type Harness } from './bench.mts'

const UPDATER = readFileSync(new URL('../versions/refix-updater-v1.1-pre.js', import.meta.url), 'utf8')
const V9 = readFileSync(new URL('../versions/refix-v1.1-pre2.js', import.meta.url), 'utf8')

const REFIX_FP = 'refix-self-fingerprint-a7f3'
const UPDATER_FP = 'refix-updater-fingerprint-b4e1'
const MANIFEST_KEY = 'versions/manifest.json'
const SRC_KEY = 'versions/refix-v10-fixture.js'

/** 把默认关闭的常量打开（W-2 局限②：替换必须恰好命中一次）。 */
function enableUpdater(src: string): string {
  const needle = 'const UPDATER_ENABLED = false'
  const parts = src.split(needle)
  assert.equal(parts.length, 2, 'UPDATER_ENABLED 常量在源码中应恰好出现一次')
  return parts.join('const UPDATER_ENABLED = true')
}

/** 候选源码 fixture：含 refix 指纹 + 自报版本，绝不含 updater 指纹。 */
function fixture(kind: 'good' | 'suicide' | 'no-fp' | 'with-updater-fp'): string {
  const lines = [
    '// fixture: dsh-refix candidate p3.7 (' + kind + ')',
    '// ' + (kind === 'no-fp' ? 'no fingerprint here' : REFIX_FP),
    "const REFIX_VERSION = 'p3.7'",
  ]
  if (kind === 'with-updater-fp') lines.push('// ' + UPDATER_FP)
  if (kind === 'suicide') {
    lines.push(
      'return {',
      "  name: 'dsh-refix p3.7',",
      "  inject: ['dynamicCordisRunner', 'agents', 'timer'],",
      '  apply(ctx) {',
      '    ctx.timeout(40).then(function () {',
      '      try {',
      '        const rows = ctx.dynamicCordisRunner.inventory()',
      '        for (let i = 0; i < rows.length; i++) {',
      '          const row = rows[i]',
      '          const pkgs = row.packages || []',
      '          for (let j = 0; j < pkgs.length; j++) {',
      "            if (pkgs[j].name === 'dsh-refix p3.7') {",
      '              const a = ctx.agents.get(row.agentId)',
      '              ctx.dynamicCordisRunner.stop(a, row.pluginId)',
      '              return',
      '            }',
      '          }',
      '        }',
      '      } catch (e) {}',
      '    })',
      '  },',
      '}',
    )
  } else {
    lines.push(
      'return {',
      "  name: 'dsh-refix p3.7',",
      '  apply() {},',
      '}',
    )
  }
  return lines.join('\n')
}

interface WebStat { urls: string[] }

/** 起一套真 host，按 URL 子串路由的假 web；approval 为 null 表示"无批准通道"。 */
async function host(opts: {
  src?: string
  manifest?: string
  approval?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null
}) {
  const h = await setup()
  const stat: WebStat = { urls: [] }
  const asked = { n: 0 }
  const manifest = opts.manifest ?? JSON.stringify({
    latest: 'p3.7',
    version: 'v10',
    file: 'versions/refix-v10-fixture.js',
    url: 'https://github.com/ckk-09/dsh-refix',
  })
  h.ctx.provide('web', {
    id: 'ac-fake-web',
    available: () => true,
    fetch: async (req: { url: string }) => {
      stat.urls.push(String(req.url))
      const content = String(req.url).includes(SRC_KEY)
        ? opts.src
        : String(req.url).includes(MANIFEST_KEY) ? manifest : undefined
      if (content === undefined) {
        return { url: req.url, statusCode: 404, body: { kind: 'text', content: '' }, truncated: false }
      }
      return { url: req.url, statusCode: 200, body: { kind: 'text', content }, truncated: false }
    },
  } as never)
  if (opts.approval !== null && opts.approval !== undefined) {
    const outcome = opts.approval
    h.ctx.provide('approval', {
      request: async () => { asked.n += 1; return outcome },
    } as never)
  }
  return { h, stat, asked }
}

/** 装载 v9 作为"已装的 dsh-refix"，返回 {pluginId, packageId}。 */
async function bootRefix(h: Harness) {
  const out = await defineAndRun(h, 'refix', 'dsh-refix', { host: V9 })
  await sleep(30)
  return out
}

/** 装载 updater（enabled 时可选择把默认关闭的常量打开）。 */
async function bootUpdater(h: Harness, enabled: boolean) {
  const code = enabled ? enableUpdater(UPDATER) : UPDATER
  return defineAndRun(h, 'refupd', 'dsh-refix-updater', { host: code })
}

function rowOf(h: Harness, pluginId: unknown) {
  return h.runner.inventory().find((r: any) => String(r.pluginId) === String(pluginId))
}

/** 直接派发 pre-execute 瀑布，取本插件钩子的决策（不经工具运行时）。 */
function gateProbe(h: Harness, name: string, args: unknown) {
  return (h.ctx as any).waterfall(
    'tools/pre-execute',
    { callId: 'probe-' + Math.random().toString(36).slice(2), name, arguments: args, agent: AGENT_A, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'allow' }),
  )
}

const checks: Record<string, unknown> = {}
/** 附带信息（不算用例，避免污染 passed/total 计数）。 */
const info: Record<string, unknown> = {}
const fail: string[] = []
async function check(id: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    checks[id] = 'PASS'
  } catch (e) {
    checks[id] = 'FAIL: ' + ((e as Error).message || String(e))
    fail.push(id)
  }
}

// ── W-A 默认关闭：只读 report，且无全局钩子 ────────────────────────────
await check('WA_default_off_no_gate', async () => {
  const { h } = await host({ src: fixture('good'), approval: null })
  const refix = await bootRefix(h)
  const upd = await bootUpdater(h, false)
  const rep = JSON.parse(await callTool(h, 'updater_report', {}, AGENT_A))
  assert.equal(rep.enabled, false, 'report.enabled 应为 false')
  assert.equal(rep.version, 'u1')
  // 关闭态：check/apply 未注册
  const tools = h.ctx.tools.schemas().map((s: any) => s.name)
  assert.ok(tools.includes('updater_report'), 'updater_report 应注册')
  assert.ok(!tools.includes('updater_check'), '关闭态不应注册 updater_check')
  assert.ok(!tools.includes('updater_apply'), '关闭态不应注册 updater_apply')
  // 关闭态：pre-execute 钩子不存在 → 探针返回 allow
  const d = await gateProbe(h, 'updater_apply', { ticketId: 't1', confirm: 'x' })
  assert.equal((d as any).kind, 'allow', '关闭态不应有任何 pre-execute 拦截')
  info.WA_refixPluginId = String(refix.pluginId)
  info.WA_updaterPluginId = String(upd.pluginId)
})

// ── W-B 启用后：契约自检 + 目标解析 ───────────────────────────────────
await check('WB_contract_and_target_resolution', async () => {
  const { h } = await host({ src: fixture('good'), approval: null })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const rep = JSON.parse(await callTool(h, 'updater_report', {}, AGENT_A))
  assert.equal(rep.enabled, true)
  assert.equal(rep.contract.ok, true, '契约自检应通过: ' + JSON.stringify(rep.contract.missing))
  assert.equal(rep.target.pluginId, String(refix.pluginId), '目标解析应命中 dsh-refix 行')
  assert.equal(rep.target.currentPackageId, String(refix.packageId), '应读出真实 currentPackageId')
  assert.equal(rep.approvalGate.allowedValues.join(','), 'allowed-once')
  assert.equal(rep.approvalGate.persistentGrant, false)
  assert.ok(rep.approvalGate.failClosedOn.includes('unavailable(no answerer)'))
})

// ── W-C 纯 JS SHA-256 端到端正确性 ────────────────────────────────────
await check('WC_pure_js_sha256_matches_node', async () => {
  const src = fixture('good')
  const { h } = await host({ src, approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  assert.equal(tk.outcome, 'ticket-issued', '应出票据: ' + JSON.stringify(tk))
  const expected = createHash('sha256').update(src, 'utf8').digest('hex')
  assert.equal(tk.candidate.sha256, expected, 'sha256 必须与 node:crypto 一致（纯 JS 实现正确性）')
  assert.equal(tk.approval.token, expected.slice(0, 12), '令牌 = sha256 前 12 位')
  assert.equal(tk.candidate.bytes, src.length)
  info.WC_sha256 = expected.slice(0, 16)
})

// ── W-D 清单 file 路径穿越 → 拒绝且不拉源码 ───────────────────────────
await check('WD_unsafe_manifest_file_refused', async () => {
  const manifest = JSON.stringify({ latest: 'p3.7', file: '../../etc/passwd.js' })
  const { h, stat } = await host({ src: fixture('good'), manifest, approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const r = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  assert.equal(r.outcome, 'refused')
  assert.equal(r.reason, 'manifest-unsafe-file', '应因 file 非法而拒: ' + JSON.stringify(r))
  assert.ok(!stat.urls.some(u => u.includes('passwd')), '不得按非法 file 发请求')
})

// ── W-E 清单抬版本号（latest ≠ 源码自报）→ 拒绝 ───────────────────────
await check('WE_version_mismatch_refused', async () => {
  const manifest = JSON.stringify({ latest: 'p9.9', file: 'versions/refix-v10-fixture.js' })
  const { h } = await host({ src: fixture('good'), manifest, approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const r = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  assert.equal(r.outcome, 'refused')
  assert.equal(r.reason, 'version-mismatch', '清单不能单方面抬版本号: ' + JSON.stringify(r))
})

// ── W-F 源码不含 dsh-refix 指纹 → 拒绝 ────────────────────────────────
await check('WF_not_target_plugin_refused', async () => {
  const { h } = await host({ src: fixture('no-fp'), approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const r = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  assert.equal(r.outcome, 'refused')
  assert.equal(r.reason, 'not-target-plugin')
})

// ── W-G 源码含 updater 指纹 → 拒绝 ────────────────────────────────────
await check('WG_updater_code_into_target_refused', async () => {
  const { h } = await host({ src: fixture('with-updater-fp'), approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const r = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  assert.equal(r.outcome, 'refused')
  assert.equal(r.reason, 'updater-code-rejected')
})

// ── W-H 无批准通道 → 宿主 fail-closed，且零 define ────────────────────
await check('WH_fail_closed_without_approval_channel', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: null })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const before = rowOf(h, refix.pluginId)!.packages.length
  const out = await callTool(h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token }, AGENT_A)
  assert.ok(/Error/.test(out), '应返回错误结果: ' + out.slice(0, 120))
  assert.ok(out.includes('需你拍板'), '应把批准提示内容回给模型: ' + out.slice(0, 200))
  const after = rowOf(h, refix.pluginId)!.packages.length
  assert.equal(after, before, '无批准通道时不得 define 新包')
  assert.equal(asked.n, 0, 'approval 服务缺席，request 不应被调用')
  info.WH_denyText = out.slice(0, 60)
})

// ── W-I 令牌不匹配 → deny 且不提问 ────────────────────────────────────
await check('WI_token_mismatch_denies_without_asking', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: 'allowed-once' })
  await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const g = await gateProbe(h, 'updater_apply', { ticketId: tk.ticketId, confirm: 'deadbeef0000' })
  assert.equal((g as any).kind, 'deny', '令牌不匹配应直接 deny: ' + JSON.stringify(g))
  assert.ok(String((g as any).reason).includes('令牌不匹配'), String((g as any).reason))
  assert.equal(asked.n, 0, '令牌不匹配时不得向批准通道提问')
})

// ── W-J 批准 → 真执行（端到端）────────────────────────────────────────
await check('WJ_approved_end_to_end_success', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: 'allowed-once' })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const before = rowOf(h, refix.pluginId)!
  const out = JSON.parse(await callTool(
    h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token, observeMs: 300 }, AGENT_A,
  ))
  assert.equal(out.outcome, 'success', '应成功: ' + JSON.stringify(out).slice(0, 400))
  assert.equal(asked.n, 1, '批准通道应恰好被问一次')
  const after = rowOf(h, refix.pluginId)!
  assert.equal(after.packages.length, before.packages.length + 1, '应追加一个不可变包')
  assert.equal(String(after.currentPackageId), String(out.newPackageId), 'currentPackageId 应切到新包')
  assert.equal(String(after.activeRun.packageId), String(out.newPackageId), '新包应存活')
  assert.equal(out.rollbackPoint, String(before.currentPackageId), '回滚点应为升级前的 currentPackageId')
  const rep = JSON.parse(await callTool(h, 'updater_report', {}, AGENT_A))
  assert.equal(rep.lastResult.outcome, 'success')
  info.WJ_newPackageId = String(out.newPackageId)
})

// ── W-K 票据一次性 ───────────────────────────────────────────────────
await check('WK_ticket_is_one_shot', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: 'allowed-once' })
  await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const first = JSON.parse(await callTool(
    h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token, observeMs: 200 }, AGENT_A,
  ))
  assert.equal(first.outcome, 'success')
  const second = await callTool(h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token }, AGENT_A)
  assert.ok(/Error|已被使用/.test(second), '第二次应被拒: ' + second.slice(0, 160))
  assert.equal(asked.n, 1, '被拒的重放不得再次提问')
})

// ── W-L 运行态漂移 → stale-ticket ─────────────────────────────────────
await check('WL_stale_ticket_refused', async () => {
  const { h } = await host({ src: fixture('good'), approval: 'allowed-once' })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  // 模拟 check→apply 之间有人动了运行态：直接切到另一个包
  const extra = h.runner.define({
    sessionId: AGENT_A.id,
    plugin: { kind: 'existing', pluginId: String(refix.pluginId) } as never,
    name: 'dsh-refix p3.6-manual',
    purpose: 'ac: 抢占运行态',
    code: { host: V9 } as never,
  })
  await h.runner.run(AGENT_A, String(refix.pluginId) as never, String(extra.packageId) as never, 'update')
  const out = JSON.parse(await callTool(
    h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token, observeMs: 100 }, AGENT_A,
  ))
  assert.equal(out.outcome, 'refused', JSON.stringify(out).slice(0, 300))
  assert.equal(out.reason, 'stale-ticket')
})

// ── W-M 观察窗未通过 → 自动回滚 ───────────────────────────────────────
await check('WM_observe_failure_rolls_back', async () => {
  const { h } = await host({ src: fixture('suicide'), approval: 'allowed-once' })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const beforePkg = String(refix.packageId)
  const out = JSON.parse(await callTool(
    h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token, observeMs: 400 }, AGENT_A,
  ))
  assert.equal(out.outcome, 'rolled-back', '应自动回滚: ' + JSON.stringify(out).slice(0, 500))
  assert.equal(out.beforePackageId, beforePkg)
  assert.equal(out.observation.retracted, true, '观察窗应看到新 run 被 retract')
  const after = rowOf(h, refix.pluginId)!
  assert.equal(String(after.currentPackageId), beforePkg, '应切回旧包')
  assert.ok(after.activeRun && String(after.activeRun.packageId) === beforePkg, '旧包应重新存活')
  const rep = JSON.parse(await callTool(h, 'updater_report', {}, AGENT_A))
  assert.equal(rep.lastResult.outcome, 'rolled-back')
})

// ── W-N 自身禁令 ─────────────────────────────────────────────────────
await check('WN_self_upgrade_forbidden', async () => {
  const { h } = await host({ src: fixture('good'), approval: null })
  const refix = await bootRefix(h)
  const upd = await bootUpdater(h, true)
  const r = JSON.parse(await callTool(h, 'updater_check', { pluginId: String(upd.pluginId) }, AGENT_A))
  assert.equal(r.outcome, 'refused')
  assert.equal(r.reason, 'self-upgrade-forbidden', JSON.stringify(r))
  assert.notEqual(String(upd.pluginId), String(refix.pluginId))
})

// ── W-O 批准被拒 → fail-closed ───────────────────────────────────────
await check('WO_rejected_by_user_no_execution', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: 'rejected' })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const before = rowOf(h, refix.pluginId)!.packages.length
  const out = await callTool(h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token }, AGENT_A)
  assert.ok(/rejected|拒绝/i.test(out), '应报"用户拒绝": ' + out.slice(0, 200))
  assert.equal(asked.n, 1)
  const after = rowOf(h, refix.pluginId)!
  assert.equal(after.packages.length, before, '用户拒绝后不得 define')
  assert.equal(String(after.currentPackageId), String(refix.packageId), '运行态不得变化')
})

// ── W-P 批准提示的信息量 ─────────────────────────────────────────────
await check('WP_ask_reason_is_informative', async () => {
  const { h } = await host({ src: fixture('good'), approval: null })
  await bootRefix(h)
  await bootUpdater(h, true)
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  const g: any = await gateProbe(h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token })
  assert.equal(g.kind, 'ask')
  const r = String(g.reason)
  assert.ok(r.includes('p3.6 → p3.7'), '应含版本对: ' + r)
  assert.ok(r.includes(tk.candidate.sha256.slice(0, 16)), '应含 sha256 前缀')
  assert.ok(r.includes('cordis_run(pluginId='), '应含回滚命令')
  assert.ok(r.includes('远程代码执行'), '应明示等价于 RCE')
  assert.ok(r.includes('无签名'), '应声明清单无签名')
  info.WP_reasonLen = r.length
})

// ── W-Q 未知票据 ─────────────────────────────────────────────────────
await check('WQ_unknown_ticket_denied', async () => {
  const { h, asked } = await host({ src: fixture('good'), approval: 'allowed-once' })
  await bootRefix(h)
  await bootUpdater(h, true)
  const g: any = await gateProbe(h, 'updater_apply', { ticketId: 't-does-not-exist', confirm: 'x' })
  assert.equal(g.kind, 'deny')
  assert.ok(String(g.reason).includes('未知票据'), String(g.reason))
  assert.equal(asked.n, 0)
})

// ── W-R refix 零自升级性质未被削弱（回归）──────────────────────────
await check('WR_refix_never_defines_itself', async () => {
  const { h } = await host({ src: fixture('good'), approval: 'allowed-once' })
  const refix = await bootRefix(h)
  await bootUpdater(h, true)
  const before = rowOf(h, refix.pluginId)!.packages.length
  // 跑完整一轮（含 dsh-refix 自己的一次探测周期），refix 不应自行 define
  await sleep(60)
  const mid = rowOf(h, refix.pluginId)!.packages.length
  assert.equal(mid, before, 'dsh-refix 不应自行 define（零自升级）')
  const tk = JSON.parse(await callTool(h, 'updater_check', {}, AGENT_A))
  await callTool(h, 'updater_apply', { ticketId: tk.ticketId, confirm: tk.approval.token, observeMs: 200 }, AGENT_A)
  const after = rowOf(h, refix.pluginId)!.packages.length
  assert.equal(after, before + 1, '包数量只应因 updater 的合法追加而 +1')
  // updater 自己的包数量不变（A-7：不给自己 define）
  const updRow = h.runner.inventory().find((r: any) =>
    (r.packages || []).some((p: any) => String(p.name).indexOf('dsh-refix-updater') === 0))!
  assert.equal(updRow.packages.length, 1, 'updater 不应给自己追加包')
})

// ── 输出 ─────────────────────────────────────────────────────────────
const total = Object.keys(checks).length
const passed = Object.values(checks).filter(v => v === 'PASS').length
console.log(JSON.stringify({ passed: passed, total: total, failed: fail }, null, 2))
for (const [k, v] of Object.entries(checks)) {
  console.log((v === 'PASS' ? 'PASS ' : 'FAIL ') + k + (v === 'PASS' ? '' : '  ' + String(v)))
}
if (Object.keys(info).length > 0) console.log('INFO ' + JSON.stringify(info))
process.exit(fail.length === 0 ? 0 : 1)
