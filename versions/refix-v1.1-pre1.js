// 【定版 V1.1-pre1】前瞻版本（原开发代号 v8 / p3.5）⚠️ 含实验性改动，慎重选择升级安装
// dsh-refix v8（更新提示版 p3.5）— 自诊断·自修复·自迭代 + 自更新探测
// 在 v7（p3.4）之上新增 F6「更新探测 + 提示注入」（阶段 1：只提示，不执行换版）：
//   U-1  周期（默认 6h）从版本源拉 manifest，与 REFIX_VERSION 比对，识别到更新的
//        版本后置 pendingUpdateNotice；下一次 agent/pre-step 注入一条来源标注为
//        plugin:dsh-refix 的 user 消息（范式 = 宿主 time-context 插件）。
//        注入后即消费（一次性），同一版本不重复提示（notifiedVersions + 上限）。
//   U-2  版本源经 ctx.get('web').fetch（沙箱官方通道）拉取，不 import/require。
//        web 服务不存在/非 200/非 JSON 一律降级为"探测失败"留档，绝不抛错、
//        绝不影响巡检与修复路径。
//   U-3  不用 inject:['web'] —— 未声明服务经 ctx.get 可选查询（guard.ts L745
//        `get = readService(name,false)`），避免某个 profile 缺 web 时 cordis 把
//        dsh-refix 整个 park（功能全损，风险远大于收益）。
//   U-4  探测节流：成功 6h / 失败 30min；selfCheck().update 暴露全部探测状态，
//        refix_report 即可查看（不新增工具）。
//   U-5  阶段边界（明确声明）：本版不做自动换版。换版仍须宿主 cordis_define +
//        cordis_run(pluginId, packageId, 'update')，且 dsh-refix 不能自升级
//        （self-repair-forbidden）。提示文本只告知人工升级路径。
// 以下为 v7 在 v6 之上按第三轮复检修复的条目（保持）：
//   P-1  过滤巡检消费他插件基线 → 检测全量推进（基线一致）、返回值过滤、探针仅打目标
//   P-2  身份缺失"放行并留痕"落在实处：console.error 留痕
//   P-3  refix_report/refix_patrol 入口响应 exec.signal（宿主契约要求转发取消）
//   P-4  观察窗等待可被取消中断（race abort），不再等满 2×observeMs
//   P-5  probeSkipped 重试配额改 per-key（存跳过时的 patrolCount，距今 ≥10 轮才重试）
//   P-6  CAPS.keys 400→1000（ponytail: 极端症状风暴下仍可逐出活跃键，上限换简单）
//   P-7  修复激活失败后插件处于停止态、基线无 run → 不再产生 run-missing（V-9 同类盲区）→ README 声明
//   更正  审批机制表述：requiresApproval 时 run() 在 startHost 前返回（L301），
//         plugin.run 未建立；通道 A = runHostHalf(requestId)（批准），
//         通道 B = resolveRequestRun(ok:true)（client-pending attach 回执，宿主 L420 闸门 = runId 匹配）
const REFIX_VERSION = 'p3.5'

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
const PROBE_RETRY_ROUNDS = 10    // 加固⑤：method-not-found 后间隔 N 轮巡检重试
const CAPS = { reports: 100, repairs: 100, knowledge: 100, keys: 1000, updateNotices: 50 } // V-8/N-2/P-6/U-1
const PROBE_METHOD = 'health'
const SELF_PLUGIN_NAME = 'dsh-refix'
const SELF_REPAIR_TOOL_TIMEOUT = 300000
// V-2 第二层锚点（行为指纹）：宿主源码含本常量 = dsh-refix 自身。
const REFIX_FINGERPRINT = 'refix-self-fingerprint-a7f3'

