// 【定版 V1.02】稳定版发布线 V1.0x（原开发代号 v2 / p1.1）
// dsh-refix v2（P1 诊断）— 自诊断·自修复·自迭代插件
// 在 v1（契约探测 + 基线 + inspect provider + refix_report）之上新增：
//   F1 事件订阅（dynamic-package / dynamic-retract）+ 周期巡检（timer 服务 15s）+ 按需巡检（refix_patrol）
//   症状识别：run 消失 / 宿主方法抛错（health 探针约定）/ 渲染失败 / 包激活被拒 / 激活失败 / 未知兜底
// 边界（需求 §2）：诊断只读（inventory diff + health 探针）；修复动作仅 P2 的 refix_repair。
const REFIX_VERSION = 'p1.1'

const CONTRACT = {
  dynamicCordisRunner: ['define', 'undefine', 'run', 'stop', 'inventory', 'snapshot', 'listPlugins', 'inspectPlugin', 'inspectPackage', 'reference'],
  cordisInspect: ['register', 'list', 'query'],
}
const CONTRACT_EVENTS = ['cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/request-run', 'cordis/request-run-resolved']
const PATROL_PERIOD_MS = 15000
const PROBE_METHOD = 'health' // 巡检探针约定：受检插件可注册 health host 方法供巡检 invoke 探测

// 策略表（§5）：症状 → 严重度 / 修复提示（修复执行在 P2 接入）
const SYMPTOMS = {
  'run-missing': { severity: 'high', fixHint: '重新 run 原版本（低风险）' },
  'host-method-error': { severity: 'medium', fixHint: 'stop → run 原版本软重置（低风险）' },
  'render-failure': { severity: 'medium', fixHint: '需人工：定义新客户端半区版本后经审批流切换（v1 不自动生成修复代码）' },
  'activation-refused': { severity: 'manual', fixHint: '需人工：报告拒绝原因，不重试' },
  'activation-failed': { severity: 'manual', fixHint: '需人工：未收录的激活失败，只报告不动手' },
  unknown: { severity: 'manual', fixHint: '需人工：未收录症状，只报告不动手' },
}

