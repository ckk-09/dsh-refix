// dsh-refix v6（P3R2 复检修复版 p3.3）— 自诊断·自修复·自迭代插件
// 在 v5 之上按复检报告修复：
//   N-3  refix_patrol 调用点漏改（patrol 现为两参，删除多传的 null）→ pluginId 过滤真正生效
//   N-1  expectedRetracts 泄漏：宿主 retract() 在无 run 时早退不发事件 → 登记前判 activeRun
//        + executeRepair finally 清零兜底（停止态修复不再吞掉后续真实 run-missing）
//   N-4  知识库写回仅 success/failed（awaiting-approval/refused 不再把可用处方降级为永久转人工）
//   N-5  V-11 结论纠正：ToolExecutionInput.agent 就是调用者身份 → 三工具 execute(args, exec)，
//        refix_repair 强制同会话校验（exec.agent.id !== row.agentId → refused 'cross-session'）
//   N-2  activeKeys 环形上限（>400 删最旧）
//   加固  inspectPackage 单次调用（预校验+指纹共用，空 catch 吞错消除）
//   加固  观察窗水位改单调 reportSeq（reports.length 截断 shift 不再影响窗口判定）
//   加固  V-4 判定删 pluginRunId===undefined 死分支（严格 === newRunId）
//   加固  自身指纹改专用常量 REFIX_FINGERPRINT（'refix_report' 通用词不再误伤正常插件）
//   加固  probeSkipped 每 10 轮巡检重试（同版本迟到注册 health 可复活）
//   加固  三工具声明 timeoutMs；repair 阶段边界响应 exec.signal 取消
const REFIX_VERSION = 'p3.3'

