// 【定版 V1.08】稳定版发布线 V1.0x —— 独立审查（2026-09-18）修复版（基线 V1.07 / p3.4）
// dsh-refix — 自诊断·自修复·自迭代插件。本版按独立审查报告六项缺陷修复：
//   I-1(🔴P1/N-1) CONTRACT.dynamicCordisRunner 补 'invoke'——消除 F5 契约自检对探针调用面的盲区
//   I-2(🟡P2/N-2) refix_report 改走 patrol('report') 检测路径——report 不再静默消费 diff 基线，
//                 避免"巡检间隙发生的 run-missing 被一次 report 永久抹掉"
//   I-3(🟡P2/N-3) 回灌 pre2 的 U-7：ownPluginId 事件锚点缺失时按 packages[].name 前缀在
//                 inventory 反查兜底——refix_repair 第一道自修复闸不再静默失效
//   I-5(🟢P3/N-5) cancelled 与 failed 分账——用户取消的修复入审计（repairs）但不写入知识库
//                 失败计数，一次 ESC 不再永久关闭该症状的自动修复
//   I-7(🟢P3/N-7) 去重键/探针跳过键结构化（JSON 序列化键替代 '|' 拼接 + split 解析），
//                 probeSkipped 随 retract 清理
// 继承 V1.07 全部能力与安全边界（B1~B6）：P-1 全量基线推进、P-4 观察窗可取消、
//   P-5 per-key 探针配额、P-7 停止态不误报、V-13 回退锚点、N-5 同会话校验、双道自身闸。
const REFIX_VERSION = 'p3.7'