// ── F6 更新探测常量（阶段 1：只提示，不执行换版）─────────────────────
const UPDATE_CHECK_ENABLED = true
// 版本源：GitHub raw 上的发布清单。格式 {"latest":"p3.5","notes":"…","url":"…"}，
// 其中 latest 必须与 REFIX_VERSION 同方案（pX.Y），否则比对不成立（不提示）。
const UPDATE_SOURCE_URL = 'https://raw.githubusercontent.com/ckk-09/dsh-refix/main/versions/manifest.json'
const UPDATE_CHECK_PERIOD_MS = 6 * 60 * 60 * 1000  // 探测成功后的节流窗
const UPDATE_RETRY_PERIOD_MS = 30 * 60 * 1000      // 探测失败后的重试窗（快于成功窗）
const UPDATE_NOTICE_TEXT_MAX = 400                  // U-1：manifest notes 截断上限

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
    // ── F6 更新探测状态（内存态，随插件卸载销毁）────────────────────
    let updateCheckCount = 0
    let updateChecking = false            // 防重入：一次只跑一个探测
    let latestSeen = null                 // 版本源最近一次报出的 latest（不论是否更新）
    let lastUpdateCheck = null            // { ts, ok, reason, http }
    let pendingUpdateNotice = null        // 探测到更新且未提示 → 下个 pre-step 消费
    const notifiedVersions = new Set()    // 已提示过的目标版本（防重复刷屏）

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
        update: updateState(),
      }
    }

    // ── F6 更新探测状态视图（只读）──────────────────────────────────
    function updateState() {
      return {
        enabled: UPDATE_CHECK_ENABLED,
        source: UPDATE_SOURCE_URL,
        current: REFIX_VERSION,
        checkCount: updateCheckCount,
        latestSeen: latestSeen,
        lastCheck: lastUpdateCheck,
        pendingNotice: pendingUpdateNotice,
        notified: Array.from(notifiedVersions),
        executable: false, // U-5：本版不含换版执行；提示只告知人工升级路径
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
      const skipKey = row.pluginId + '|' + row.activeRun.packageId // V-6：按版本失效
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
        const parts = key.split('|')
        if (parts[0] === 'run-missing' && rows.some(function (row) {
          return row.pluginId === parts[1] && row.activeRun
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
    }), 'refix.ev-dynamic-retract')
    // 15s 周期巡检的 interval 在 F6 段之后统一注册（同 tick 兼作更新探测节流调度）。

    if (contractMissing.length === 0) snapshotInventory()

    // ── F6 更新探测（阶段 1：只提示，不执行换版）─────────────────────
    /**
     * 版本号 → 数字段数组。'p3.5' → [3,5]；'v8' → [8]；无数字 → null。
     * 分段数值比较（非字典序），故 p3.10 > p3.9 成立。
     */
    function versionTuple(v) {
      const raw = String(v === null || v === undefined ? '' : v)
        .split(/[^0-9]+/)
        .filter(function (s) { return s.length > 0 })
      if (raw.length === 0) return null
      const out = []
      for (const s of raw) {
        const n = Number(s)
        if (!isFinite(n)) return null
        out.push(n)
      }
      return out
    }

    /** candidate 是否比 current 新（短段补 0；任一侧不可解析 → false = 不提示）。 */
    function isNewerVersion(candidate, current) {
      const a = versionTuple(candidate)
      const b = versionTuple(current)
      if (a === null || b === null) return false
      const n = Math.max(a.length, b.length)
      for (let i = 0; i < n; i++) {
        const x = a[i] === undefined ? 0 : a[i]
        const y = b[i] === undefined ? 0 : b[i]
        if (x > y) return true
        if (x < y) return false
      }
      return false
    }

    /**
     * 经沙箱官方 web 通道拉版本源。永不抛错：任何异常都降级为 { ok:false, reason }。
     * U-3：ctx.get 为未声明服务的可选查询，web 缺席不影响插件其余功能。
     */
    async function fetchManifest() {
      let web
      try { web = ctx.get('web') } catch (e) { return { ok: false, reason: 'web-lookup-failed' } }
      if (!web || typeof web.fetch !== 'function') return { ok: false, reason: 'web-service-absent' }
      let res
      try {
        res = await web.fetch({ url: UPDATE_SOURCE_URL })
      } catch (e) {
        return { ok: false, reason: 'fetch-threw:' + ((e && e.message) || e) }
      }
      if (!res || typeof res.statusCode !== 'number') return { ok: false, reason: 'bad-result' }
      if (res.statusCode !== 200) return { ok: false, reason: 'http-' + res.statusCode, http: res.statusCode }
      const body = res.body
      if (!body || (body.kind !== 'text' && body.kind !== 'html') || typeof body.content !== 'string') {
        return { ok: false, reason: 'unsupported-body' }
      }
      let data
      try { data = JSON.parse(body.content) } catch (e) { return { ok: false, reason: 'bad-json' } }
      if (!data || typeof data !== 'object') return { ok: false, reason: 'bad-manifest' }
      return { ok: true, data: data }
    }

    /** 探测一次并把结果折算成 pendingUpdateNotice（若发现更新）。不写成抛错路径。 */
    async function checkForUpdate() {
      if (!UPDATE_CHECK_ENABLED || updateChecking) return
      updateChecking = true
      try {
        const r = await fetchManifest()
        updateCheckCount += 1
        lastUpdateCheck = { ts: Date.now(), ok: r.ok, reason: r.ok ? null : r.reason }
        if (!r.ok) {
          console.error('[refix] 更新探测未完成（' + r.reason + '），' + Math.round(UPDATE_RETRY_PERIOD_MS / 60000) + ' 分钟后重试')
          return
        }
        const latest = typeof r.data.latest === 'string' && r.data.latest.length > 0 ? r.data.latest : null
        if (latest === null) {
          lastUpdateCheck = { ts: Date.now(), ok: false, reason: 'manifest-missing-latest' }
          return
        }
        latestSeen = latest
        if (!isNewerVersion(latest, REFIX_VERSION)) return
        if (notifiedVersions.has(latest)) return // U-1：同版本只提示一次
        notifiedVersions.add(latest)
        if (notifiedVersions.size > CAPS.updateNotices) {
          for (const oldest of notifiedVersions) { notifiedVersions.delete(oldest); break }
        }
        pendingUpdateNotice = {
          latest: latest,
          current: REFIX_VERSION,
          notes: typeof r.data.notes === 'string' ? r.data.notes.slice(0, UPDATE_NOTICE_TEXT_MAX) : null,
          url: typeof r.data.url === 'string' ? r.data.url : null,
          detectedAt: Date.now(),
        }
        console.log('[refix] 探测到新版本 ' + latest + '（当前 ' + REFIX_VERSION
          + '），将在下一次对话步骤注入更新提示（本版不自动换版）')
      } catch (e) {
        lastUpdateCheck = { ts: Date.now(), ok: false, reason: 'exception:' + ((e && e.message) || e) }
        console.error('[refix] 更新探测异常: ' + ((e && e.message) || e))
      } finally {
        updateChecking = false
      }
    }

    /** 节流调度（U-4）：成功 6h / 失败 30min。 */
    function scheduleUpdateCheck() {
      if (!UPDATE_CHECK_ENABLED) return
      if (lastUpdateCheck && lastUpdateCheck.ok) {
        if (Date.now() - lastUpdateCheck.ts < UPDATE_CHECK_PERIOD_MS) return
      } else if (lastUpdateCheck) {
        if (Date.now() - lastUpdateCheck.ts < UPDATE_RETRY_PERIOD_MS) return
      }
      checkForUpdate().catch(function (e) {
        console.error('[refix] checkForUpdate 未捕获异常: ' + ((e && e.message) || e))
      })
    }

    /**
     * 构造注入消息。字段集对齐宿主 createUserMessage（llm/message.ts L204：
     * createMessage + role:'user' + 随机 id）；沙箱内取不到该工厂，这里按其
     * 字段集手工构造，source 标注 plugin:dsh-refix 以便与真实用户输入区分
     * （宿主 time-context 即此范式，其 projection 亦按该 source 识别本插件注入）。
     */
    function buildNoticeMessage(notice) {
      const lines = [
        '[dsh-refix] 检测到新版本 ' + notice.latest + '（当前运行 ' + notice.current + '）。'
          + '这是信息提示，无需立即动作。',
        '版本源：' + UPDATE_SOURCE_URL,
      ]
      if (notice.notes) lines.push('发布说明：' + notice.notes)
      if (notice.url) lines.push('详情：' + notice.url)
      lines.push('升级路径（需人工确认后执行）：在新会话中让模型用 cordis_define 定义 dsh-refix 新版本包，'
        + "再以 cordis_run(pluginId, packageId, 'update') 切换；"
        + 'dsh-refix 不能自升级（self-repair-forbidden）。')
      lines.push('探测状态见 refix_report 的 update 段（executable=false 表示本版不含自动换版）。')
      const text = lines.join('\n')
      return {
        role: 'user',
        id: 'refix-upd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
        content: [{ type: 'text', text: text }],
        source: {
          kind: 'plugin',
          plugin: SELF_PLUGIN_NAME,
          form: 'snapshot',
          sections: [{ name: SELF_PLUGIN_NAME, text: text }],
        },
      }
    }

    // 注入点：宿主 agent/pre-step（waterfall，runtime-types.ts L330 契约：
    // { agent, messages, turn, step, signal } → PreStepDecision）。
    // 只在确有待提示更新时改 decision；其余情况原样透传，且自身异常绝不上抛
    // （上抛会破坏该步骤，代价远大于一条提示）。
    ctx.effect(() => ctx.on('agent/pre-step', async function (payload, next) {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject') return decision
        if (!pendingUpdateNotice) return decision
        if (payload && payload.signal && payload.signal.aborted) return decision
        const notice = pendingUpdateNotice
        pendingUpdateNotice = null // U-1：一次性消费
        return Object.assign({}, decision, {
          messages: (decision.messages || []).concat([buildNoticeMessage(notice)]),
        })
      } catch (e) {
        console.error('[refix] 更新提示注入失败: ' + ((e && e.message) || e))
        return decision
      }
    }), 'refix.ev-pre-step')

    // 15s 周期巡检与更新探测节流调度共用同一 tick（探测本身按 6h/30min 节流）。
    ctx.interval(function () {
      patrolSafe('interval:' + PATROL_PERIOD_MS + 'ms')
      scheduleUpdateCheck()
    }, PATROL_PERIOD_MS)

    // 启动即探测一次，使首轮对话就能拿到提示（首个 tick 需等 15s）。
    scheduleUpdateCheck()

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
        + ' 权限：仅可修复与调用者同会话的插件（跨会话拒绝）；不得对 dsh-refix 自身调用。',
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
        if (ownPluginId !== null && args.pluginId === ownPluginId) {
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
            result = { outcome: 'failed', phase: 'exception', detail: '修复执行异常: ' + ((e && e.message) || e), steps: [] }
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
      async execute(args, exec) { // P-3：响应取消
        if (exec && exec.signal && exec.signal.aborted) throw new Error('tool call cancelled')
        if (contractMissing.length === 0) snapshotInventory()
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
      + '; baseline plugins: ' + Object.keys(lastSeen).length + '; patrol every ' + PATROL_PERIOD_MS + 'ms'
      + '; update-check ' + (UPDATE_CHECK_ENABLED ? 'on (' + UPDATE_SOURCE_URL + ')' : 'off')
      + ' [notify-only, no auto-upgrade]')
  },
}