const CONTRACT = {
  dynamicCordisRunner: ['define', 'undefine', 'run', 'stop', 'inventory', 'snapshot', 'listPlugins', 'inspectPlugin', 'inspectPackage', 'reference'],
  cordisInspect: ['register', 'list', 'query'],
}
const CONTRACT_EVENTS = ['cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/request-run', 'cordis/request-run-resolved']
const PATROL_PERIOD_MS = 15000
const OBSERVE_MS_DEFAULT = 30000 // §3 F3：切换后 30s 观察窗
const OBSERVE_MS_MAX = 120000    // V-3：观察窗上限 2 分钟
const PROBE_TIMEOUT_MS = 2000    // V-1：单探针超时
const DRAIN_TIMEOUT_MS = 5000    // V-1：drain 兜底超时
const CAPS = { reports: 100, repairs: 100, knowledge: 100, keys: 400 } // V-8/N-2：内存环形上限
const PROBE_METHOD = 'health'
const SELF_PLUGIN_NAME = 'dsh-refix'        // V-2 第一层锚点（name 前缀）
const SELF_REPAIR_TOOL_TIMEOUT = 300000     // 加固③：修复工具超时（2×OBSERVE_MS_MAX + 余量）
// V-2 第二层锚点（行为指纹）：宿主源码含本常量 = dsh-refix 自身。专用随机串避免误伤普通插件。
const REFIX_FINGERPRINT = 'refix-self-fingerprint-a7f3'

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
    const reports = []    // F1 诊断报告（内存态，环形上限）
    const knowledge = []  // F4 知识库（内存态，随插件卸载销毁）
    const repairs = []    // F3 修复记录
    let reportSeq = 0
    let knowledgeSeq = 0
    let repairSeq = 0
    let patrolCount = 0
    let repairing = false
    let ownPluginId = null // V-2：从自身激活事件捕获
    const activeKeys = new Set()   // N-2：环形上限，>CAPS.keys 删最旧
    const probeSkipped = new Set() // V-6：键 = pluginId|packageId，版本变化自动失效；每 10 轮重试
    const expectedRetracts = new Map() // V-5/N-1：refix 自己发起的 retract 计数（登记前判 activeRun）
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

    function selfCheck(limit) {
      return {
        version: REFIX_VERSION,
        contract: { ok: contractMissing.length === 0, missing: contractMissing },
        baseline: lastSeen,
        patrolCount: patrolCount,
        recentEvents: recentEvents,
        reports: limit ? reports.slice(-limit) : reports,
        repairs: limit ? repairs.slice(-limit) : repairs,
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
    // 去重键为结构化信息的字符串编码：message 含 '|' 时 split 解析会错位，
    // 但消费方（run-missing 清理）只读前两段，实际安全（V-15）。
    function addReport(kind, pluginId, evidence) {
      const meta = SYMPTOMS[kind] || SYMPTOMS.unknown
      const key = kind + '|' + pluginId + '|' + (evidence.pluginRunId || '') + '|' + (evidence.message || '')
      if (activeKeys.has(key)) return null
      activeKeys.add(key)
      if (activeKeys.size > CAPS.keys) { // N-2：删最旧（Set 保序）
        for (const oldest of activeKeys) { activeKeys.delete(oldest); break }
      }
      reportSeq += 1
      const entry = {
        id: 'refix-r' + reportSeq,
        seq: reportSeq, // 加固⑥：单调水位，观察窗判定不受环形截断影响
        ts: Date.now(),
        kind: kind,
        severity: meta.severity,
        pluginId: pluginId,
        evidence: evidence,
        fixHint: meta.fixHint,
      }
      reports.push(entry)
      if (reports.length > CAPS.reports) reports.shift()
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

      // ① run 消失（V-5：仅当 retract 非 refix 自己预期发起时）
      //    V-14 注：run-missing 通常发生在 !activeRun 时，此处 activeRun 仅在模型显式
      //    指定 symptom='run-missing' 且插件实际运行时可达（语义=重启）。
      if (prev && prev.activeRun && !row.activeRun && !(latest && IN_FLIGHT[latest.status])
        && (expectedRetracts.get(row.pluginId) || 0) === 0) {
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
      if (!row.activeRun) return
      const skipKey = row.pluginId + '|' + row.activeRun.packageId // V-6：按版本失效
      // 加固⑤：每 10 轮巡检无视 skip 重试一次（同版本迟到注册 health 可复活）
      if (probeSkipped.has(skipKey) && patrolCount % 10 !== 0) return
      try {
        const probeRunId = row.activeRun.pluginRunId
        const probePid = row.pluginId
        const p = withTimeout(
          runner.invoke(probePid, probeRunId, PROBE_METHOD, {}),
          PROBE_TIMEOUT_MS,
        ).then(function (r) {
          if (r && r.ok === false && r.code === 'handler-error') {
            addReport('host-method-error', probePid, {
              method: PROBE_METHOD,
              code: r.code,
              message: r.message,
              pluginRunId: probeRunId,
            })
          } else if (r && r.ok === false && r.code === 'method-not-found') {
            probeSkipped.add(skipKey)
          } else if (r && r.ok === false && r.code === 'refix-timeout') {
            // V-1：探针超时不算症状（策略表未收录），只留痕
            console.error('[refix] 探针超时 @ ' + probePid + '（' + PROBE_TIMEOUT_MS + 'ms，不计症状）')
          }
        }, function () { /* invoke 传输层失败不算症状，下轮再探 */ })
        probes.push(p)
      } catch (e) { /* 探针异常不阻断巡检 */ }
    }

    // V-1：给任意 promise 加超时护栏；超时返回 {ok:false, code:'refix-timeout'}
    function withTimeout(p, ms) {
      return Promise.race([
        p,
        ctx.timeout(ms).then(function () { return { ok: false, code: 'refix-timeout' } }),
      ])
    }

    // ── F1 巡检（只读）───────────────────────────────────────────────
    // 抑制时序说明：retract 事件在 runner.stop()/run(update) 内同步发出并同步完成
    // 本轮 diff，之后才递减 expectedRetracts——抑制窗口恰好覆盖事件当拍，无泄漏。
    async function patrol(trigger, onlyPid) {
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
        if (onlyPid && row.pluginId !== onlyPid) continue // O-7：按需过滤
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

    function patrolSafe(trigger, onlyPid) {
      patrol(trigger, onlyPid).catch(function (e) {
        console.error('[refix] 巡检异常: ' + ((e && e.message) || e))
      })
    }

    // ── F1 事件订阅 + 周期巡检 ───────────────────────────────────────
    ctx.effect(() => ctx.on('cordis/dynamic-package', function (pkg) {
      noteEvent('cordis/dynamic-package', pkg)
      // V-2：捕获自身 pluginId（payload.name = cordis_define 的 name，前缀匹配容忍命名后缀）
      if (pkg && typeof pkg.name === 'string' && pkg.name.indexOf(SELF_PLUGIN_NAME) === 0) {
        ownPluginId = pkg.pluginId
      }
      patrolSafe('event:dynamic-package')
    }), 'refix.ev-dynamic-package')
    ctx.effect(() => ctx.on('cordis/dynamic-retract', function (retracted) {
      noteEvent('cordis/dynamic-retract', retracted)
      // V-5：仅当该 retract 是 refix 自己预期发起（stop / update-mode run）时抑制本轮该 pid 的
      // run-missing（detectRowSymptoms 内查 expectedRetracts；计数在巡检后递减）。
      const pid = retracted && retracted.pluginId
      const expected = expectedRetracts.get(pid) || 0
      patrolSafe('event:dynamic-retract')
      if (expected > 0) expectedRetracts.set(pid, expected - 1)
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
          ok: true, action: 'switch', target: targetPackageId,
          // V-13：target 即当前版本时没有"旧版本"可回退，置 null 避免假回退
          fallback: current === targetPackageId ? null : current,
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
    async function executeRepair(plan, row, observeMs, signal) {
      const steps = []
      // 加固⑥：观察窗水位 = 单调 reportSeq（reports.length 会因环形截断 shift 失真）
      const windowStartSeq = reportSeq
      const agent = ctx.agents ? ctx.agents.get(row.agentId) : undefined
      if (agent === undefined) {
        return { outcome: 'refused', reason: 'owner-session-not-live', detail: '归属会话不在线，无法取得授权 Agent' }
      }
      const markStep = (action, detail) => { steps.push({ ts: Date.now(), action: action, detail: detail }) }
      const checkAborted = () => { if (signal && signal.aborted) throw new Error('tool call cancelled') }

      // O-2 + V-2 第二层（合并单次 inspectPackage；空 catch 吞错消除）：
      //   包不存在 → target-not-found；host 源码含 REFIX_FINGERPRINT → 自身，拒绝。
      let hostSrc = ''
      try {
        const pkg = runner.inspectPackage(agent, row.pluginId, plan.target)
        hostSrc = (pkg && pkg.code && pkg.code.host) || ''
      } catch (e) {
        markStep('precheck-failed', (e && e.message) || 'inspectPackage failed')
        return { outcome: 'refused', phase: 'precheck', reason: 'target-not-found', detail: '候选修复版本不存在: ' + ((e && e.message) || e), steps: steps }
      }
      if (hostSrc.indexOf(REFIX_FINGERPRINT) !== -1) {
        markStep('self-repair-detected', '目标包源码含 dsh-refix 指纹')
        return { outcome: 'refused', phase: 'precheck', reason: 'self-repair-forbidden', detail: '目标包是 dsh-refix 自身（源码指纹命中）。软重置会销毁自身 fiber，行为未定义；更新请用 cordis_define 追加新版本。', steps: steps }
      }

      // N-1：仅当确有活跃 run 会产生 retract 时才登记（宿主 retract() 在无 run 时早退不发事件，
      // 无条件登记会让停止态修复泄漏计数、吞掉后续真实 run-missing）。
      const expectRetract = () => {
        if (row.activeRun) expectedRetracts.set(row.pluginId, (expectedRetracts.get(row.pluginId) || 0) + 1)
      }

      async function activate(packageId, mode, what) {
        markStep(what, 'run(' + packageId + ', ' + mode + ')')
        const r = await runner.run(agent, row.pluginId, packageId, mode)
        return r
      }

      try {
        let r
        if (plan.action === 'soft-reset') {
          markStep('stop', '软重置第一步')
          expectRetract() // V-5：自己的 stop 会产生一次 retract
          const s = await runner.stop(agent, row.pluginId)
          markStep('stopped', s.ok ? 'ok' : (s.message || s.reason))
          r = await activate(plan.target, plan.mode, 'run-after-stop')
        } else {
          if (plan.mode === 'update') expectRetract() // V-5：热更新会撤旧 run
          r = await activate(plan.target, plan.mode, 'run')
        }
        if (!r.ok) {
          markStep('activation-failed', r.message)
          return { outcome: 'failed', phase: 'activation', detail: r.message, steps: steps }
        }
        const newRunId = r.pluginRunId // V-4：观察窗判定的 attempt 锚点
        if (r.status === 'awaiting-approval' || r.status === 'starting') {
          markStep('awaiting-approval', '客户端半区已提交原生审批流')
          return {
            outcome: 'awaiting-approval', status: r.status,
            detail: '客户端半区修复需用户在页面批准/拒绝；批准后可再巡检确认', steps: steps,
            packageId: r.packageId, pluginRunId: r.pluginRunId,
          }
        }

        // 观察窗：水位 = windowStartSeq（单调），判定严格锚定本次激活 attempt
        markStep('observe', '观察窗 ' + observeMs + 'ms')
        await ctx.timeout(observeMs)
        checkAborted() // 加固③：阶段边界响应取消
        const round = await patrol('repair-observe')
        await Promise.race([round.drain, ctx.timeout(DRAIN_TIMEOUT_MS)]) // V-1：兜底超时
        const newForTarget = reports.filter(function (rep) {
          return rep.seq > windowStartSeq
            && rep.pluginId === row.pluginId
            && rep.evidence.pluginRunId === newRunId // V-4：严格锚定（死分支已删）
        })
        if (newForTarget.length === 0) {
          markStep('observed-clean', '观察窗内无新症状')
          return { outcome: 'success', steps: steps, detail: '修复后观察窗无症状' }
        }

        // 修了还坏 → 自动回退（V-13：fallback === target 时 plan.fallback 已为 null，不进来）
        if (plan.fallback) {
          const backMode = deriveMode(plan.target, plan.fallback)
          const backStartSeq = reportSeq // 先于回退 run 截取：无竞态
          markStep('rollback', '修复无效，自动回退 run(' + plan.fallback + ', ' + backMode + ')')
          if (backMode === 'update') expectRetract()
          const back = await runner.run(agent, row.pluginId, plan.fallback, backMode)
          if (!back.ok) {
            markStep('rollback-failed', back.message)
            return { outcome: 'failed', phase: 'rollback', detail: '修复无效且回退失败: ' + back.message, steps: steps }
          }
          const backRunId = back.pluginRunId
          markStep('rolled-back', '已回退至 ' + plan.fallback)
          await ctx.timeout(observeMs)
          checkAborted()
          const backRound = await patrol('repair-rollback-observe')
          await Promise.race([backRound.drain, ctx.timeout(DRAIN_TIMEOUT_MS)])
          const newAfterBack = reports.filter(function (rep) {
            return rep.seq > backStartSeq
              && rep.pluginId === row.pluginId
              && rep.evidence.pluginRunId === backRunId
          })
          return {
            outcome: 'failed', phase: 'repair-invalid', steps: steps,
            detail: '修复无效（观察窗内出现新症状），已自动回退至 ' + plan.fallback
              + (newAfterBack.length === 0 ? '，回退版本无症状' : '，但回退版本仍有症状，需人工'),
            rollback: { from: plan.target, to: plan.fallback, clean: newAfterBack.length === 0 },
          }
        }
        markStep('no-rollback', '无旧版本可回退')
        return { outcome: 'failed', phase: 'repair-invalid', detail: '修复无效且无旧版本可回退，需人工', steps: steps }
      } finally {
        // N-1 纵深：修复结束后该 pid 不应残留任何预期 retract 计数
        expectedRetracts.delete(row.pluginId)
      }
    }

    // ── 修复工具 ─────────────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_repair',
      description: 'dsh-refix 修复执行（F3+F4）：对指定插件按策略表或历史方案执行版本切换修复。'
        + ' symptom 省略时取该插件最近一条诊断报告；同症状此前修复成功过 → 直接复用历史方案（跳过策略推导）；'
        + ' targetPackageId 显式指定候选修复版本（优先于知识库）；'
        + ' 客户端半区自动走 DSH 原生审批流（不等待结果）。观察窗默认 30000ms、上限 120000ms。'
        + ' 权限：仅可修复与调用者同会话的插件（跨会话拒绝）；不得对 dsh-refix 自身调用。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '目标动态插件 ID（须与调用者同会话；不得为 dsh-refix 自身）' },
        symptom: { type: 'string', description: '要修复的症状 kind（省略=该插件最近一条报告）' },
        targetPackageId: { type: 'string', description: '候选修复版本 packageId（省略=策略表/历史方案）' },
        observeMs: { type: 'integer', description: '观察窗时长 ms，默认 30000，上限 120000' },
      },
      timeoutMs: SELF_REPAIR_TOOL_TIMEOUT, // 加固③
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args, exec) { // N-5：exec 携带调用者身份与取消信号
        if (contractMissing.length > 0) {
          return JSON.stringify({ outcome: 'refused', reason: 'contract-incompatible', missing: contractMissing }, null, 2)
        }
        // V-2：拒绝对自身修复（stop 自身会销毁自己的 fiber，观察窗行为未定义）
        if (ownPluginId !== null && args.pluginId === ownPluginId) {
          return JSON.stringify({
            outcome: 'refused', reason: 'self-repair-forbidden',
            detail: '不得对 dsh-refix 自身执行修复：软重置会销毁自身 fiber，观察窗行为未定义。更新 dsh-refix 请用 cordis_define 追加新版本 + cordis_run 切换。',
          }, null, 2)
        }
        if (repairing) {
          return JSON.stringify({ outcome: 'refused', reason: 'repair-in-progress' }, null, 2)
        }
        repairing = true
        try {
          const row = liveRow(args.pluginId)
          if (row === undefined) {
            return JSON.stringify({ outcome: 'refused', reason: 'plugin-not-found', detail: 'inventory 中无此插件' }, null, 2)
          }
          // N-5：同会话校验（调用者身份来自 ToolExecutionInput.agent；缺失时放行并注明）
          if (exec && exec.agent && exec.agent.id !== row.agentId) {
            return JSON.stringify({
              outcome: 'refused', reason: 'cross-session',
              detail: '目标插件归属会话 ' + row.agentId + '，与调用者会话 ' + exec.agent.id + ' 不一致，拒绝修复',
            }, null, 2)
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
              prior.attempts = (prior.attempts || 0) + 1 // V-7
              const current = row.currentPackageId || null
              plan = {
                ok: true, action: prior.action, target: prior.target,
                fallback: current === prior.target ? null : current, // V-13
                mode: deriveMode(current, prior.target), fromKnowledge: prior.id,
              }
            } else if (prior && prior.outcome !== 'success') {
              // 从失败中学习：上次方案无效，转人工
              return JSON.stringify({
                outcome: 'refused', reason: 'prior-fix-failed', symptom: symptom || 'none',
                detail: '命中历史方案 ' + prior.id + '，但其上次结果为 ' + prior.outcome + '，转人工处理',
                prior: { id: prior.id, action: prior.action, target: prior.target, outcome: prior.outcome, failures: prior.failures || 1 },
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

          // V-3：观察窗钳制
          const raw = typeof args.observeMs === 'number' && isFinite(args.observeMs) ? args.observeMs : OBSERVE_MS_DEFAULT
          const observeMs = Math.min(Math.max(raw, 0), OBSERVE_MS_MAX)

          repairSeq += 1
          const record = {
            id: 'refix-x' + repairSeq, ts: Date.now(),
            pluginId: args.pluginId, symptom: symptom || 'none',
            plan: plan, observeMs: observeMs,
            viaKnowledge: knowledgeHit ? knowledgeHit.id : null,
          }
          let result
          try {
            result = await executeRepair(plan, row, observeMs, exec && exec.signal)
          } catch (e) {
            // V-10：runner 异常结构化兜底，审计不丢条目
            result = { outcome: 'failed', phase: 'exception', detail: '修复执行异常: ' + ((e && e.message) || e), steps: [] }
          }
          record.outcome = result.outcome
          record.result = result
          repairs.push(record)
          if (repairs.length > CAPS.repairs) repairs.shift()

          // F4：知识库记录（N-4：仅 success/failed 写回；awaiting-approval/refused 不降级处方）
          if (knowledgeHit) {
            const prior = latestKnowledge(fingerprint)
            if (prior && prior.id === knowledgeHit.id
              && (result.outcome === 'success' || result.outcome === 'failed')) {
              prior.outcome = result.outcome
              if (result.outcome === 'success') prior.successes = (prior.successes || 0) + 1
              else prior.failures = (prior.failures || 0) + 1 // V-7
            }
          } else if (result.outcome === 'success' || result.outcome === 'failed') {
            knowledgeSeq += 1
            knowledge.push({
              id: 'refix-k' + knowledgeSeq, ts: Date.now(),
              fingerprint: fingerprint, symptom: record.symptom,
              action: plan.action, target: plan.target,
              outcome: result.outcome, fromRepair: record.id, hits: 0,
              attempts: 0, successes: result.outcome === 'success' ? 1 : 0, failures: result.outcome === 'failed' ? 1 : 0, // V-7
            })
            if (knowledge.length > CAPS.knowledge) knowledge.shift()
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
          // V-1：observeMs/drain/timeoutMs 均有界 → 本 finally 必然执行，状态机必然复位
          repairing = false
        }
      },
    }))

    // ── 报告 / 巡检工具 ──────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_report',
      description: 'dsh-refix 自诊断报告：兼容性自检（F5）、inventory 基线、巡检计数、最近事件、诊断报告（F1）、修复记录（F3）与知识库（F4）。只读。'
        + ' limit 可选：只返回最近 N 条报告/修复记录（省略=全量，注意长驻会话的上下文体积）。',
      parameters: {
        limit: { type: 'integer', description: '只返回最近 N 条 reports/repairs（省略=全量）' },
      },
      timeoutMs: 15000, // 加固③
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        if (contractMissing.length === 0) snapshotInventory()
        const limit = typeof args.limit === 'number' && isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0
        return JSON.stringify(selfCheck(limit), null, 2)
      },
    }))
    ctx.tools.register(harness.defineTool({
      name: 'refix_patrol',
      description: '让 dsh-refix 立即执行一轮只读巡检（inventory diff + health 探针），返回本轮新识别的症状。同一症状持续期间不会重复报告。pluginId 可选：只巡检指定插件。',
      parameters: {
        pluginId: { type: 'string', description: '只巡检该插件（省略=全量）' },
      },
      timeoutMs: 30000, // 加固③
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const onlyPid = args && args.pluginId ? args.pluginId : null
        // N-3：patrol 现为两参签名（P3R 删 suppressPid 时漏改此处致过滤恒失效）
        const round = await patrol(onlyPid ? 'manual:' + onlyPid : 'manual:refix_patrol', onlyPid)
        await Promise.race([round.drain, ctx.timeout(DRAIN_TIMEOUT_MS)]) // V-1
        return JSON.stringify({ triggered: 'manual', onlyPid: onlyPid, newSymptoms: round.fresh, patrolCount: patrolCount }, null, 2)
      },
    }))

    console.log('dsh-refix ' + REFIX_VERSION + ' ready; contract '
      + (contractMissing.length === 0 ? 'OK (兼容性自检通过)' : 'MISSING: ' + contractMissing.join(', '))
      + '; baseline plugins: ' + Object.keys(lastSeen).length + '; patrol every ' + PATROL_PERIOD_MS + 'ms')
  },
}
