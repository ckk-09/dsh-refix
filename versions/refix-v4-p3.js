// dsh-refix v4（P3 迭代）— 自诊断·自修复·自迭代插件
// 在 v3（契约探测 + 基线 + inspect provider + 事件/周期/按需巡检 + 症状识别 + 策略表修复 + 观察窗回退）之上新增：
//   F4 知识库（内存态）：{症状指纹 kind|pluginId, 方案, 结果}
//     · 同指纹复发 → 跳过 F2 策略推导，直接复用历史方案（refix_repair 返回 knowledgeHit）
//     · 历史方案上次结果为失败 → 命中即转人工，不执行（从失败中学习）
//     · 显式 targetPackageId 优先于知识库（模型的显式指令覆盖历史经验）
// 边界（需求 §2/§7）：不持久化（重启即失忆为预期行为）；修复仅 run/stop；不写盘不联网。
const REFIX_VERSION = 'p3.1'

const CONTRACT = {
  dynamicCordisRunner: ['define', 'undefine', 'run', 'stop', 'inventory', 'snapshot', 'listPlugins', 'inspectPlugin', 'inspectPackage', 'reference'],
  cordisInspect: ['register', 'list', 'query'],
}
const CONTRACT_EVENTS = ['cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/request-run', 'cordis/request-run-resolved']
const PATROL_PERIOD_MS = 15000
const OBSERVE_MS_DEFAULT = 30000 // §3 F3：切换后 30s 观察窗
const PROBE_METHOD = 'health'    // 巡检探针约定：受检插件可注册 health host 方法供巡检 invoke 探测

// 策略表（§5）：症状 → 严重度 / 修复策略（repair 为 false = 需人工，只报告不动手）
const SYMPTOMS = {
  'run-missing': { severity: 'high', repair: true, fixHint: '重新 run 原版本（低风险）' },
  'host-method-error': { severity: 'medium', repair: true, fixHint: 'stop → run 原版本软重置（低风险）' },
  'render-failure': { severity: 'medium', repair: false, fixHint: '需人工：定义新客户端半区版本后经审批流切换（v1 不自动生成修复代码）' },
  'activation-refused': { severity: 'manual', repair: false, fixHint: '需人工：报告拒绝原因，不重试' },
  'activation-failed': { severity: 'manual', repair: false, fixHint: '需人工：未收录的激活失败，只报告不动手' },
  unknown: { severity: 'manual', repair: false, fixHint: '需人工：未收录症状，只报告不动手' },
}
// 版本切换进行中的状态：retract 事件先于新 run 建立，此时不得误报 run 消失
const IN_FLIGHT = { 'starting-host': true, 'client-pending': true, 'awaiting-approval': true }

