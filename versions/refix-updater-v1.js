// dsh-refix-updater v1（F6 阶段 3 · peer updater，宿主强制门 + 一次性令牌）
//
// 定位：dsh-refix 在会话内的**同会话 peer 插件**，唯一职责 = 在**用户显式批准**后，
// 把版本源上的新版本源码装入运行态；观察窗内失败则自动回滚。
//
// 为什么必须独立成插件（C-1）：换版执行者是 run(pluginId, newPackageId, 'update')，
// 它对目标插件会 retract（销毁目标 fiber）。若 dsh-refix 对自己调用，await 之后的
// 观察窗 / 回滚代码正跑在已被销毁的 fiber 上 → 行为未定义。执行者与目标必须是
// 不同 pluginId（不同 fiber），updater 才能在切 dsh-refix 时存活并跑完回滚。
//
// 阶段 3 边界（A-1′）：
//   A-1 宿主强制门：本插件注册 ctx.on('tools/pre-execute')，对自己的 updater_apply
//       返回 { kind:'ask', reason } → 宿主 core/tools 的 ApprovalService
//       （core/tools/src/index.ts L1469-1471、L1679-1719）→ 只有用户点"允许一次"
//       （allowed-once）才放行；rejected / cancelled / **unavailable（无接听方）**
//       一律 deny（fail closed，原文 "Missing answerers fail closed"）。
//       门在宿主的工具派发路径里，模型绕不过。
//   A-2 一次性令牌：updater_apply 必须带 confirm = 票据 sha256 的前 12 位。
//       钩子与工具体都校验 → 令牌不匹配直接 deny（连批准框都不弹）。
//       用途：把"批准时看到的字节"与"实际执行的字节"钉死，防 check→apply 之间换票。
//   A-3 单次授权：宿主只有 allowed-once 一个放行值（core/tools L1704），
//       **没有**"以后都允许"的口子。本插件也不提供任何 --yes / 记住批准 的持久态。
//   A-4 上游边界（宿主硬事实，不承诺）：run() 只有 clientCode !== undefined 的包
//       才走原生包级审批（cordis-host-runner/src/index.ts L270-279）。dsh-refix 是
//       host-only → 装新版本**不会**弹原生面板。本插件的批准门在**工具层**，
//       不是包层；这是 dsh-refix 保持 host-only 形态下的唯一可用强制门。
//   A-5 沙箱无 crypto / require / fetch / process / Buffer（sandbox.ts L96-145）
//       → sha256 必须纯 JS 实现（见下）；网络只走 ctx.get('web').fetch。
//   A-6 默认关闭：UPDATER_ENABLED = false。关闭时只注册 updater_report（纯只读），
//       不注册 updater_check / updater_apply，**也不注册 tools/pre-execute 钩子**
//       —— 零全局足迹。启用需显式改常量后重新 define 一个包（一次性人工动作）。
//   A-7 自身禁令：updater 不得升级自己（与 dsh-refix 的 self-repair-forbidden 同源）。
//   A-8 票据一次性 + TTL 10 分钟 + 同目标同时只允许一个票据（新 check 作废旧票）。
//   A-9 清单与源码同源（同一 GitHub 仓库）→ 哈希绑定只能保证"批准的就是将执行的"，
//       **不能**保证代码本身可信。无签名基础设施（见 §6 信任模型，README 已声明）。
//   A-10 源码入包前的四道前置校验（全部在 define 之前，失败即 refused，不落任何状态）：
//        ① 源码含 dsh-refix 行为指纹（REFIX_FINGERPRINT）——否则不是目标插件；
//        ② 源码**不含**本 updater 指纹——防把 updater 自己装进 dsh-refix；
//        ③ manifest.latest === 源码内自报的 REFIX_VERSION（清单不能单方面抬版本号）；
//        ④ 源码长度 ≤ SRC_MAX_BYTES 且为合法 JS 标识（非空、含 return）。
//   A-11 全局钩子的爆炸半径：宿主侧动态包挂在 rootCtx 下的 cordis-dynamic 组
//        （cordis-host-runner/src/index.ts L1238），因此本钩子是**全局**的，会经过
//        每一个 agent 的每一次工具调用。故钩子体：非 updater_apply 一律 `next()`
//        直通；任何异常都只对本工具 fail-closed，绝不外溢成别人的工具报错。
//
// 阶段 3 明确不做：不无人值守（每次都要令牌 + 点批准）；不做批量升级；不引入
// "信任本仓库"持久态；不做 Ed25519 清单签名（沙箱无 crypto，且需仓库外的密钥分发
// 路径 —— 预留扩展位，见 PLACEHOLDER_VERIFY_MANIFEST）。
const UPDATER_VERSION = 'u1'
// A-10②：本插件的行为指纹。被装进 dsh-refix 的源码绝不该含它。
const UPDATER_FINGERPRINT = 'refix-updater-fingerprint-b4e1'
// A-6：默认关闭。改 true 后重新 define 一个 updater 包即启用（一次性人工动作）。
const UPDATER_ENABLED = false

