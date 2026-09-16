/** dsh-refix 验收共享 bench：真实 cordis Context + Timer + SystemPrompt + ToolRegistry + DynamicCordisRunnerService。 */
import { Context } from '../../../deepseek-harness/vendor/cordis/src/index.ts'
import Timer from '../../../deepseek-harness/vendor/timer/src/index.ts'
import SystemPrompt from '../../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import ToolRegistry from '../../../deepseek-harness/packages/core/tools/src/index.ts'
import DynamicCordisRunnerService from '../../../deepseek-harness/packages/extensions/cordis-host-runner/src/index.ts'

export const AGENT_A = { id: 'S-a', steer() {}, inject() {} } as any

export type Harness = Awaited<ReturnType<typeof setup>>

export async function setup() {
  const ctx = new Context()
  await ctx.plugin(Timer as any)
  await ctx.plugin(SystemPrompt as any) // ToolRuntime inject 'systemPrompt'
  await ctx.plugin(ToolRegistry as any)
  const events: [string, any][] = []
  ctx.on('cordis/request-run', (request: any) => { events.push(['cordis/request-run', request]) })
  for (const name of ['cordis/request-run-resolved', 'cordis/dynamic-package', 'cordis/dynamic-retract']) {
    ctx.on(name, (payload: unknown) => { events.push([name, payload]) })
  }
  ctx.provide('agents', {
    get: (id: string) => (id === AGENT_A.id ? AGENT_A : undefined),
    list: () => [AGENT_A],
  } as never)
  await ctx.plugin(DynamicCordisRunnerService as any)
  return { ctx, runner: ctx.dynamicCordisRunner, events }
}

/** define 一个包（新插件或追加版本），不运行。 */
export function definePkg(
  h: Harness,
  plugin: { kind: 'new'; idPrefix: string } | { kind: 'existing'; pluginId: string },
  name: string,
  code: { host?: string; client?: string },
) {
  return h.runner.define({
    sessionId: AGENT_A.id,
    plugin: plugin as never,
    name,
    purpose: 'dsh-refix acceptance fixture',
    code: code as never,
  })
}

/** run/update 一个包，失败即断言终止。 */
export async function runPkg(h: Harness, pluginId: string, packageId: string, mode: 'run' | 'update') {
  const receipt = await h.runner.run(AGENT_A, pluginId, packageId, mode)
  assertOk(receipt, `run ${pluginId}/${packageId}`)
  return receipt as any
}

function assertOk(receipt: any, what: string) {
  if (!receipt.ok) throw new Error(`${what} refused: ${receipt.message}`)
}

/** 新插件一步定义+运行。 */
export async function defineAndRun(h: Harness, idPrefix: string, name: string, code: { host?: string; client?: string }) {
  const { pluginId, packageId } = definePkg(h, { kind: 'new', idPrefix }, name, code)
  const receipt = await runPkg(h, pluginId, packageId, 'run')
  return { pluginId, packageId, receipt }
}

export async function callTool(h: Harness, name: string, args: unknown): Promise<string> {
  const result = await h.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'call-' + Math.random().toString(36).slice(2) as never,
    name,
    arguments: args,
  })
  return result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
}

export async function refixReport(h: Harness): Promise<any> {
  return JSON.parse(await callTool(h, 'refix_report', {}))
}

export async function refixPatrol(h: Harness): Promise<any> {
  return JSON.parse(await callTool(h, 'refix_patrol', {}))
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
