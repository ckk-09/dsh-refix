/**
 * 探针：动态插件的 host 半区能否用 `agent/pre-step` 注入一条「更新提示」？
 *
 * 回答两个此前标注为「未实测」的未知点：
 *   U1 受限沙箱 ctx 是否允许 ctx.on('agent/pre-step', …)   —— 静态看 guard.ts 的 CTX_VERBS 含 'on'，
 *                                                              且不设事件白名单；本探针运行时确认。
 *   U2 手搓的 UserMessage 字面量是否符合宿主消息形状        —— 与宿主 createUserMessage 的字段集对比。
 *
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" probe-pre-step.ac.mts
 * 局限（诚实声明）：本探针手动派发 waterfall，**没有驱动真实 agent loop**；
 *   因此它证明「插件能挂上 + 决策能带出消息 + 消息字段集对得上」，
 *   不证明「真实 loop 会把这台消息送进模型请求」。后者需在真实会话里跑一次。
 */
import { setup, defineAndRun, AGENT_A } from './bench.mts'
import { createUserMessage } from '../../../deepseek-harness/packages/llm/llm/src/index.ts'

/** 探针插件的 host 半区源码：一个 plain JS 函数体，原样喂给 cordis_define。 */
const PROBE_HOST = `
return {
  name: 'probe-pre-step',
  apply(ctx) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            role: 'user',
            id: 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2),
            content: [{ type: 'text', text: PROBE_TEXT }],
            source: {
              kind: 'plugin',
              plugin: 'dsh-refix',
              form: 'snapshot',
              sections: [{ name: 'dsh-refix', text: PROBE_TEXT }],
            },
          },
        ],
      }
    })
    console.log('[probe-pre-step] agent/pre-step listener registered')
  },
}
`.replaceAll('PROBE_TEXT', JSON.stringify('[probe] dsh-refix 检测到新版（探针注入的提示）'))

const checks: Record<string, unknown> = {}
const fail: string[] = []

function assert(name: string, ok: boolean, detail?: unknown) {
  checks[name] = ok ? true : { detail }
  if (!ok) fail.push(name)
}

const h = await setup()

// ── U1：能否在受限沙箱里挂上 agent/pre-step ───────────────────────────
let pluginId: string | undefined
try {
  const out = await defineAndRun(h, 'prb', 'probe-pre-step', { host: PROBE_HOST })
  pluginId = out.pluginId
  assert('u1_listener_registered', true)
} catch (e) {
  assert('u1_listener_registered', false, String((e as Error)?.message ?? e))
}

// ── U2：waterfall 派发后，决策是否带出注入的消息 ───────────────────────
let injected: any
if (pluginId !== undefined) {
  const baseline: any = { kind: 'enter', messages: [] }
  const decision: any = await (h.ctx as any).waterfall(
    'agent/pre-step',
    {
      agent: AGENT_A,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve(baseline),
  )
  injected = decision?.messages?.[0]
  assert('u2_decision_enter', decision?.kind === 'enter', decision)
  assert('u2_message_injected', Array.isArray(decision?.messages) && decision.messages.length === 1,
    decision?.messages)
  assert('u2_text_carried', typeof injected?.content?.[0]?.text === 'string'
    && injected.content[0].text.includes('[probe]'), injected)
  assert('u2_source_kind_plugin', injected?.source?.kind === 'plugin', injected?.source)
}

// ── U2 加强：手搓字面量 vs 宿主 createUserMessage 的字段集 ─────────────
if (injected !== undefined) {
  const canonical: any = createUserMessage({
    content: [{ type: 'text', text: 'x' }],
    source: { kind: 'plugin', plugin: 'dsh-refix', form: 'snapshot', sections: [{ name: 'x', text: 'x' }] },
  } as never)
  const mine = Object.keys(injected).sort()
  const theirs = Object.keys(canonical).sort()
  assert('u2_field_set_matches', JSON.stringify(mine) === JSON.stringify(theirs),
    { mine, theirs })
  const missing = theirs.filter(k => !mine.includes(k))
  const extra = mine.filter(k => !theirs.includes(k))
  checks.u2_missing_fields = missing
  checks.u2_extra_fields = extra
  // 用宿主的 createMessage 再吃一遍手搓对象（深克隆会暴露不可序列化的东西）
  let cloneOk = false
  try {
    structuredClone(injected)
    cloneOk = true
  } catch { /* 不可克隆 */ }
  assert('u2_structured_cloneable', cloneOk)
}

console.log('\nPROBE RESULT')
console.log(JSON.stringify({ checks, fail }, null, 2))
console.log(fail.length === 0 ? 'PROBE PASS' : 'PROBE FAIL: ' + fail.join(', '))
process.exit(fail.length === 0 ? 0 : 1)