const SELF_PLUGIN_NAME = 'dsh-refix-updater'
const TARGET_PLUGIN_NAME = 'dsh-refix'
// dsh-refix 源码里的行为指纹常量（v7 起存在）。用于 A-10① 否认"这不是 dsh-refix"。
const REFIX_FINGERPRINT = 'refix-self-fingerprint-a7f3'
// 版本源固定在仓库 raw 上；**不提供 URL 覆盖参数**（收紧面：源码来源是常量）。
const REPO_RAW_BASE = 'https://raw.githubusercontent.com/ckk-09/dsh-refix/main/'
const MANIFEST_PATH = 'versions/manifest.json'
const MANIFEST_URL = REPO_RAW_BASE + MANIFEST_PATH
// A-10④：清单里的 file 必须是仓库内的 versions/*.js 相对路径。
// 严格白名单式收口 —— 否则被篡改的清单可把 file 指向任意路径/协议。
const SAFE_FILE_RE = /^versions\/[A-Za-z0-9._-]{1,80}\.js$/
const SRC_MAX_BYTES = 1000000

const TICKET_TTL_MS = 10 * 60 * 1000
const TOKEN_LEN = 12
const OBSERVE_MS_DEFAULT = 30000
const OBSERVE_MS_MAX = 120000
const DRAIN_MS = 3000
const APPLY_TIMEOUT_MS = 300000
const CAPS = { tickets: 20, executions: 50, reasons: 60 }
// A-9 预留扩展位：阶段 3 不做验签。将来若引入 Ed25519 清单签名，验签函数挂这里，
// 并在 updater_check 的 ③ 步之后调用。当前恒 true，并在输出里显式声明 unsigned。
const PLACEHOLDER_VERIFY_MANIFEST = function (_manifestText, _manifestUrl) { return { ok: true, mode: 'unsigned', detail: 'no signature infrastructure in stage 3' } }

// ── 纯 JS SHA-256（A-5：沙箱无 crypto / Buffer）─────────────────────────
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Hex(text) {
  const msg = new TextEncoder().encode(text)
  const len = msg.length
  const total = Math.ceil((len + 9) / 64) * 64
  const buf = new Uint8Array(total)
  buf.set(msg, 0)
  buf[len] = 0x80
  const bits = len * 8
  const hi = Math.floor(bits / 4294967296)
  const lo = bits >>> 0
  buf[total - 8] = (hi >>> 24) & 0xff
  buf[total - 7] = (hi >>> 16) & 0xff
  buf[total - 6] = (hi >>> 8) & 0xff
  buf[total - 5] = hi & 0xff
  buf[total - 4] = (lo >>> 24) & 0xff
  buf[total - 3] = (lo >>> 16) & 0xff
  buf[total - 2] = (lo >>> 8) & 0xff
  buf[total - 1] = lo & 0xff
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) {
      const i = off + t * 4
      w[t] = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]
      const y = w[t - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)))
        + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) >>> 0
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)))
        + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  const words = [h0, h1, h2, h3, h4, h5, h6, h7]
  let hex = ''
  for (let i = 0; i < words.length; i++) hex += ('00000000' + words[i].toString(16)).slice(-8)
  return hex
}