return {
  name: 'dsh-refix',
  inject: ['dynamicCordisRunner', 'cordisInspect', 'agents', 'timer'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    const reports = []   // F1 诊断报告（内存态）
    const knowledge = [] // F4 知识库（P3 启用）
    let reportSeq = 0
    let patrolCount = 0
    const activeKeys = new Set()   // 去重：已报告且仍在持续的症状
    const probeSkipped = new Set() // 无 health 探针的插件，避免每轮重复 invoke
    const recentEvents = []        // 最近 cordis/* 事件（证据用，环形上限 20）
    let lastSeen = {}              // 上一轮 inventory 快照（同时作为基线展示）

    // ── F5 兼容性自检 ────────────────────────────────────────────────
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

    // ── 只读视图 ─────────────────────────────────────────────────────
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
    function snapshotInventory() {
      const next = {}
      for (const row of runner.inventory()) next[row.pluginId] = rowView(row)
      lastSeen = next
      return next
    }

    function selfCheck() {
      return {
        version: REFIX_VERSION,
        contract: { ok: contractMissing.length === 0, missing: contractMissing },
        baseline: lastSeen,
        patrolCount: patrolCount,
        recentEvents: recentEvents,
        reports: reports,
        knowledge: knowledge,
      }
    }

    // ── P0：cordisInspect provider（只读自检视图）────────────────────
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

    // ── F1 报告与去重 ────────────────────────────────────────────────
    function addReport(kind, pluginId, evidence) {
      const meta = SYMPTOMS[kind] || SYMPTOMS.unknown
      const key = kind + '|' + pluginId + '|' + (evidence.pluginRunId || '') + '|' + (evidence.message || '')
      if (activeKeys.has(key)) return null // 持续中的症状不重复报告
      activeKeys.add(key)
      reportSeq += 1
      const entry = {
        id: 'refix-r' + reportSeq,
        ts: Date.now(),
        kind: kind,
        severity: meta.severity,
        pluginId: pluginId,
        evidence: evidence,
        fixHint: meta.fixHint,
      }
      reports.push(entry)
      console.error('[refix] 症状 ' + kind + ' @ ' + pluginId + ' 严重度 ' + meta.severity)
      return entry
    }

    function noteEvent(name, payload) {
      recentEvents.push({ ts: Date.now(), event: name, pluginId: (payload && payload.pluginId) || null })
      if (recentEvents.length > 20) recentEvents.shift()
    }

    // ── F1 症状检测（对一行 inventory）───────────────────────────────
    // 版本切换进行中的状态：retract 事件先于新 run 建立，此时不得误报 run 消失
    const IN_FLIGHT = { 'starting-host': true, 'client-pending': true, 'awaiting-approval': true }
    function detectRowSymptoms(row, prev) {
      const found = []
      const latest = row.latestRun

      // ① run 消失：上一轮有 activeRun，本轮没了，且不处于版本切换进行中
      //   （runner 时序：stop/update 都是先 retract 后更新 latestRun.status，
      //    故仅在状态仍为进行中时抑制；停机在 emit 时刻 status 仍是 running，属正常报告）
      if (prev && prev.activeRun && !row.activeRun && !(latest && IN_FLIGHT[latest.status])) {
        const retract = recentEvents.filter(function (e) {
          return e.event === 'cordis/dynamic-retract' && e.pluginId === row.pluginId
        }).slice(-1)[0]
        found.push(addReport('run-missing', row.pluginId, {
          before: prev.activeRun,
          after: { activeRun: null, latestStatus: latest ? latest.status : null },
          observedVia: retract ? 'event:cordis/dynamic-retract + inventory-diff' : 'inventory-diff',
          pluginRunId: prev.activeRun.pluginRunId,
        }))
      }

      // ② 渲染失败：latestRun.error.phase === 'client-render'
      if (latest && latest.error && latest.error.phase === 'client-render') {
        found.push(addReport('render-failure', row.pluginId, {
          phase: latest.error.phase,
          message: latest.error.message,
          pluginRunId: latest.pluginRunId,
        }))
      }

      // ③ 包激活被拒：审批被拒，不重试
      if (latest && (latest.status === 'rejected' || (latest.error && latest.error.phase === 'approval'))) {
        found.push(addReport('activation-refused', row.pluginId, {
          status: latest.status,
          phase: latest.error ? latest.error.phase : null,
          message: latest.error ? latest.error.message : 'run request was declined',
          pluginRunId: latest.pluginRunId,
        }))
      }

      // ④ 激活失败（host-load/host-apply/client-load/client-apply）：未收录，只报告
      if (latest && latest.status === 'failed' && latest.error
        && latest.error.phase !== 'client-render' && latest.error.phase !== 'approval') {
        found.push(addReport('activation-failed', row.pluginId, {
          phase: latest.error.phase,
          message: latest.error.message,
          pluginRunId: latest.pluginRunId,
        }))
      }

      // ⑤ 宿主方法抛错：health 探针（§5 策略表"巡检 invoke 失败"）
      if (row.activeRun && !probeSkipped.has(row.pluginId)) {
        try {
          const probeRunId = row.activeRun.pluginRunId
          const probePid = row.pluginId
          const result = runner.invoke(probePid, probeRunId, PROBE_METHOD, {})
          if (result && typeof result.then === 'function') {
            result.then(function (r) {
              if (r && r.ok === false && r.code === 'handler-error') {
                addReport('host-method-error', probePid, {
                  method: PROBE_METHOD,
                  code: r.code,
                  message: r.message,
                  pluginRunId: probeRunId,
                })
              } else if (r && r.ok === false && r.code === 'method-not-found') {
                probeSkipped.add(probePid) // 无探针约定，不再重复 invoke
              }
            }, function () { /* invoke 传输层失败不算症状，下轮再探 */ })
          }
        } catch (e) { /* 探针异常不阻断巡检 */ }
      }
      return found.filter(Boolean)
    }

    // ── F1 巡检（只读：inventory diff + health 探针）────────────────
    function patrol(trigger) {
      if (contractMissing.length > 0) return [] // 契约不兼容：不执行任何动作（AC5.2）
      patrolCount += 1
      const rows = runner.inventory()
      const prev = lastSeen
      const next = {}
      for (const row of rows) next[row.pluginId] = rowView(row)
      lastSeen = next
      const fresh = []
      for (const row of rows) fresh.push.apply(fresh, detectRowSymptoms(row, prev[row.pluginId]))
      // run-missing 解除（activeRun 恢复）后允许同插件再次报告
      for (const key of Array.from(activeKeys)) {
        const parts = key.split('|')
        if (parts[0] === 'run-missing' && rows.some(function (row) {
          return row.pluginId === parts[1] && row.activeRun
        })) activeKeys.delete(key)
      }
      if (fresh.length > 0) {
        console.error('[refix] 巡检(' + trigger + ') 新增症状 ' + fresh.length + ' 条')
      }
      return fresh
    }

    // ── F1 事件订阅：activation/retract 即时触发一轮巡检 ─────────────
    ctx.effect(() => ctx.on('cordis/dynamic-package', function (pkg) {
      noteEvent('cordis/dynamic-package', pkg)
      try { patrol('event:dynamic-package') } catch (e) { console.error('[refix] 巡检异常: ' + ((e && e.message) || e)) }
    }), 'refix.ev-dynamic-package')
    ctx.effect(() => ctx.on('cordis/dynamic-retract', function (retracted) {
      noteEvent('cordis/dynamic-retract', retracted)
      try { patrol('event:dynamic-retract') } catch (e) { console.error('[refix] 巡检异常: ' + ((e && e.message) || e)) }
    }), 'refix.ev-dynamic-retract')

    // ── F1 周期巡检（timer 服务，fiber effect，stop 自动清理）────────
    ctx.interval(function () {
      try { patrol('interval:' + PATROL_PERIOD_MS + 'ms') }
      catch (e) { console.error('[refix] 周期巡检异常: ' + ((e && e.message) || e)) }
    }, PATROL_PERIOD_MS)

    // ── 初始基线 ─────────────────────────────────────────────────────
    if (contractMissing.length === 0) snapshotInventory()

    // ── 模型侧工具 ───────────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_report',
      description: 'dsh-refix 自诊断报告：兼容性自检（F5）、inventory 基线、巡检计数、最近事件与诊断报告列表（F1）。只读，无参数。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute() {
        if (contractMissing.length === 0) snapshotInventory()
        return JSON.stringify(selfCheck(), null, 2)
      },
    }))

    ctx.tools.register(harness.defineTool({
      name: 'refix_patrol',
      description: '让 dsh-refix 立即执行一轮只读巡检（inventory diff + health 探针），返回本轮新识别的症状。无参数。同一症状持续期间不会重复报告。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute() {
        const fresh = patrol('manual:refix_patrol')
        return JSON.stringify({ triggered: 'manual', newSymptoms: fresh, patrolCount: patrolCount }, null, 2)
      },
    }))

    console.log('dsh-refix ' + REFIX_VERSION + ' ready; contract '
      + (contractMissing.length === 0 ? 'OK (兼容性自检通过)' : 'MISSING: ' + contractMissing.join(', '))
      + '; baseline plugins: ' + Object.keys(lastSeen).length + '; patrol every ' + PATROL_PERIOD_MS + 'ms')
  },
}
