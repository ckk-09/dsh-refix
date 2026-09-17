// 【定版 V1.01】稳定版发布线 V1.0x（原开发代号 v1 / p0.1；README 与 QUICKSTART 统一使用定版号）
// dsh-refix v1（P0 骨架）— 自诊断·自修复·自迭代插件
// 宿主半：契约探测（F5）+ inventory 基线（F1 前置）+ cordisInspect provider + refix_report 工具
// 边界（需求 §2）：诊断只读；修复仅 run/stop；不碰文件系统与网络。
const REFIX_VERSION = 'p0.1'

// F5 内置契约清单：宿主 API 形状 + cordis/* 事件名
const CONTRACT = {
  dynamicCordisRunner: ['define', 'undefine', 'run', 'stop', 'inventory', 'snapshot', 'listPlugins', 'inspectPlugin', 'inspectPackage', 'reference'],
  cordisInspect: ['register', 'list', 'query'],
}
const CONTRACT_EVENTS = ['cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/request-run', 'cordis/request-run-resolved']

return {
  name: 'dsh-refix',
  inject: ['dynamicCordisRunner', 'cordisInspect', 'agents', 'timer'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    const reports = []   // F1 诊断报告（内存态，随插件卸载销毁）
    const knowledge = [] // F4 知识库（P3 启用）

    // ── F5 兼容性自检：方法签名存在性 + 事件名可注册 ──────────────────
    function probeContract() {
      const missing = []
      for (const svc of Object.keys(CONTRACT)) {
        const inst = ctx.get(svc)
        if (inst === null || inst === undefined) { missing.push(svc + ':service-absent'); continue }
        for (const m of CONTRACT[svc]) {
          if (typeof inst[m] !== 'function') missing.push(svc + '.' + m + ':missing')
        }
      }
      for (const ev of CONTRACT_EVENTS) {
        try { const dispose = ctx.on(ev, function () {}); dispose() }
        catch (e) { missing.push('event:' + ev + ':' + ((e && e.message) || 'register-failed')) }
      }
      return missing
    }
    const contractMissing = probeContract()

    // ── F1 前置：inventory 只读视图与基线快照 ─────────────────────────
    function rowView(row) {
      const view = { pluginId: row.pluginId, agentId: row.agentId, currentPackageId: row.currentPackageId || null }
      view.activeRun = row.activeRun
        ? { pluginRunId: row.activeRun.pluginRunId, packageId: row.activeRun.packageId }
        : null
      view.latestStatus = row.latestRun ? row.latestRun.status : null
      view.latestError = row.latestRun && row.latestRun.error
        ? { phase: row.latestRun.error.phase, message: row.latestRun.error.message }
        : null
      return view
    }
    let baseline = {}
    function takeBaseline() {
      const next = {}
      for (const row of runner.inventory()) next[row.pluginId] = rowView(row)
      baseline = next
      return Object.keys(next).length
    }
    const initialCount = contractMissing.length === 0 ? takeBaseline() : 0

    function selfCheck() {
      return {
        version: REFIX_VERSION,
        contract: { ok: contractMissing.length === 0, missing: contractMissing },
        baseline: baseline,
        reports: reports,
        knowledge: knowledge,
      }
    }

    // ── P0：注册 cordisInspect provider（只读自检视图）────────────────
    // 注意：effect 的参数是"返回 disposer 的 thunk"，不能把 register 的返回值直接传进去。
    ctx.effect(() => ctx.cordisInspect.register({
      manifest: {
        id: 'Refix',
        description: 'dsh-refix 自诊断视图：兼容性自检、inventory 基线与诊断报告（只读）。',
        methods: [{
          name: 'listReports',
          description: '返回 dsh-refix 的兼容性自检结果、当前基线与诊断报告。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: { description: 'dsh-refix 自检状态 JSON。' },
        }],
      },
      query(method) {
        if (method !== 'listReports') throw new Error('unknown Refix inspect method "' + method + '"')
        return Promise.resolve(selfCheck())
      },
    }), 'refix.inspect-provider')

    // ── 模型侧只读工具：一句话自检入口 ────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_report',
      description: 'dsh-refix 自诊断报告：兼容性自检（F5）、inventory 基线（F1）与诊断报告列表。只读，无参数。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute() {
        if (contractMissing.length === 0) takeBaseline() // 报告前刷新只读快照
        return JSON.stringify(selfCheck(), null, 2)
      },
    }))

    console.log('dsh-refix ' + REFIX_VERSION + ' ready; contract '
      + (contractMissing.length === 0 ? 'OK (兼容性自检通过)' : 'MISSING: ' + contractMissing.join(', '))
      + '; baseline plugins: ' + initialCount)
  },
}