const CONTRACT = {
  dynamicCordisRunner: ['define', 'undefine', 'run', 'stop', 'invoke', 'inventory', 'snapshot', 'listPlugins', 'inspectPlugin', 'inspectPackage', 'reference'], // I-1：补 invoke——queueProbe 无条件调用，缺席时 F5 必须报警而非盲区
  cordisInspect: ['register', 'list', 'query'],
}
const CONTRACT_EVENTS = ['cordis/dynamic-package', 'cordis/dynamic-retract', 'cordis/request-run', 'cordis/request-run-resolved']
const PATROL_PERIOD_MS = 15000
const OBSERVE_MS_DEFAULT = 30000 // §3 F3：切换后 30s 观察窗
const OBSERVE_MS_MAX = 120000    // V-3：观察窗上限 2 分钟
const PROBE_TIMEOUT_MS = 2000    // V-1：单探针超时
const DRAIN_TIMEOUT_MS = 5000    // V-1：drain 兜底超时
const PROBE_RETRY_ROUNDS = 10    // 加固⑤：method-not-found 后间隔 N 轮巡检重试
const CAPS = { reports: 100, repairs: 100, knowledge: 100, keys: 1000 } // V-8/N-2/P-6
const PROBE_METHOD = 'health'
const SELF_PLUGIN_NAME = 'dsh-refix'
const SELF_REPAIR_TOOL_TIMEOUT = 300000
// V-2 第二层锚点（行为指纹）：宿主源码含本常量 = dsh-refix 自身。
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
    let ownPluginId = null
    const activeKeys = new Set()   // N-2：环形上限
    const probeSkipped = new Map() // P-5：skipKey -> 跳过时的 patrolCount（per-key 重试配额）
    const expectedRetracts = new Map() // V-5/N-1
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

    // I-3（U-7 回灌）：自身身份兜底反查。ownPluginId 仅靠 cordis/dynamic-package 事件锚定，
    // 该事件早于监听器注册时恒为 null，refix_repair 第一道自修复闸会静默失效。
    // 这里按 packages[].name 前缀在 inventory 反查；查不到返回 null（第二道源码指纹闸仍生效）。只读。
    function resolveSelfPluginId() {
      if (ownPluginId !== null) return ownPluginId
      try {
        for (const row of runner.inventory()) {
          const pkgs = Array.isArray(row.packages) ? row.packages : []
          for (const p of pkgs) {
            if (p && typeof p.name === 'string' && p.name.indexOf(SELF_PLUGIN_NAME) === 0) return row.pluginId
          }
        }
      } catch (e) { /* 反查失败按身份未知处理，与 V1.07 行为一致 */ }
      return null
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
    function addReport(kind, pluginId, evidence) {
      const meta = SYMPTOMS[kind] || SYMPTOMS.unknown
      // I-7：结构化去重键（JSON 序列化），字段含 '|' 时不再错位
      const key = JSON.stringify([kind, pluginId, evidence.pluginRunId || '', evidence.message || ''])
      if (activeKeys.has(key)) return null
      activeKeys.add(key)
      if (activeKeys.size > CAPS.keys) { // N-2：删最旧
        for (const oldest of activeKeys) { activeKeys.delete(oldest); break }
      }
      reportSeq += 1
      const entry = {
        id: 'refix-r' + reportSeq,
        seq: reportSeq,
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
      const skipKey = JSON.stringify([row.pluginId, row.activeRun.packageId]) // I-7：结构化键；V-6：按版本失效
      const skippedAt = probeSkipped.get(skipKey)
      // 加固⑤（P-5）：per-key 配额——距跳过已过 PROBE_RETRY_ROUNDS 轮才重试
      if (skippedAt !== undefined && patrolCount - skippedAt < PROBE_RETRY_ROUNDS) return
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
            probeSkipped.set(skipKey, patrolCount)
          } else if (r && r.ok === false && r.code === 'refix-timeout') {
            console.error('[refix] 探针超时 @ ' + probePid + '（' + PROBE_TIMEOUT_MS + 'ms，不计症状）')
          }
        }, function () { /* invoke 传输层失败不算症状，下轮再探 */ })
        probes.push(p)
      } catch (e) { /* 探针异常不阻断巡检 */ }
    }

    // V-1：给任意 promise 加超时护栏
    function withTimeout(p, ms) {
      return Promise.race([
        p,
        ctx.timeout(ms).then(function () { return { ok: false, code: 'refix-timeout' } }),
      ])
    }

    // P-4：观察窗等待可被取消中断
    function waitForAbort(signal) {
      if (!signal) return new Promise(function () {})
      if (signal.aborted) return ctx.timeout(0)
      return new Promise(function (resolve) {
        signal.addEventListener('abort', function () { resolve() }, { once: true })
      })
    }

    // ── F1 巡检（只读）───────────────────────────────────────────────
    // P-1：检测与基线推进永远全量（状态机不因过滤失盲）；过滤只作用于
    // 返回视图与探针目标（探针是跨端调用的主要成本，O-7 的省钱点保留）。
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
        fresh.push.apply(fresh, detectRowSymptoms(row, prev[row.pluginId])) // P-1：全量判定
        if (!onlyPid || row.pluginId === onlyPid) queueProbe(row, probes)
      }
      for (const key of Array.from(activeKeys)) {
        let k = null
        try { k = JSON.parse(key) } catch (e) { continue } // I-7：结构化键解析
        if (k && k[0] === 'run-missing' && rows.some(function (row) {
          return row.pluginId === k[1] && row.activeRun
        })) activeKeys.delete(key)
      }
      const view = onlyPid ? fresh.filter(function (s) { return s.pluginId === onlyPid }) : fresh
      if (fresh.length > 0) {
        console.error('[refix] 巡检(' + trigger + ') 新增症状 ' + fresh.length + ' 条'
          + (view.length !== fresh.length ? '（过滤视图返回 ' + view.length + ' 条）' : ''))
      }
      return { fresh: view, drain: Promise.all(probes).catch(function () {}) }
    }

    function patrolSafe(trigger, onlyPid) {
      patrol(trigger, onlyPid).catch(function (e) {
        console.error('[refix] 巡检异常: ' + ((e && e.message) || e))
      })
    }

    // ── F1 事件订阅 + 周期巡检 ───────────────────────────────────────
    ctx.effect(() => ctx.on('cordis/dynamic-package', function (pkg) {
      noteEvent('cordis/dynamic-package', pkg)
      if (pkg && typeof pkg.name === 'string' && pkg.name.indexOf(SELF_PLUGIN_NAME) === 0) {
        ownPluginId = pkg.pluginId
      }
      patrolSafe('event:dynamic-package')
    }), 'refix.ev-dynamic-package')
    ctx.effect(() => ctx.on('cordis/dynamic-retract', function (retracted) {
      noteEvent('cordis/dynamic-retract', retracted)
      const pid = retracted && retracted.pluginId
      const expected = expectedRetracts.get(pid) || 0
      patrolSafe('event:dynamic-retract')
      if (expected > 0) expectedRetracts.set(pid, expected - 1)
      // I-7：retract 后清理该插件的探针跳过配额（probeSkipped 不再只增不清）
      if (pid) {
        for (const sk of Array.from(probeSkipped.keys())) {
          let k = null
          try { k = JSON.parse(sk) } catch (e) { continue }
          if (k && k[0] === pid) probeSkipped.delete(sk)
        }
      }
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
          fallback: current === targetPackageId ? null : current, // V-13
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
      const windowStartSeq = reportSeq
      const agent = ctx.agents ? ctx.agents.get(row.agentId) : undefined
      if (agent === undefined) {
        return { outcome: 'refused', reason: 'owner-session-not-live', detail: '归属会话不在线，无法取得授权 Agent' }
      }
      const markStep = (action, detail) => { steps.push({ ts: Date.now(), action: action, detail: detail }) }
      const checkAborted = () => { if (signal && signal.aborted) throw new Error('tool call cancelled') }

      // O-2 + V-2 第二层（单次 inspectPackage）
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

      // N-1：仅当确有活跃 run 会产生 retract 时才登记
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
          expectRetract()
          const s = await runner.stop(agent, row.pluginId)
          markStep('stopped', s.ok ? 'ok' : (s.message || s.reason))
          r = await activate(plan.target, plan.mode, 'run-after-stop')
        } else {
          if (plan.mode === 'update') expectRetract()
          r = await activate(plan.target, plan.mode, 'run')
        }
        if (!r.ok) {
          markStep('activation-failed', r.message)
          return { outcome: 'failed', phase: 'activation', detail: r.message, steps: steps }
        }
        const newRunId = r.pluginRunId
        if (r.status === 'awaiting-approval' || r.status === 'starting') {
          markStep('awaiting-approval', '客户端半区已提交原生审批流')
          return {
            outcome: 'awaiting-approval', status: r.status,
            detail: '客户端半区修复需用户在页面批准/拒绝；批准后可再巡检确认', steps: steps,
            packageId: r.packageId, pluginRunId: r.pluginRunId,
          }
        }

        // 观察窗（P-4：取消可中断等待）
        markStep('observe', '观察窗 ' + observeMs + 'ms')
        await Promise.race([ctx.timeout(observeMs), waitForAbort(signal)])
        checkAborted()
        const round = await patrol('repair-observe')
        await Promise.race([round.drain, ctx.timeout(DRAIN_TIMEOUT_MS)])
        const newForTarget = reports.filter(function (rep) {
          return rep.seq > windowStartSeq
            && rep.pluginId === row.pluginId
            && rep.evidence.pluginRunId === newRunId
        })
        if (newForTarget.length === 0) {
          markStep('observed-clean', '观察窗内无新症状')
          return { outcome: 'success', steps: steps, detail: '修复后观察窗无症状' }
        }

        // 修了还坏 → 自动回退
        if (plan.fallback) {
          const backMode = deriveMode(plan.target, plan.fallback)
          const backStartSeq = reportSeq
          markStep('rollback', '修复无效，自动回退 run(' + plan.fallback + ', ' + backMode + ')')
          if (backMode === 'update') expectRetract()
          const back = await runner.run(agent, row.pluginId, plan.fallback, backMode)
          if (!back.ok) {
            markStep('rollback-failed', back.message)
            return { outcome: 'failed', phase: 'rollback', detail: '修复无效且回退失败: ' + back.message, steps: steps }
          }
          const backRunId = back.pluginRunId
          markStep('rolled-back', '已回退至 ' + plan.fallback)
          await Promise.race([ctx.timeout(observeMs), waitForAbort(signal)])
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
        expectedRetracts.delete(row.pluginId) // N-1 纵深
      }
    }

    // ── 修复工具 ─────────────────────────────────────────────────────
    ctx.tools.register(harness.defineTool({
      name: 'refix_repair',
      description: 'dsh-refix 修复执行（F3+F4）：对指定插件按策略表或历史方案执行版本切换修复。'
        + ' symptom 省略时取该插件最近一条诊断报告；同症状此前修复成功过 → 直接复用历史方案（跳过策略推导）；'
        + ' targetPackageId 显式指定候选修复版本（优先于知识库）；'
        + ' 客户端半区自动走 DSH 原生审批流（不等待结果）。观察窗默认 30000ms、上限 120000ms。'
        + ' 权限：仅可修复与调用者同会话的插件（跨会话拒绝）；不得对 dsh-refix 自身调用。'
        + ' 用户取消（cancelled）计入审计但不写入知识库失败计数（I-5 分账）。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '目标动态插件 ID（须与调用者同会话；不得为 dsh-refix 自身）' },
        symptom: { type: 'string', description: '要修复的症状 kind（省略=该插件最近一条报告）' },
        targetPackageId: { type: 'string', description: '候选修复版本 packageId（省略=策略表/历史方案）' },
        observeMs: { type: 'integer', description: '观察窗时长 ms，默认 30000，上限 120000' },
      },
      timeoutMs: SELF_REPAIR_TOOL_TIMEOUT,
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args, exec) {
        if (contractMissing.length > 0) {
          return JSON.stringify({ outcome: 'refused', reason: 'contract-incompatible', missing: contractMissing }, null, 2)
        }
        // I-3：第一道自修复闸——事件锚点缺失时经 inventory 反查兜底，不再静默失效
        const selfPid = resolveSelfPluginId()
        if (selfPid !== null && args.pluginId === selfPid) {
          return JSON.stringify({
            outcome: 'refused', reason: 'self-repair-forbidden',
            detail: '不得对 dsh-refix 自身执行修复：软重置会销毁自身 fiber，观察窗行为未定义。更新 dsh-refix 请用 cordis_define 追加新版本 + cordis_run 切换。',
          }, null, 2)
        }
        if (repairing) {
          return JSON.stringify({ outcome: 'refused', reason: 'repair-in-progress' }, null, 2)
        }
        // P-2：身份缺失的"留痕"落在实处
        if (!exec || !exec.agent) {
          console.error('[refix] refix_repair 调用缺少调用者身份（程序化直调？），跳过同会话校验 pluginId=' + args.pluginId)
        }
        repairing = true
        try {
          const row = liveRow(args.pluginId)
          if (row === undefined) {
            return JSON.stringify({ outcome: 'refused', reason: 'plugin-not-found', detail: 'inventory 中无此插件' }, null, 2)
          }
          // N-5：同会话校验
          if (exec && exec.agent && exec.agent.id !== row.agentId) {
            return JSON.stringify({
              outcome: 'refused', reason: 'cross-session',
              detail: '目标插件归属会话 ' + row.agentId + '，与调用者会话 ' + exec.agent.id + ' 不一致，拒绝修复',
            }, null, 2)
          }
          let symptom = args.symptom
          if (!symptom) {
            for (let i = reports.length - 1; i >= 0; i--) {
              if (reports[i].pluginId === args.pluginId) { symptom = reports[i].kind; break }
            }
          }
          const fingerprint = (symptom || 'unknown') + '|' + args.pluginId

          let plan = null
          let knowledgeHit = null
          if (!args.targetPackageId) {
            const prior = latestKnowledge(fingerprint)
            if (prior && prior.outcome === 'success') {
              knowledgeHit = { id: prior.id, action: prior.action, target: prior.target }
              prior.hits = (prior.hits || 0) + 1
              prior.attempts = (prior.attempts || 0) + 1
              const current = row.currentPackageId || null
              plan = {
                ok: true, action: prior.action, target: prior.target,
                fallback: current === prior.target ? null : current,
                mode: deriveMode(current, prior.target), fromKnowledge: prior.id,
              }
            } else if (prior && prior.outcome !== 'success') {
              return JSON.stringify({
                outcome: 'refused', reason: 'prior-fix-failed', symptom: symptom || 'none',
                detail: '命中历史方案 ' + prior.id + '，但其上次结果为 ' + prior.outcome + '，转人工处理',
                prior: { id: prior.id, action: prior.action, target: prior.target, outcome: prior.outcome, failures: prior.failures || 1 },
              }, null, 2)
            }
          }
          if (!plan) plan = derivePlan(symptom, row, args.targetPackageId)
          if (!plan.ok) {
            return JSON.stringify({
              outcome: 'refused', reason: plan.reason, symptom: symptom || 'none',
              detail: '未收录症状或需人工介入，不做任何修复动作', hint: plan.hint,
            }, null, 2)
          }

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
            const msg = (e && e.message) || String(e)
            // I-5：取消 ≠ 修复无效。checkAborted 抛出的取消按 cancelled 分账——
            // 入审计（repairs）但下方两个知识库分支都不命中，不污染失败学习。
            if (msg.indexOf('cancel') !== -1 || (exec && exec.signal && exec.signal.aborted)) {
              result = { outcome: 'cancelled', phase: 'cancelled', detail: '用户取消：修复中断，不计入失败学习', steps: [] }
            } else {
              result = { outcome: 'failed', phase: 'exception', detail: '修复执行异常: ' + msg, steps: [] }
            }
          }
          record.outcome = result.outcome
          record.result = result
          repairs.push(record)
          if (repairs.length > CAPS.repairs) repairs.shift()

          if (knowledgeHit) {
            const prior = latestKnowledge(fingerprint)
            if (prior && prior.id === knowledgeHit.id
              && (result.outcome === 'success' || result.outcome === 'failed')) { // N-4
              prior.outcome = result.outcome
              if (result.outcome === 'success') prior.successes = (prior.successes || 0) + 1
              else prior.failures = (prior.failures || 0) + 1
            }
          } else if (result.outcome === 'success' || result.outcome === 'failed') {
            knowledgeSeq += 1
            knowledge.push({
              id: 'refix-k' + knowledgeSeq, ts: Date.now(),
              fingerprint: fingerprint, symptom: record.symptom,
              action: plan.action, target: plan.target,
              outcome: result.outcome, fromRepair: record.id, hits: 0,
              attempts: 0, successes: result.outcome === 'success' ? 1 : 0, failures: result.outcome === 'failed' ? 1 : 0,
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
      timeoutMs: 15000,
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args, exec) { // P-3：响应取消；I-2：先检测后返回，report 不再吞 diff 证据
        if (exec && exec.signal && exec.signal.aborted) throw new Error('tool call cancelled')
        if (contractMissing.length === 0) {
          // N-2 修复：V1.07 这里直接 snapshotInventory() 推进基线——巡检间隙发生的
          // run-missing 会被一次 report 永久抹掉。改为走 patrol 检测路径：先对 prev
          // 做症状判定（报告同步入册），再推进基线，最后等探针 drain 让探针症状也落册。
          const round = await patrol('report')
          await Promise.race([round.drain, ctx.timeout(DRAIN_TIMEOUT_MS)])
        }
        const limit = typeof args.limit === 'number' && isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0
        return JSON.stringify(selfCheck(limit), null, 2)
      },
    }))
    ctx.tools.register(harness.defineTool({
      name: 'refix_patrol',
      description: '让 dsh-refix 立即执行一轮只读巡检（inventory diff + health 探针），返回本轮新识别的症状。同一症状持续期间不会重复报告。pluginId 可选：只返回该插件的症状（检测与基线仍全量推进，不漏其他插件状态）。',
      parameters: {
        pluginId: { type: 'string', description: '只返回该插件的症状（省略=全量）' },
      },
      timeoutMs: 30000,
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args, exec) { // P-3
        if (exec && exec.signal && exec.signal.aborted) throw new Error('tool call cancelled')
        const onlyPid = args && args.pluginId ? args.pluginId : null
        const round = await patrol(onlyPid ? 'manual:' + onlyPid : 'manual:refix_patrol', onlyPid)
        await Promise.race([round.drain, ctx.timeout(DRAIN_TIMEOUT_MS)])
        return JSON.stringify({ triggered: 'manual', onlyPid: onlyPid, newSymptoms: round.fresh, patrolCount: patrolCount }, null, 2)
      },
    }))

    console.log('dsh-refix ' + REFIX_VERSION + ' ready; contract '
      + (contractMissing.length === 0 ? 'OK (兼容性自检通过)' : 'MISSING: ' + contractMissing.join(', '))
      + '; baseline plugins: ' + Object.keys(lastSeen).length + '; patrol every ' + PATROL_PERIOD_MS + 'ms')
  },
}