return {
  name: 'dsh-refix',
  inject: ['dynamicCordisRunner', 'cordisInspect', 'agents', 'timer'],
  apply(ctx) {
    const runner = ctx.dynamicCordisRunner
    const reports = []    // F1 诊断报告（内存态）
    const knowledge = []  // F4 知识库（内存态，随插件卸载销毁）
    const repairs = []    // F3 修复记录
    let reportSeq = 0
    let knowledgeSeq = 0
    let repairSeq = 0
    let patrolCount = 0
    let repairing = false
    const activeKeys = new Set()
    const probeSkipped = new Set()
    const suppressRunMissing = new Set()
    const recentEvents = []
    let lastSeen = {}

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
    function liveRow(pluginId) {
      const rows = runner.inventory()
      for (const row of rows) if (row.pluginId === pluginId) return row
      return undefined
    }

    function selfCheck() {
      return {
        version: REFIX_VERSION,
        contract: { ok: contractMissing.length === 0, missing: contractMissing },
        baseline: lastSeen,
        patrolCount: patrolCount,
        recentEvents: recentEvents,
        reports: reports,
        repairs: repairs,
        knowledge: knowledge,
      }
    }

    // ── cordisInspect provider（只读自检视图）────────────────────────
    ctx.effect(() => ctx.cordisInspect.register({
      manifest: {
        id: 'Refix',
        description: 'dsh-refix 自诊断视图：兼容性自检、inventory 基线、诊断报告、修复记录与知识库（只读）。',
        methods: [{
          name: 'listReports',
          description: '返回 dsh-refix 的兼容性自检结果、当前基线、诊断报告、修复记录与知识库。',
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
      if (activeKeys.has(key)) return null
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

    // ── F1 症状检测（同步 diff；探针异步发射）────────────────────────
    function detectRowSymptoms(row, prev) {
      const found = []
      const latest = row.latestRun

      // ① run 消失（修复进行中的插件抑制）
      if (prev && prev.activeRun && !row.activeRun && !(latest && IN_FLIGHT[latest.status])
        && !suppressRunMissing.has(row.pluginId)) {
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

      // ② 渲染失败
      if (latest && latest.error && latest.error.phase === 'client-render') {
        found.push(addReport('render-failure', row.pluginId, {
          phase: latest.error.phase,
          message: latest.error.message,
          pluginRunId: latest.pluginRunId,
        }))
      }

      // ③ 包激活被拒（不重试）
      if (latest && (latest.status === 'rejected' || (latest.error && latest.error.phase === 'approval'))) {
        found.push(addReport('activation-refused', row.pluginId, {
          status: latest.status,
          phase: latest.error ? latest.error.phase : null,
          message: latest.error ? latest.error.message : 'run request was declined',
          pluginRunId: latest.pluginRunId,
        }))
      }

      // ④ 激活失败（未收录，只报告）
      if (latest && latest.status === 'failed' && latest.error
        && latest.error.phase !== 'client-render' && latest.error.phase !== 'approval') {
        found.push(addReport('activation-failed', row.pluginId, {
          phase: latest.error.phase,
          message: latest.error.message,
          pluginRunId: latest.pluginRunId,
        }))
      }
      return found.filter(Boolean)
    }

    /** 异步发射 health 探针；promise 收集进 probes 供观察窗 drain。 */
    function queueProbe(row, probes) {
      if (!row.activeRun || probeSkipped.has(row.pluginId)) return
      try {
        const probeRunId = row.activeRun.pluginRunId
        const probePid = row.pluginId
        const p = runner.invoke(probePid, probeRunId, PROBE_METHOD, {}).then(function (r) {
          if (r && r.ok === false && r.code === 'handler-error') {
            addReport('host-method-error', probePid, {
              method: PROBE_METHOD,
              code: r.code,
              message: r.message,
              pluginRunId: probeRunId,
            })
          } else if (r && r.ok === false && r.code === 'method-not-found') {
            probeSkipped.add(probePid)
          }
        }, function () { /* invoke 传输层失败不算症状，下轮再探 */ })
        probes.push(p)
      } catch (e) { /* 探针异常不阻断巡检 */ }
    }

    // ── F1 巡检（只读）───────────────────────────────────────────────
    async function patrol(trigger) {
      if (contractMissing.length > 0) return { fresh: [], drain: Promise.resolve() }
      patrolCount += 1
      const rows = runner.inventory()
      const prev = lastSeen
      const next = {}
      for (const row of rows) next[row.pluginId] = rowView(row)
      lastSeen = next
      const fresh = []
      const probes = []
      for (const row of rows) {
        fresh.push.apply(fresh, detectRowSymptoms(row, prev[row.pluginId]))
        queueProbe(row, probes)
      }
      for (const key of Array.from(activeKeys)) {
        const parts = key.split('|')
        if (parts[0] === 'run-missing' && rows.some(function (row) {
          return row.pluginId === parts[1] && row.activeRun
        })) activeKeys.delete(key)
      }
      if (fresh.length > 0) {
        console.error('[refix] 巡检(' + trigger + ') 新增症状 ' + fresh.length + ' 条')
      }
      return { fresh: fresh, drain: Promise.all(probes).catch(function () {}) }
    }

    function patrolSafe(trigger) {
      patrol(trigger).catch(function (e) {
        console.error('[refix] 巡检异常: ' + ((e && e.message) || e))
      })
    }

    // ── F1 事件订阅 + 周期巡检 ───────────────────────────────────────
    ctx.effect(() => ctx.on('cordis/dynamic-package', function (pkg) {
      noteEvent('cordis/dynamic-package', pkg)
      patrolSafe('event:dynamic-package')
    }), 'refix.ev-dynamic-package')
    ctx.effect(() => ctx.on('cordis/dynamic-retract', function (retracted) {
      noteEvent('cordis/dynamic-retract', retracted)
      patrolSafe('event:dynamic-retract')
    }), 'refix.ev-dynamic-retract')
    ctx.interval(function () { patrolSafe('interval:' + PATROL_PERIOD_MS + 'ms') }, PATROL_PERIOD_MS)

    if (contractMissing.length === 0) snapshotInventory()

    // ── F2 处方：症状 → 修复计划 ─────────────────────────────────────
    function deriveMode(current, target) {
      return (current === undefined || current === null || current === target) ? 'run' : 'update'
    }

    function derivePlan(kind, row, targetPackageId) {
      const meta = SYMPTOMS[kind]
      if (!meta || !meta.repair) {
        return { ok: false, reason: 'manual-only', hint: meta ? meta.fixHint : SYMPTOMS.unknown.fixHint }
      }
      const current = row.currentPackageId || null
      if (targetPackageId) {
        return {
          ok: true, action: 'switch', target: targetPackageId, fallback: current,
          mode: deriveMode(current, targetPackageId),
        }
      }
      if (kind === 'run-missing') {
        const target = (row.activeRun && row.activeRun.packageId) || current || null
        if (!target) return { ok: false, reason: 'no-target', hint: '无原版本可重启，需人工' }
        return { ok: true, action: 'restart', target: target, fallback: null, mode: deriveMode(current, target) }
      }
      if (kind === 'host-method-error') {
        if (!current) return { ok: false, reason: 'no-target', hint: '尚无成功激活版本，软重置不可用，需人工' }
        return { ok: true, action: 'soft-reset', target: current, fallback: null, mode: 'run' }
      }
      return { ok: false, reason: 'manual-only', hint: SYMPTOMS.unknown.fixHint }
    }

    // ── F4 知识库：同指纹最新一条记录 ────────────────────────────────
    function latestKnowledge(fingerprint) {
      for (let i = knowledge.length - 1; i >= 0; i--) {
        if (knowledge[i].fingerprint === fingerprint) return knowledge[i]
      }
      return null
    }

    // ── F3 执行：修复 = 版本切换 + 观察窗 + 自动回退 ─────────────────
    async function executeRepair(plan, row, observeMs) {
      const steps = []
      // 观察窗基线 = 修复起点：激活瞬间的事件巡检探针可能在 run() 返回前就落册，
      // 任何更晚的截取点都会漏掉窗口内的真实症状（时序竞态，见 P2 报告踩坑记录）。
      const windowStart = reports.length
      const agent = ctx.agents ? ctx.agents.get(row.agentId) : undefined
      if (agent === undefined) {
        return { outcome: 'refused', reason: 'owner-session-not-live', detail: '归属会话不在线，无法取得授权 Agent' }
      }
      const markStep = (action, detail) => { steps.push({ ts: Date.now(), action: action, detail: detail }) }

      async function activate(packageId, mode, what) {
        markStep(what, 'run(' + packageId + ', ' + mode + ')')
        const r = await runner.run(agent, row.pluginId, packageId, mode)
        return r
      }

      let r
      if (plan.action === 'soft-reset') {
        markStep('stop', '软重置第一步')
        const s = await runner.stop(agent, row.pluginId)
        markStep('stopped', s.ok ? 'ok' : (s.message || s.reason))
        r = await activate(plan.target, plan.mode, 'run-after-stop')
      } else {
        r = await activate(plan.target, plan.mode, 'run')
      }
      if (!r.ok) {
        markStep('activation-failed', r.message)
        return { outcome: 'failed', phase: 'activation', detail: r.message, steps: steps }
      }
      if (r.status === 'awaiting-approval' || r.status === 'starting') {
        markStep('awaiting-approval', '客户端半区已提交原生审批流')
        return {
          outcome: 'awaiting-approval', status: r.status,
          detail: '客户端半区修复需用户在页面批准/拒绝；批准后可再巡检确认', steps: steps,
          packageId: r.packageId, pluginRunId: r.pluginRunId,
        }
      }

      // 观察窗：起点 = 修复起点（windowStart）
      markStep('observe', '观察窗 ' + observeMs + 'ms')
      await ctx.timeout(observeMs)
      const round = await patrol('repair-observe')
      await round.drain
      const newForTarget = reports.slice(windowStart).filter(function (rep) { return rep.pluginId === row.pluginId })
      if (newForTarget.length === 0) {
        markStep('observed-clean', '观察窗内无新症状')
        return { outcome: 'success', steps: steps, detail: '修复后观察窗无症状' }
      }

      // 修了还坏 → 自动回退
      if (plan.fallback) {
        const backMode = deriveMode(plan.target, plan.fallback)
        const backStart = reports.length // 先于回退 run 调用截取：无竞态
        markStep('rollback', '修复无效，自动回退 run(' + plan.fallback + ', ' + backMode + ')')
        const back = await runner.run(agent, row.pluginId, plan.fallback, backMode)
        if (!back.ok) {
          markStep('rollback-failed', back.message)
          return { outcome: 'failed', phase: 'rollback', detail: '修复无效且回退失败: ' + back.message, steps: steps }
        }
        markStep('rolled-back', '已回退至 ' + plan.fallback)
        await ctx.timeout(observeMs)
        const backRound = await patrol('repair-rollback-observe')
        await backRound.drain
        const newAfterBack = reports.slice(backStart).filter(function (rep) { return rep.pluginId === row.pluginId })
        return {
          outcome: 'failed', phase: 'repair-invalid', steps: steps,
          detail: '修复无效（观察窗内出现新症状），已自动回退至 ' + plan.fallback
            + (newAfterBack.length === 0 ? '，回退版本无症状' : '，但回退版本仍有症状，需人工'),
          rollback: { from: plan.target, to: plan.fallback, clean: newAfterBack.length === 0 },
        }
      }
      markStep('no-rollback', '无旧版本可回退')
      return { outcome: 'failed', phase: 'repair-invalid', detail: '修复无效且无旧版本可回退，需人工', steps: steps }
    }

    // ── 修复工具 ─────────────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_repair',
      description: 'dsh-refix 修复执行（F3+F4）：对指定插件按策略表或历史方案执行版本切换修复。'
        + ' symptom 省略时取该插件最近一条诊断报告；同症状此前修复成功过 → 直接复用历史方案（跳过策略推导）；'
        + ' targetPackageId 显式指定候选修复版本（优先于知识库）；'
        + ' 客户端半区自动走 DSH 原生审批流（不等待结果）。观察窗默认 30000ms。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '目标动态插件 ID（须与本会话归属一致）' },
        symptom: { type: 'string', description: '要修复的症状 kind（省略=该插件最近一条报告）' },
        targetPackageId: { type: 'string', description: '候选修复版本 packageId（省略=策略表/历史方案）' },
        observeMs: { type: 'integer', description: '观察窗时长 ms，默认 30000' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        if (contractMissing.length > 0) {
          return JSON.stringify({ outcome: 'refused', reason: 'contract-incompatible', missing: contractMissing }, null, 2)
        }
        if (repairing) {
          return JSON.stringify({ outcome: 'refused', reason: 'repair-in-progress' }, null, 2)
        }
        repairing = true
        suppressRunMissing.add(args.pluginId)
        try {
          const row = liveRow(args.pluginId)
          if (row === undefined) {
            return JSON.stringify({ outcome: 'refused', reason: 'plugin-not-found', detail: 'inventory 中无此插件' }, null, 2)
          }
          // 症状选择：显式指定 > 该插件最近一条报告
          let symptom = args.symptom
          if (!symptom) {
            for (let i = reports.length - 1; i >= 0; i--) {
              if (reports[i].pluginId === args.pluginId) { symptom = reports[i].kind; break }
            }
          }
          const fingerprint = (symptom || 'unknown') + '|' + args.pluginId

          // F4：同指纹历史方案命中（显式 targetPackageId 时模型指令优先）
          let plan = null
          let knowledgeHit = null
          if (!args.targetPackageId) {
            const prior = latestKnowledge(fingerprint)
            if (prior && prior.outcome === 'success') {
              knowledgeHit = { id: prior.id, action: prior.action, target: prior.target }
              prior.hits = (prior.hits || 0) + 1
              const current = row.currentPackageId || null
              plan = {
                ok: true, action: prior.action, target: prior.target, fallback: current,
                mode: deriveMode(current, prior.target), fromKnowledge: prior.id,
              }
            } else if (prior && prior.outcome !== 'success') {
              // 从失败中学习：上次方案无效，转人工
              return JSON.stringify({
                outcome: 'refused', reason: 'prior-fix-failed', symptom: symptom || 'none',
                detail: '命中历史方案 ' + prior.id + '，但其上次结果为 ' + prior.outcome + '，转人工处理',
                prior: { id: prior.id, action: prior.action, target: prior.target, outcome: prior.outcome },
              }, null, 2)
            }
          }
          if (!plan) plan = derivePlan(symptom, row, args.targetPackageId)
          if (!plan.ok) {
            // AC2.2：未收录/需人工症状 —— 只报告，不做任何修复动作
            return JSON.stringify({
              outcome: 'refused', reason: plan.reason, symptom: symptom || 'none',
              detail: '未收录症状或需人工介入，不做任何修复动作', hint: plan.hint,
            }, null, 2)
          }

          repairSeq += 1
          const record = {
            id: 'refix-x' + repairSeq, ts: Date.now(),
            pluginId: args.pluginId, symptom: symptom || 'none',
            plan: plan, observeMs: args.observeMs || OBSERVE_MS_DEFAULT,
            viaKnowledge: knowledgeHit ? knowledgeHit.id : null,
          }
          const result = await executeRepair(plan, row, record.observeMs)
          record.outcome = result.outcome
          record.result = result
          repairs.push(record)

          // F4：知识库记录（新处方入册；复用命中则更新原条目的最新结果）
          if (knowledgeHit) {
            const prior = latestKnowledge(fingerprint)
            if (prior && prior.id === knowledgeHit.id) prior.outcome = result.outcome
          } else if (result.outcome === 'success' || result.outcome === 'failed') {
            knowledgeSeq += 1
            knowledge.push({
              id: 'refix-k' + knowledgeSeq, ts: Date.now(),
              fingerprint: fingerprint, symptom: record.symptom,
              action: plan.action, target: plan.target,
              outcome: result.outcome, fromRepair: record.id, hits: 0,
            })
          }

          const summary = Object.assign({}, result, {
            symptom: record.symptom,
            plan: plan,
            knowledgeHit: knowledgeHit,
            packageIdPairs: plan.action === 'switch'
              ? { old: plan.fallback, new: plan.target }
              : { restartOf: plan.target },
          })
          return JSON.stringify(summary, null, 2)
        } finally {
          suppressRunMissing.delete(args.pluginId)
          repairing = false
        }
      },
    }))

    // ── 报告 / 巡检工具 ──────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_report',
      description: 'dsh-refix 自诊断报告：兼容性自检（F5）、inventory 基线、巡检计数、最近事件、诊断报告（F1）、修复记录（F3）与知识库（F4）。只读，无参数。',
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
        const round = await patrol('manual:refix_patrol')
        await round.drain
        return JSON.stringify({ triggered: 'manual', newSymptoms: round.fresh, patrolCount: patrolCount }, null, 2)
      },
    }))

    console.log('dsh-refix ' + REFIX_VERSION + ' ready; contract '
      + (contractMissing.length === 0 ? 'OK (兼容性自检通过)' : 'MISSING: ' + contractMissing.join(', '))
      + '; baseline plugins: ' + Object.keys(lastSeen).length + '; patrol every ' + PATROL_PERIOD_MS + 'ms')
  },
}
