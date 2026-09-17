/**
 * dsh-refix P0 验收（AC1.1 + AC5.1）
 * 运行：node --import "file:///D:/AI-Workspace/deepseek-harness/node_modules/tsx/dist/loader.mjs" p0.ac.mts
 * 说明：不导入官方 tests/helpers.ts（它依赖 tsconfig paths，tsx 直跑解析不了），
 * 这里自建等价最小 bench：真实 cordis Context + Timer + ToolRegistry + DynamicCordisRunnerService。
 * 被测源码从本工作区正源读取（与真实 cordis_define 工作流一致：模型读文件 → define）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Context } from '../../../deepseek-harness/vendor/cordis/src/index.ts'
import Timer from '../../../deepseek-harness/vendor/timer/src/index.ts'
import SystemPrompt from '../../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import ToolRegistry from '../../../deepseek-harness/packages/core/tools/src/index.ts'
import DynamicCordisRunnerService from '../../../deepseek-harness/packages/extensions/cordis-host-runner/src/index.ts'

const REFIX_HOST = readFileSync(new URL('../versions/refix-v1.01.js', import.meta.url), 'utf8')
const PATIENT_HOST = readFileSync(new URL('../versions/patient-v1.js', import.meta.url), 'utf8')

// ── 最小 bench ───────────────────────────────────────────────────────────────
const AGENT_A = { id: 'S-a', steer() {}, inject() {} } as any
const AGENTS_STUB = {
  get: (id: string) => (id === AGENT_A.id ? AGENT_A : undefined),
  list: () => [AGENT_A],
}

type Harness = Awaited<ReturnType<typeof setup>>

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Timer as any)
  await ctx.plugin(SystemPrompt as any) // ToolRuntime inject 'systemPrompt'
  await ctx.plugin(ToolRegistry as any)
  const events: [string, unknown][] = []
  ctx.on('cordis/request-run', (request: any) => { events.push(['cordis/request-run', request]) })
  for (const name of ['cordis/request-run-resolved', 'cordis/dynamic-package', 'cordis/dynamic-retract']) {
    ctx.on(name, (payload: unknown) => { events.push([name, payload]) })
  }
  ctx.provide('agents', AGENTS_STUB as never)
  await ctx.plugin(DynamicCordisRunnerService as any)
  return { ctx, runner: ctx.dynamicCordisRunner, events }
}

async function defineAndRun(h: Harness, idPrefix: string, name: string, code: string) {
  const { pluginId, packageId } = h.runner.define({
    sessionId: AGENT_A.id,
    plugin: { kind: 'new', idPrefix },
    name,
    purpose: 'dsh-refix acceptance fixture',
    code: { host: code },
  })
  const receipt = await h.runner.run(AGENT_A, pluginId, packageId, 'run')
  assert.equal(receipt.ok, true, `run ${pluginId}/${packageId} refused: ${receipt.ok ? '' : (receipt as any).message}`)
  return { pluginId, packageId, receipt }
}

async function callTool(h: Harness, name: string, args: unknown): Promise<string> {
  const result = await h.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'call-1' as never,
    name,
    arguments: args,
  })
  return result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
}

// ── AC1.1 + AC5.1 ────────────────────────────────────────────────────────────
const h = await setup()

const patient = await defineAndRun(h, 'patnt', 'dsh-patient', PATIENT_HOST)
assert.equal((patient.receipt as any).status, 'running', 'patient 应运行中')

const refix = await defineAndRun(h, 'refix', 'dsh-refix', REFIX_HOST)
assert.equal((refix.receipt as any).status, 'running', 'refix 应运行中')

const report = JSON.parse(await callTool(h, 'refix_report', {}))

// AC5.1：契约探测全部匹配 → 兼容性自检通过
assert.equal(report.contract.ok, true, `AC5.1 契约缺失: ${JSON.stringify(report.contract.missing)}`)
assert.deepEqual(report.contract.missing, [])

// AC1.1：inventory 输出中识别 patient 并建立基线（activeRun 在案）
const patientRow = report.baseline[patient.pluginId]
assert.ok(patientRow, `AC1.1 基线缺 patient 行 ${patient.pluginId}`)
assert.equal(patientRow.agentId, AGENT_A.id)
assert.deepEqual(patientRow.activeRun, { pluginRunId: (patient.receipt as any).pluginRunId, packageId: patient.packageId })
assert.equal(patientRow.currentPackageId, patient.packageId)
assert.ok(report.baseline[refix.pluginId], '基线应含 refix 自身')

// P0 要求：注册 cordisInspect provider 且可查询
const providers = h.ctx.cordisInspect.list()
assert.ok(providers.some((p: any) => p.id === 'Refix' && p.platform === 'host'), 'Refix inspect provider 未注册')
const queried = await h.ctx.cordisInspect.query('host', 'Refix', 'listReports', undefined, AGENT_A, new AbortController().signal) as any
assert.equal(queried.contract.ok, true)
assert.ok(queried.baseline[patient.pluginId], 'provider 查询应返回基线')

console.log('P0 SELF-CHECK PASS')
console.log(JSON.stringify({
  contract: report.contract,
  baselinePlugins: Object.keys(report.baseline),
  refix: { pluginId: refix.pluginId, packageId: refix.packageId },
  patient: { pluginId: patient.pluginId, packageId: patient.packageId },
}, null, 2))
