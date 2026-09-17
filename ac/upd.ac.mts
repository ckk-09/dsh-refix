/**
 * dsh-refix 更新提示版验收（v8 = p3.5）
 *
 * 覆盖（F6 阶段 1：只提示，不执行换版）：
 *   U-A  web 服务缺席 → 探测降级为 web-service-absent，插件合同自检与工具注册不受影响（U-3）
 *   U-B  版本源报更高版本 → pendingNotice 建立，refix_report 的 update 段可见
 *   U-C  agent/pre-step 注入一条 source=plugin:dsh-refix 的 user 消息（字段集对齐宿主契约）
 *   U-D  一次性消费：第二次 pre-step 不再注入
 *   U-E  同版本（latest == REFIX_VERSION）→ 不建立 notice、不写 notified（假阳性护栏）
 *   U-F  段位数值比较（p3.10 > p3.5，非字典序）
 *   U-G  v8 回归：基础 restart 修复路径仍成功（v8 = v7 + 纯增量）
 *
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" upd.ac.mts
 *
 * 局限（诚实声明）：本用例手动派发 `ctx.waterfall('agent/pre-step', …)`，
 *   **未驱动真实 agent loop**。它证明「探测→notice→决策带出消息→消息形状合规」，
 *   不证明「真实会话里这台消息会被渲染并送进模型请求」——后者需真实会话复核。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_A, defineAndRun, refixReport, setup, sleep } from './bench.mts'

const V8 = readFileSync(new URL('../versions/refix-v1.1-pre1.js', import.meta.url), 'utf8')
const PATIENT_OK = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')

const REPORT_SECTION = 'update'

/** 起一套 host：可选注入一个假 web 服务（内容为给定 manifest JSON）。 */
async function hostWith(manifestJson: string | null) {
  const h = await setup()
  const stat = { fetchCalls: 0 }
  if (manifestJson !== null) {
    h.ctx.provide('web', {
      id: 'ac-fake-web',
      available: () => true,
      fetch: async (req: any) => {
        stat.fetchCalls += 1
        return {
          url: req.url,
          statusCode: 200,
          body: { kind: 'text', content: manifestJson },
          truncated: false,
        }
      },
    } as never)
  }
  return { h, stat }
}

/** 载入 v8 并等首轮启动探测落定。 */
async function bootRefix(h: Awaited<ReturnType<typeof setup>>) {
  const out = await defineAndRun(h, 'refix', 'dsh-refix', { host: V8 })
  await sleep(80)
  return out
}

/** 手动派发一次 pre-step，返回决策。 */
function dispatchPreStep(h: Awaited<ReturnType<typeof setup>>) {
  return (h.ctx as any).waterfall(
    'agent/pre-step',
    { agent: AGENT_A, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] } as any),
  )
}

const checks: Record<string, unknown> = {}
const fail: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  checks[name] = ok ? true : { detail }
  if (!ok) fail.push(name)
}

// ── U-A：web 缺席 → 降级但功能不损 ──────────────────────────────────────────
{
  const { h } = await hostWith(null)
  await bootRefix(h)
  const rep = await refixReport(h)
  check('UA_contract_ok', rep.contract.ok === true, rep.contract)
  check('UA_version_p35', rep.version === 'p3.5', rep.version)
  check('UA_lastcheck_web_absent', rep[REPORT_SECTION]?.lastCheck?.reason === 'web-service-absent',
    rep[REPORT_SECTION]?.lastCheck)
  check('UA_check_counted', rep[REPORT_SECTION]?.checkCount >= 1, rep[REPORT_SECTION]?.checkCount)
  check('UA_no_notice', rep[REPORT_SECTION]?.pendingNotice === null, rep[REPORT_SECTION]?.pendingNotice)
  check('UA_tools_alive', Array.isArray(rep.reports), Object.keys(rep))
  check('UA_executable_false', rep[REPORT_SECTION]?.executable === false, rep[REPORT_SECTION]?.executable)
}