return {
  name: 'dsh-refix-updater',
  // 只声明真正需要的：runner(define/run/snapshot/inspectPackage/inventory)、
  // agents(取 Agent 交给 run)、timer(ctx.timeout 观察窗)。web 走 ctx.get 可选查询。
  inject: ['dynamicCordisRunner', 'agents', 'timer'],
  apply(ctx, config) {
    const runner = ctx.dynamicCordisRunner
    const cfg = config && typeof config === 'object' ? config : {}
    const ENABLED = cfg.enabled === true ? true : UPDATER_ENABLED

    // ── 内存态（随插件卸载销毁）────────────────────────────────────
    const tickets = new Map()      // ticketId -> ticket
    const executions = []          // 执行记录（环形上限）
    let ticketSeq = 0
    let selfPluginId = null        // 本 updater 自己的 pluginId（A-7 自身禁令用）
    let inFlight = false           // 同进程同时只允许一次 apply
    let lastRetract = null         // 最近一次 cordis/dynamic-retract（观察窗判据）
    let lastResult = null

    const contractMissing = probeContract()

    function probeContract() {
      const missing = []
      for (const m of ['define', 'run', 'snapshot', 'inventory', 'inspectPackage']) {
        if (typeof runner[m] !== 'function') missing.push('dynamicCordisRunner.' + m + ':missing')
      }
      for (const ev of ['tools/pre-execute', 'cordis/dynamic-retract', 'cordis/dynamic-package']) {
        try {
          const dispose = ctx.on(ev, function () {})
          dispose()
        } catch (e) {
          missing.push('event:' + ev + ':' + ((e && e.message) || 'register-failed'))
        }
      }
      return missing
    }

    // ── 身份与目标解析 ──────────────────────────────────────────────
    // 包名规则：dsh-refix 自身 = `dsh-refix` 或以 `dsh-refix ` 开头（define 时用
    // 'dsh-refix <version>' 命名，保持 dsh-refix 的 packages[].name 前缀自认）；
    // 本 updater = `dsh-refix-updater` 前缀。两条规则互斥，避免把对方认成自己。
    function isOwnPackageName(name) {
      return typeof name === 'string' && name.indexOf(SELF_PLUGIN_NAME) === 0
    }
    function isTargetPackageName(name) {
      return name === TARGET_PLUGIN_NAME || (typeof name === 'string' && name.indexOf(TARGET_PLUGIN_NAME + ' ') === 0)
    }
    function resolveSelf() {
      if (selfPluginId !== null) return selfPluginId
      try {
        for (const row of runner.inventory()) {
          for (const p of (row.packages || [])) {
            if (isOwnPackageName(p && p.name)) { selfPluginId = row.pluginId; return selfPluginId }
          }
        }
      } catch (e) { /* 只影响自身禁令的兜底，不阻断主流程 */ }
      return null
    }
    /** 按 packages[].name 找 dsh-refix 行；显式 pluginId 优先。 */
    function resolveTargetRow(explicitPluginId) {
      let rows = []
      try { rows = runner.inventory() } catch (e) { return { ok: false, reason: 'inventory-failed' } }
      if (explicitPluginId) {
        for (const row of rows) if (row.pluginId === explicitPluginId) return { ok: true, row: row }
        return { ok: false, reason: 'plugin-not-found' }
      }
      for (const row of rows) {
        for (const p of (row.packages || [])) {
          if (isTargetPackageName(p && p.name)) return { ok: true, row: row }
        }
      }
      return { ok: false, reason: 'target-not-found' }
    }
    /** 从已装源码里读自报版本（**这是"当前版本"的唯一可信来源**，不依赖清单）。 */
    function readVersionFromSource(src) {
      const m = /REFIX_VERSION\s*=\s*'([^']{1,40})'/.exec(src)
      return m ? m[1] : null
    }

    // ── 网络（ctx.get('web') 可选查询，与 dsh-refix 同范式）──────────
    async function fetchText(url) {
      let web
      try { web = ctx.get('web') } catch (e) { return { ok: false, reason: 'web-lookup-failed' } }
      if (!web || typeof web.fetch !== 'function') return { ok: false, reason: 'web-service-absent' }
      let res
      try {
        res = await web.fetch({ url: url })
      } catch (e) {
        return { ok: false, reason: 'fetch-threw:' + ((e && e.message) || e) }
      }
      if (!res || typeof res.statusCode !== 'number') return { ok: false, reason: 'bad-result' }
      if (res.statusCode !== 200) return { ok: false, reason: 'http-' + res.statusCode, http: res.statusCode }
      const body = res.body
      if (!body || (body.kind !== 'text' && body.kind !== 'html') || typeof body.content !== 'string') {
        return { ok: false, reason: 'unsupported-body' }
      }
      return { ok: true, text: body.content }
    }

    // ── 检查（只读：拉清单+源码、算哈希、出票据；不 define、不改运行态）──
    async function doCheck(targetPluginId, exec) {
      if (contractMissing.length > 0) return { outcome: 'refused', reason: 'contract-incompatible', missing: contractMissing }
      const tr = resolveTargetRow(targetPluginId)
      if (!tr.ok) return { outcome: 'refused', reason: tr.reason, detail: '找不到 dsh-refix 插件行（须与本 updater 同会话）' }
      const row = tr.row
      const self = resolveSelf()
      if (self !== null && row.pluginId === self) {
        return { outcome: 'refused', reason: 'self-upgrade-forbidden', detail: '解析到的目标是本 updater 自身。' }
      }
      const beforePackageId = row.currentPackageId ? String(row.currentPackageId) : null
      if (beforePackageId === null) {
        return { outcome: 'refused', reason: 'no-current-package', detail: 'dsh-refix 尚无成功激活的包，无法形成回滚点。' }
      }
      const agent = agentFromExec(exec) || agentOfRow(row)
      if (agent === null) {
        return { outcome: 'refused', reason: 'owner-session-not-live', detail: '归属会话不在线，无法读取当前包源码（inspectPackage 需要授权 Agent）。' }
      }
      let currentVersion = null
      try {
        const pkg = runner.inspectPackage(agent, row.pluginId, beforePackageId)
        const hostSrc = (pkg && pkg.code && pkg.code.host) || ''
        currentVersion = readVersionFromSource(hostSrc)
      } catch (e) {
        return { outcome: 'refused', reason: 'current-source-unreadable', detail: (e && e.message) || 'inspectPackage failed' }
      }
      if (currentVersion === null) {
        return { outcome: 'refused', reason: 'current-version-unknown', detail: '当前包源码里没有 REFIX_VERSION 自报。' }
      }

      const mf = await fetchText(MANIFEST_URL)
      if (!mf.ok) return { outcome: 'refused', reason: 'manifest-failed:' + mf.reason, url: MANIFEST_URL }
      let manifest
      try { manifest = JSON.parse(mf.text) } catch (e) { return { outcome: 'refused', reason: 'manifest-bad-json' } }
      if (!manifest || typeof manifest !== 'object') return { outcome: 'refused', reason: 'manifest-bad-shape' }
      const latest = typeof manifest.latest === 'string' && manifest.latest.length > 0 ? manifest.latest : null
      const file = typeof manifest.file === 'string' ? manifest.file : null
      if (latest === null) return { outcome: 'refused', reason: 'manifest-missing-latest' }
      if (file === null || !SAFE_FILE_RE.test(file)) {
        return { outcome: 'refused', reason: 'manifest-unsafe-file', detail: '清单 file 不是仓库内 versions/*.js 相对路径（已拒绝，防清单指向任意来源）', file: file }
      }
      if (!isNewerVersion(latest, currentVersion)) {
        return { outcome: 'no-update', current: currentVersion, latest: latest, url: REPO_RAW_BASE + file }
      }

      const verdict = PLACEHOLDER_VERIFY_MANIFEST(mf.text, MANIFEST_URL)
      if (!verdict.ok) return { outcome: 'refused', reason: 'manifest-signature-invalid' }

      const sourceUrl = REPO_RAW_BASE + file
      const sf = await fetchText(sourceUrl)
      if (!sf.ok) return { outcome: 'refused', reason: 'source-failed:' + sf.reason, url: sourceUrl }
      const src = sf.text
      if (src.length === 0) return { outcome: 'refused', reason: 'source-empty' }
      if (src.length > SRC_MAX_BYTES) {
        return { outcome: 'refused', reason: 'source-too-large', bytes: src.length, limit: SRC_MAX_BYTES }
      }
      // A-10 四道前置校验
      if (src.indexOf(REFIX_FINGERPRINT) === -1) {
        return { outcome: 'refused', reason: 'not-target-plugin', detail: '源码不含 dsh-refix 行为指纹 → 拒绝。（缩略哈希 ' + sha256Hex(src).slice(0, TOKEN_LEN) + '）' }
      }
      if (src.indexOf(UPDATER_FINGERPRINT) !== -1) {
        return { outcome: 'refused', reason: 'updater-code-rejected', detail: '源码含本 updater 指纹 → 拒绝把 updater 装进 dsh-refix。' }
      }
      const srcVersion = readVersionFromSource(src)
      if (srcVersion === null) return { outcome: 'refused', reason: 'source-version-missing' }
      if (srcVersion !== latest) {
        return { outcome: 'refused', reason: 'version-mismatch', detail: '清单 latest=' + latest + ' 与源码自报=' + srcVersion + ' 不一致 → 拒绝（清单不能单方面抬版本号）' }
      }
      if (src.indexOf('return {') === -1) return { outcome: 'refused', reason: 'source-not-a-plugin' }

      const sha256 = sha256Hex(src)
      const token = sha256.slice(0, TOKEN_LEN)
      const ticketId = 't' + (++ticketSeq)
      const now = Date.now()
      const ticket = {
        ticketId: ticketId,
        targetPluginId: String(row.pluginId),
        agentId: String(row.agentId),
        beforePackageId: beforePackageId,
        currentVersion: currentVersion,
        targetVersion: srcVersion,
        file: file,
        sourceUrl: sourceUrl,
        sha256: sha256,
        token: token,
        bytes: src.length,
        lines: src.split('\n').length,
        head: src.split('\n')[0].slice(0, 120),
        unsigned: verdict.mode === 'unsigned',
        createdAt: now,
        expiresAt: now + TICKET_TTL_MS,
        consumed: false,
        source: src, // 私有：批准后直接装这份字节（不再回网络），保证"批准的就是执行的"
      }
      // A-8：同目标新票作废旧票
      for (const old of tickets.values()) {
        if (old.targetPluginId === ticket.targetPluginId && !old.consumed) old.consumed = true
      }
      tickets.set(ticketId, ticket)
      trimTickets()

      return {
        outcome: 'ticket-issued',
        ticketId: ticketId,
        target: {
          pluginId: ticket.targetPluginId,
          name: TARGET_PLUGIN_NAME,
          currentVersion: ticket.currentVersion,
          currentPackageId: ticket.beforePackageId,
        },
        candidate: {
          version: ticket.targetVersion,
          file: ticket.file,
          url: ticket.sourceUrl,
          sha256: ticket.sha256,
          bytes: ticket.bytes,
          lines: ticket.lines,
          head: ticket.head,
        },
        manifest: { url: MANIFEST_URL, latest: latest, unsigned: ticket.unsigned },
        approval: {
          token: token,
          tokenLength: TOKEN_LEN,
          ttlMs: TICKET_TTL_MS,
          expiresAt: ticket.expiresAt,
          gate: 'host-approval (tools/pre-execute -> {kind:ask}) + one-shot token; allowed-once only',
        },
        next: '调用 updater_apply({ticketId:"' + ticketId + '", confirm:"' + token + '"})。宿主会弹出批准框；只有用户点"允许一次"才会执行，无接听方（无 UI/headless）一律拒绝。',
        rollback: 'cordis_run({pluginId:"' + ticket.targetPluginId + '", packageId:"' + ticket.beforePackageId + '", mode:"update"})',
        disclaimer: '哈希绑定只保证"批准的就是将执行的"；清单与源码同源（同一仓库），代码本身是否可信不需本机制背书。本功能等价于允许远程代码执行。',
      }
    }

    function isNewerVersion(candidate, baseline) {
      const p = parseVersion(candidate)
      const q = parseVersion(baseline)
      if (p === null || q === null) return false
      for (let i = 0; i < p.length; i++) {
        const x = p[i] === undefined ? 0 : p[i]
        const y = q[i] === undefined ? 0 : q[i]
        if (x > y) return true
        if (x < y) return false
      }
      return false
    }
    function parseVersion(v) {
      if (typeof v !== 'string') return null
      const m = /^p(\d+)\.(\d+)$/.exec(v.trim())
      if (!m) return null
      return [Number(m[1]), Number(m[2])]
    }
    /** 从 exec.agent.id 取同会话 Agent（工具调用者自己）。取不到返回 null，绝不抛。 */
    function agentFromExec(exec) {
      try {
        const id = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : null
        if (id === null) return null
        const a = ctx.agents ? ctx.agents.get(id) : undefined
        return (a === undefined || a === null) ? null : a
      } catch (e) { return null }
    }
    /** 从 inventory 行的 agentId 取 Agent。取不到返回 null，绝不抛。 */
    function agentOfRow(row) {
      try {
        const a = ctx.agents ? ctx.agents.get(row.agentId) : undefined
        return (a === undefined || a === null) ? null : a
      } catch (e) { return null }
    }
    function trimTickets() {
      if (tickets.size <= CAPS.tickets) return
      const list = Array.from(tickets.values()).sort(function (a, b) { return a.createdAt - b.createdAt })
      for (let i = 0; i < list.length && tickets.size > CAPS.tickets; i++) tickets.delete(list[i].ticketId)
    }

    // ── 批准提示文案（A-1）─────────────────────────────────────────
    function buildApprovalPrompt(t) {
      return '【dsh-refix 升级批准 · 需你拍板】\n'
        + '目标: dsh-refix（' + t.targetPluginId + '）\n'
        + '版本: ' + t.currentVersion + ' → ' + t.targetVersion + '\n'
        + 'sha256(前16位): ' + t.sha256.slice(0, 16) + '\n'
        + '字节数: ' + t.bytes + ' · JSON 清单验签: ' + (t.unsigned ? '无签名（阶段 3 不做）' : '已验签') + '\n'
        + '来源: ' + t.sourceUrl + '\n'
        + '回滚: cordis_run(pluginId="' + t.targetPluginId + '", packageId="' + t.beforePackageId + '", mode="update")\n'
        + '批准 = 允许在本进程内执行上述源码（等价于远程代码执行）；拒绝则本次升级取消。'
    }

    // ── A-1 宿主强制门：唯一执行入口的批准钩子 ────────────────────────
    // A-11：这是**全局**钩子（动态包挂在 root 下），故非本工具一律 next() 直通；
    // 任何异常只对本工具 fail-closed，绝不让别人的工具调用因我们而报错。
    // A-6：**关闭态不得注册本钩子** —— 关闭时零全局足迹（验收 W-A 差分断言）。
    //      注意：本段必须晚于（受 ENABLED 约束的）注册判断，否则关闭态仍会拦截。
    const registerGate = () => ctx.effect(() => ctx.on('tools/pre-execute', function (exec, next) {
      let name = ''
      try { name = exec && typeof exec.name === 'string' ? exec.name : '' } catch (e) { name = '' }
      if (name !== 'updater_apply') return next()
      try {
        const args = (exec && exec.arguments) || {}
        const t = tickets.get(String(args.ticketId === undefined ? '' : args.ticketId))
        if (!t) return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 未知票据（先调用 updater_check 取得票据与令牌）' })
        if (t.consumed) return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 该票据已被使用（一次性，需重新 updater_check）' })
        if (Date.now() > t.expiresAt) {
          tickets.delete(t.ticketId)
          return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 票据已过期（TTL ' + Math.round(TICKET_TTL_MS / 60000) + ' 分钟），需重新 updater_check' })
        }
        const confirm = String(args.confirm === undefined ? '' : args.confirm)
        if (confirm !== t.token) {
          return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 令牌不匹配（approval-token-mismatch）。令牌 = 票据 sha256 前 ' + TOKEN_LEN + ' 位，须与 updater_check 返回值一致。' })
        }
        if (inFlight) return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 已有一次升级在执行中' })
        return Promise.resolve({ kind: 'ask', reason: buildApprovalPrompt(t) })
      } catch (e) {
        return Promise.resolve({ kind: 'deny', reason: 'updater_apply: 批准门异常 → 按 fail-closed 拒绝: ' + ((e && e.message) || e) })
      }
    }), 'updater.ev-pre-execute')
    if (ENABLED) registerGate()

    // 观察窗判据：目标插件在窗口内被 retract ⇒ 新包没活住。
    ctx.effect(() => ctx.on('cordis/dynamic-retract', function (r) {
      try {
        if (r && typeof r.pluginId === 'string') {
          lastRetract = { pluginId: r.pluginId, packageId: String(r.packageId), pluginRunId: String(r.pluginRunId), ts: Date.now() }
        }
      } catch (e) { /* 纯观察，不抛 */ }
    }), 'updater.ev-retract')

    ctx.effect(() => ctx.on('cordis/dynamic-package', function (p) {
      try {
        if (p && typeof p.pluginId === 'string' && isOwnPackageName(p.name)) selfPluginId = p.pluginId
      } catch (e) { /* 纯身份锚定，不抛 */ }
    }), 'updater.ev-anchor')

    // ── 观察窗 ──────────────────────────────────────────────────────
    function waitForAbort(signal) {
      return new Promise(function (resolve) {
        if (!signal) return
        if (signal.aborted === true) { resolve(); return }
        try { signal.addEventListener('abort', function () { resolve() }, { once: true }) } catch (e) { /* 老实现无 addEventListener */ }
      })
    }
    async function observe(agent, pluginId, targetPackageId, observeMs, signal) {
      const startTs = Date.now()
      const seenAtStart = lastRetract ? lastRetract.ts : 0
      await Promise.race([ctx.timeout(observeMs), waitForAbort(signal)])
      const aborted = signal && signal.aborted === true
      const retract = lastRetract
        && lastRetract.ts > seenAtStart
        && lastRetract.pluginId === pluginId
        && lastRetract.packageId === targetPackageId
      let row = null
      try {
        const rows = runner.snapshot(agent)
        for (const r of rows) if (r.pluginId === pluginId) { row = r; break }
      } catch (e) { /* 观察失败按未通过处理 */ }
      const activeRun = row && row.activeRun ? row.activeRun : null
      const currentPackageId = row && row.currentPackageId ? String(row.currentPackageId) : null
      return {
        elapsedMs: Date.now() - startTs,
        aborted: aborted === true,
        retracted: retract === true,
        activeRun: activeRun ? { packageId: String(activeRun.packageId), pluginRunId: String(activeRun.pluginRunId) } : null,
        currentPackageId: currentPackageId,
        ok: retract !== true && activeRun !== null && String(activeRun.packageId) === targetPackageId,
      }
    }

    // ── apply（唯一执行路径；批准门已在宿主侧通过）────────────────────
    async function doApply(args, exec) {
      if (contractMissing.length > 0) return { outcome: 'refused', reason: 'contract-incompatible', missing: contractMissing }
      if (inFlight) return { outcome: 'refused', reason: 'upgrade-in-progress' }
      const ticketId = String(args.ticketId === undefined ? '' : args.ticketId)
      const confirm = String(args.confirm === undefined ? '' : args.confirm)
      const t = tickets.get(ticketId)
      if (!t) return { outcome: 'refused', reason: 'unknown-ticket' }
      if (t.consumed) return { outcome: 'refused', reason: 'ticket-already-used' }
      if (Date.now() > t.expiresAt) { tickets.delete(ticketId); return { outcome: 'refused', reason: 'ticket-expired' } }
      if (confirm !== t.token) return { outcome: 'refused', reason: 'approval-token-mismatch' }

      const steps = []
      const mark = function (action, detail) { steps.push({ ts: Date.now(), action: action, detail: detail }) }
      const agentId = t.agentId
      let agent
      try { agent = ctx.agents ? ctx.agents.get(agentId) : undefined } catch (e) { agent = undefined }
      if (agent === undefined || agent === null) {
        return { outcome: 'refused', reason: 'owner-session-not-live', detail: '归属会话不在线，无法取得授权 Agent。' }
      }
      // 令牌匹配后**立即消费**：一次性，任何后续失败都不复原。
      t.consumed = true
      inFlight = true
      const startedAt = Date.now()
      try {
        // 二次自检：批准的就是执行的（不回网络，直接用票据里那份字节）
        const rehash = sha256Hex(t.source)
        if (rehash !== t.sha256) {
          mark('hash-recheck-failed', rehash)
          return { outcome: 'failed', phase: 'verify', detail: '内存中的源码哈希与票据不一致（理论不可达）', steps: steps }
        }
        mark('hash-recheck-ok', t.sha256.slice(0, 16))
        if (t.source.indexOf(REFIX_FINGERPRINT) === -1 || t.source.indexOf(UPDATER_FINGERPRINT) !== -1) {
          mark('fingerprint-recheck-failed', 'target/updater 指纹校验失败')
          return { outcome: 'failed', phase: 'verify', detail: '源码指纹复检失败', steps: steps }
        }

        // 切换前再读一次活状态：目标插件仍须存在，且 currentPackageId 与票据一致
        // （否则 check→apply 之间运行态已被别人改动 → 拒绝，不用旧回滚点动手）。
        let row = null
        try {
          const rows = runner.inventory()
          for (const r of rows) if (r.pluginId === t.targetPluginId) { row = r; break }
        } catch (e) { /* 落到下面的 not-found */ }
        if (!row) {
          mark('target-missing', t.targetPluginId)
          return { outcome: 'failed', phase: 'precheck', detail: '目标插件已不存在', steps: steps }
        }
        const liveCurrent = row.currentPackageId ? String(row.currentPackageId) : null
        if (liveCurrent !== t.beforePackageId) {
          mark('stale-ticket', 'live=' + String(liveCurrent) + ' ticket=' + t.beforePackageId)
          return {
            outcome: 'refused', reason: 'stale-ticket',
            detail: '运行态已变化（当前包 ' + String(liveCurrent) + ' ≠ 票据记录 ' + t.beforePackageId + '），需重新 updater_check。',
            steps: steps,
          }
        }

        // ① define：追加不可变包（不改运行态）
        let def
        try {
          def = runner.define({
            sessionId: agentId,
            plugin: { kind: 'existing', pluginId: t.targetPluginId },
            name: TARGET_PLUGIN_NAME + ' ' + t.targetVersion,
            purpose: 'F6 阶段 3：远程源码经用户批准装入运行态（sha256=' + t.sha256.slice(0, TOKEN_LEN) + '，来源 ' + t.file + '）',
            code: { host: t.source },
          })
        } catch (e) {
          mark('define-failed', (e && e.message) || 'define failed')
          return { outcome: 'failed', phase: 'define', detail: (e && e.message) || 'define failed', steps: steps }
        }
        if (!def || !def.packageId) {
          mark('define-bad-receipt', 'no packageId')
          return { outcome: 'failed', phase: 'define', detail: 'define 未返回 packageId', steps: steps }
        }
        const newPackageId = String(def.packageId)
        mark('defined', newPackageId)
        mark('precheck-no-client-half', def.hasClientHalf === true ? '有客户端半区（会走包级审批）' : 'host-only（包级审批不触发，仅工具层门）')

        // ② run(mode:'update')：切版（会 retract 旧 run）
        let r
        try {
          r = await runner.run(agent, t.targetPluginId, newPackageId, 'update')
        } catch (e) {
          mark('run-threw', (e && e.message) || 'run threw')
          return {
            outcome: 'failed', phase: 'activation',
            detail: 'run 抛错，运行态未变（currentPackageId 只在完全成功后变更）: ' + ((e && e.message) || e),
            newPackageId: newPackageId, steps: steps,
          }
        }
        if (!r || !r.ok) {
          mark('activation-failed', (r && r.message) || 'not ok')
          return {
            outcome: 'failed', phase: 'activation', newPackageId: newPackageId,
            detail: '切版失败（运行态未变，无需回滚）: ' + ((r && r.message) || 'unknown'),
            reason: (r && r.reason) || null, steps: steps,
          }
        }
        if (r.status === 'awaiting-approval') {
          mark('awaiting-package-approval', '包级审批被触发（意外：dsh-refix 应为 host-only）')
          return {
            outcome: 'awaiting-approval', newPackageId: newPackageId, pluginRunId: String(r.pluginRunId),
            detail: '切版进入包级等待批准状态；请在 UI 处理后再 updater_report 确认。', steps: steps,
          }
        }
        const newRunId = String(r.pluginRunId)
        mark('activated', newPackageId + ' / ' + newRunId)

        // ③ 观察窗
        const observeMs = clampObserve(args.observeMs)
        mark('observe', observeMs + 'ms')
        const obs = await observe(agent, t.targetPluginId, newPackageId, observeMs, exec && exec.signal)
        mark('observed', obs.ok ? 'ok' : 'unhealthy')
        if (obs.ok && !obs.aborted) {
          const rec = record(t, steps, startedAt, 'success', { newPackageId: newPackageId, pluginRunId: newRunId })
          return {
            outcome: 'success', newPackageId: newPackageId, pluginRunId: newRunId,
            observation: obs, steps: steps, executionId: rec.executionId,
            rollbackPoint: t.beforePackageId,
            note: '观察窗内新包存活。回滚点仍是 ' + t.beforePackageId + '（旧包不可变，随时可切回）。',
          }
        }

        // ④ 回滚（单向棘轮：只回一次，不回滚的回滚）
        mark('rollback-start', 'target=' + t.beforePackageId)
        let back
        try {
          back = await runner.run(agent, t.targetPluginId, t.beforePackageId, 'update')
        } catch (e) {
          mark('rollback-threw', (e && e.message) || 'rollback threw')
          const rec = record(t, steps, startedAt, 'rollback-failed', { newPackageId: newPackageId, pluginRunId: newRunId })
          return {
            outcome: 'rollback-failed', newPackageId: newPackageId, beforePackageId: t.beforePackageId,
            detail: '观察窗未通过且回滚抛错：' + ((e && e.message) || e) + '。**需人工**：请用 cordis_run 手动切回 ' + t.beforePackageId + '。',
            observation: obs, steps: steps, executionId: rec.executionId,
          }
        }
        if (!back || !back.ok) {
          mark('rollback-failed', (back && back.message) || 'not ok')
          const rec = record(t, steps, startedAt, 'rollback-failed', { newPackageId: newPackageId, pluginRunId: newRunId })
          return {
            outcome: 'rollback-failed', newPackageId: newPackageId, beforePackageId: t.beforePackageId,
            detail: '观察窗未通过且回滚失败：' + ((back && back.message) || 'unknown') + '。**需人工**：请用 cordis_run 手动切回 ' + t.beforePackageId + '。',
            observation: obs, steps: steps, executionId: rec.executionId,
          }
        }
        const backRunId = String(back.pluginRunId)
        mark('rolled-back', t.beforePackageId + ' / ' + backRunId)
        const obsBack = await observe(agent, t.targetPluginId, t.beforePackageId, Math.min(observeMs, DRAIN_MS * 4), null)
        const rec = record(t, steps, startedAt, 'rolled-back', { newPackageId: newPackageId, pluginRunId: newRunId })
        return {
          outcome: 'rolled-back', newPackageId: newPackageId, pluginRunId: newRunId,
          beforePackageId: t.beforePackageId, rollbackRunId: backRunId,
          observation: obs, rollbackObservation: obsBack,
          detail: '观察窗未通过（' + (obs.retracted ? '新 run 被 retract' : '新 run 未建立/包不匹配') + '），已自动回滚至 ' + t.beforePackageId
            + (obsBack.ok ? '（回滚版本存活）' : '（回滚版本观察也未通过，需人工）'),
          steps: steps, executionId: rec.executionId,
        }
      } catch (e) {
        mark('exception', (e && e.message) || String(e))
        const rec = record(t, steps, startedAt, 'exception', {})
        return { outcome: 'failed', phase: 'exception', detail: (e && e.message) || String(e), steps: steps, executionId: rec.executionId }
      } finally {
        inFlight = false
      }
    }
    function clampObserve(v) {
      const n = typeof v === 'number' && isFinite(v) ? Math.floor(v) : OBSERVE_MS_DEFAULT
      if (n <= 0) return OBSERVE_MS_DEFAULT
      return n > OBSERVE_MS_MAX ? OBSERVE_MS_MAX : n
    }
    function record(t, steps, startedAt, outcome, extra) {
      const rec = {
        executionId: 'x' + (executions.length + 1),
        ts: startedAt,
        durationMs: Date.now() - startedAt,
        outcome: outcome,
        ticketId: t.ticketId,
        targetPluginId: t.targetPluginId,
        from: t.currentVersion,
        to: t.targetVersion,
        sha256: t.sha256.slice(0, 16),
        steps: steps,
      }
      if (extra.newPackageId) rec.newPackageId = extra.newPackageId
      if (extra.pluginRunId) rec.pluginRunId = extra.pluginRunId
      executions.push(rec)
      while (executions.length > CAPS.executions) executions.shift()
      lastResult = rec
      return rec
    }

    // ── 只读视图 ────────────────────────────────────────────────────
    function report() {
      const self = resolveSelf()
      let target = null
      try {
        const tr = resolveTargetRow(null)
        if (tr.ok) {
          const row = tr.row
          target = {
            pluginId: String(row.pluginId),
            currentPackageId: row.currentPackageId ? String(row.currentPackageId) : null,
            activeRun: row.activeRun ? { packageId: String(row.activeRun.packageId), pluginRunId: String(row.activeRun.pluginRunId) } : null,
            latestStatus: row.latestRun ? row.latestRun.status : null,
            packageCount: (row.packages || []).length,
          }
        }
      } catch (e) { target = null }
      return {
        version: UPDATER_VERSION,
        enabled: ENABLED,
        contract: { ok: contractMissing.length === 0, missing: contractMissing },
        selfPluginId: self,
        inFlight: inFlight,
        manifest: { url: MANIFEST_URL, unsigned: true, verifier: 'placeholder (stage 3 does not sign)' },
        approvalGate: {
          mechanism: "ctx.on('tools/pre-execute') -> {kind:'ask'} -> host ApprovalService",
          allowedValues: ['allowed-once'],
          failClosedOn: ['rejected', 'cancelled', 'unavailable(no answerer)', 'no-agent'],
          persistentGrant: false,
        },
        target: target,
        tickets: Array.from(tickets.values()).map(function (t) {
          return {
            ticketId: t.ticketId, targetPluginId: t.targetPluginId,
            from: t.currentVersion, to: t.targetVersion, file: t.file,
            sha256: t.sha256, bytes: t.bytes,
            consumed: t.consumed, expired: Date.now() > t.expiresAt,
            createdAt: t.createdAt, expiresAt: t.expiresAt,
          }
        }),
        executions: executions,
        lastResult: lastResult,
        lastRetract: lastRetract,
      }
    }

    // ── 工具注册（A-6：关闭时只留只读 report）──────────────────────────
    const T_OUTPUT = {
      schema: { type: 'string' },
      render: function (_args, value) { return [{ type: 'text', text: value }] },
    }
    function j(o) { return JSON.stringify(o, null, 2) }

    if (!ENABLED) {
      console.log('[updater] 未启用（UPDATER_ENABLED=false，A-6 默认关闭）：只注册只读 updater_report；'
        + '不注册 updater_check / updater_apply，也不注册 tools/pre-execute 钩子（零全局足迹）。'
        + '启用方式：把常量改为 true 后重新 define 一个 updater 包。')
      ctx.tools.register(harness.defineTool({
        name: 'updater_report',
        description: 'dsh-refix-updater 只读视图：启用状态、兼容性自检、目标插件当前版本/包、票据队列、执行记录、上次结果。本插件默认关闭时不注册检查/执行工具。',
        parameters: {},
        output: T_OUTPUT,
        async execute(_args, _exec) { return j(report()) },
      }))
      return
    }

    ctx.tools.register(harness.defineTool({
      name: 'updater_check',
      description: 'dsh-refix-updater 只读探测：从固定的仓库版本源拉 manifest 与候选源码，做四道前置校验'
        + '（目标指纹 / 非 updater 指纹 / 清单与源码版本一致 / 尺寸）并计算 SHA-256，生成一张**一次性批准票据**'
        + '（含目标版本、sha256、字节数、来源、回滚命令、令牌）。本工具只拉取与计算：**不 define、不 run、不改任何运行态**。'
        + '拿到票据后再调用 updater_apply，届时宿主会弹出批准框。',
      parameters: {
        pluginId: { type: 'string', description: 'dsh-refix 的 pluginId（省略 = 按包名自动解析）' },
      },
      output: T_OUTPUT,
      async execute(args, _exec) { return j(await doCheck(args && args.pluginId ? String(args.pluginId) : null)) },
    }))

    ctx.tools.register(harness.defineTool({
      name: 'updater_apply',
      description: 'dsh-refix-updater 执行：按票据把新版本源码 define 成不可变包并 run(mode:"update") 切换，'
        + '观察窗（默认 30s、上限 120s）未通过则自动回滚到票据记录的旧包。'
        + '必须传 ticketId 与 confirm（= 票据 sha256 前 12 位令牌）；令牌不匹配直接拒绝。'
        + '**本调用会被宿主强制门拦截并请求用户批准**：只有用户点"允许一次"才执行；'
        + '拒绝 / 取消 / 无批准通道（headless）一律拒绝（fail closed）。票据一次性，TTL 10 分钟。',
      parameters: {
        ticketId: { type: 'string', required: true, description: 'updater_check 返回的 ticketId' },
        confirm: { type: 'string', required: true, description: '批准令牌 = 票据 sha256 前 12 位（必须与会话中展示给用户的一致）' },
        observeMs: { type: 'integer', description: '观察窗毫秒，默认 30000，上限 120000' },
      },
      timeoutMs: APPLY_TIMEOUT_MS,
      output: T_OUTPUT,
      async execute(args, exec) { return j(await doApply(args || {}, exec)) },
    }))

    ctx.tools.register(harness.defineTool({
      name: 'updater_report',
      description: 'dsh-refix-updater 只读视图：启用状态、兼容性自检、批准门机制、目标插件当前版本/包、票据队列、执行记录、上次结果。不含票据源码。',
      parameters: {},
      output: T_OUTPUT,
      async execute(_args, _exec) { return j(report()) },
    }))

    console.log('[updater] 已启用（v' + UPDATER_VERSION + '）：批准门 = 宿主 tools/pre-execute → {kind:"ask"}；'
      + '令牌 = sha256 前 ' + TOKEN_LEN + ' 位；票据 TTL ' + Math.round(TICKET_TTL_MS / 60000) + ' 分钟且一次性；'
      + '无接听方时 fail closed。')
  },
}