// ── U-B/C/D：更高版本 → notice → 注入 → 一次性消费 ─────────────────────────
{
  const { h, stat } = await hostWith(JSON.stringify({
    latest: 'p3.9', notes: 'AC 假发布说明', url: 'https://example.invalid/dsh-refix',
  }))
  await bootRefix(h)
  const rep = await refixReport(h)
  check('UB_fetch_called', stat.fetchCalls >= 1, stat.fetchCalls)
  check('UB_lastcheck_ok', rep[REPORT_SECTION]?.lastCheck?.ok === true, rep[REPORT_SECTION]?.lastCheck)
  check('UB_latest_seen', rep[REPORT_SECTION]?.latestSeen === 'p3.9', rep[REPORT_SECTION]?.latestSeen)
  const notice = rep[REPORT_SECTION]?.pendingNotice
  check('UB_pending_notice', notice?.latest === 'p3.9' && notice?.current === 'p3.5', notice)
  check('UB_notified_recorded', Array.isArray(rep[REPORT_SECTION]?.notified)
    && rep[REPORT_SECTION].notified.includes('p3.9'), rep[REPORT_SECTION]?.notified)

  const decision: any = await dispatchPreStep(h)
  check('UC_decision_enter', decision?.kind === 'enter', decision?.kind)
  const msg = decision?.messages?.[0]
  check('UC_one_message', Array.isArray(decision?.messages) && decision.messages.length === 1,
    decision?.messages?.length)
  check('UC_role_user', msg?.role === 'user', msg?.role)
  check('UC_id_prefixed', typeof msg?.id === 'string' && msg.id.startsWith('refix-upd-'), msg?.id)
  check('UC_source_plugin', msg?.source?.kind === 'plugin' && msg?.source?.plugin === 'dsh-refix',
    msg?.source)
  const text: string = msg?.content?.[0]?.text ?? ''
  check('UC_text_has_latest', text.includes('p3.9'), text)
  check('UC_text_has_current', text.includes('p3.5'), text)
  check('UC_text_has_source_url', text.includes('raw.githubusercontent.com'), text)
  check('UC_text_has_notes', text.includes('AC 假发布说明'), text)
  check('UC_text_has_manual_path', text.includes('cordis_define') && text.includes('cordis_run'), text)
  check('UC_text_declares_self_forbidden', text.includes('self-repair-forbidden'), text)
  let cloneable = false
  try { structuredClone(msg); cloneable = true } catch { /* 不可克隆 */ }
  check('UC_structured_cloneable', cloneable)

  const after = await refixReport(h)
  check('UD_notice_consumed', after[REPORT_SECTION]?.pendingNotice === null,
    after[REPORT_SECTION]?.pendingNotice)
  const second: any = await dispatchPreStep(h)
  check('UD_no_second_inject', Array.isArray(second?.messages) && second.messages.length === 0,
    second?.messages?.length)
}

// ── U-E：同版本不提示（假阳性护栏） ─────────────────────────────────────────
{
  const { h } = await hostWith(JSON.stringify({ latest: 'p3.5', notes: 'same' }))
  await bootRefix(h)
  const rep = await refixReport(h)
  check('UE_latest_seen', rep[REPORT_SECTION]?.latestSeen === 'p3.5', rep[REPORT_SECTION]?.latestSeen)
  check('UE_lastcheck_ok', rep[REPORT_SECTION]?.lastCheck?.ok === true, rep[REPORT_SECTION]?.lastCheck)
  check('UE_no_notice', rep[REPORT_SECTION]?.pendingNotice === null, rep[REPORT_SECTION]?.pendingNotice)
  check('UE_notified_empty', (rep[REPORT_SECTION]?.notified ?? []).length === 0,
    rep[REPORT_SECTION]?.notified)
  const d: any = await dispatchPreStep(h)
  check('UE_no_inject', Array.isArray(d?.messages) && d.messages.length === 0, d?.messages?.length)
}

// ── U-F：段位数值比较 p3.10 > p3.5（字典序会判错） ─────────────────────────
{
  const { h } = await hostWith(JSON.stringify({ latest: 'p3.10', notes: 'numeric order' }))
  await bootRefix(h)
  const rep = await refixReport(h)
  check('UF_p3_10_is_newer', rep[REPORT_SECTION]?.pendingNotice?.latest === 'p3.10',
    rep[REPORT_SECTION]?.pendingNotice)
}

// ── U-G：v8 回归——修复主路径仍通 ───────────────────────────────────────────
{
  const { h } = await hostWith(JSON.stringify({ latest: 'p3.5' }))
  await bootRefix(h)
  const patient = await defineAndRun(h, 'patup', 'dsh-patient-upd', { host: PATIENT_OK })
  await h.runner.stop(AGENT_A, patient.pluginId)
  const raw = await (h.ctx.tools as any).execute({
    signal: new AbortController().signal,
    callId: 'call-upd' as never,
    name: 'refix_repair',
    arguments: { pluginId: patient.pluginId, observeMs: 300 },
    agent: AGENT_A,
  })
  const r = JSON.parse(raw.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''))
  check('UG_repair_success', r.outcome === 'success', r)
}

console.log('\nUPD AC RESULT')
console.log(JSON.stringify({ checks, fail }, null, 2))
assert.equal(fail.length, 0, 'UPD AC 失败项: ' + fail.join(', '))
console.log('UPD AC PASS')
process.exit(0)
