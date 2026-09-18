#!/usr/bin/env node
/**
 * dsh-refix 静态包构建器。
 *
 * 把 `versions/refix-v*.js`（**动态包**源码：一个 `return { name, inject, apply }` 的函数体，
 * 由 cordis_define 经 node:vm 沙箱执行）转换成一份可直接被 DSH profile 当作普通插件层加载的
 * **静态包**（npm 包 + `dsh.bundle.patch` + `export default { name, inject, apply }`）。
 *
 * 为什么要静态包：
 *   动态包必须由会话模型写源码 → `cordis_define` → `cordis_run` 三步手动挂载，且 web profile
 *   下客户端半区切换要走审批流。静态包是普通 profile 层，用一条命令装完即随 dsh 启动自动加载，
 *   不需要模型搬运源码、不需要审批、不需要挂载话术。
 *
 * 转换的正确性依据（宿主源码实证，2026-09-16）：
 *   1. 静态包的 `apply(ctx)` 拿到的是**真实 ctx**；动态包的 `apply(ctx)` 拿到的是沙箱 facade
 *      （`cordis-host-runner/src/guard.ts` L718 `sandboxContext`）。两者都提供
 *      `ctx.get / on / effect / timeout / interval / tools.register / provide`，且真实 ctx 是超集。
 *      ⇒ 本脚本**不改写**任何 ctx 调用。
 *   2. 但 `inject` 必须补齐一处：沙箱 facade 对 `ctx.tools` 是**无条件**放行的
 *      （`guard.ts` L755 `if (prop === 'tools') return tools`），所以动态源码的 inject 里没有
 *      `tools`；真实 ctx 里 `ctx.tools` 是服务属性，未声明就读会抛
 *      `cannot get property "tools" without inject` → **整棵插件树加载失败，dsh 起不来**。
 *      2026-09-16 真机启动实测踩到过，故改为构建期按"体里实际读到的服务"机器补齐 inject。
 *   2. 动态包额外多一个 `harness`（`sandbox.ts` L133）：
 *        harness.defineTool(options)         = 真 `defineTool` + 跨 realm 参数/返回值规整
 *        harness.registerTool(ctx, tool)     = 标记校验后 `ctx.tools.register(tool)`
 *      其中 `defineTool` 来自 `@deepseek-ai/dsh-tools`（`guard.ts` L19 / L551-592），DSL 与
 *      refix 源码里写的 `parameters: { prop: { type, required, description } }` **完全同构**
 *      （见 `core/tools/src/schema.ts` L449 `parameterSchemaSpecToJsonSchema`）。
 *      ⇒ 静态等价物 = 在模块顶层 `await import('@deepseek-ai/dsh-tools')` 取真 `defineTool`；
 *        `ctx.tools.register` 用真 ctx 的原生方法（真 `register` 只校验 `output.render` 与
 *        `output.schema`，没有沙箱那个 marker 检查 —— `core/tools/src/index.ts` L1027-1046）。
 *   3. `@deepseek-ai/dsh-tools` 由 `healProfilesModuleFallback`（`app-boot/src/profile.ts` L547）
 *      在每次启动时投影进 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`（symlink 到安装侧闭包）。
 *      **但"按 Node 父级查找"在本场景不成立**：pnpm 以 symlink 安装本包时，Node 会先把模块
 *      realpath 回**源目录**，再沿源目录链路向上找依赖 —— 那条链路上没有 @deepseek-ai/*。
 *      2026-09-17 实测：静态包经 `dsh plugin add <dir>` 装进 profile 后，裸说明符 import 必然失败。
 *      ⇒ 改为**两级解析**：L1 裸说明符（实体目录安装时命中）→ L2 用 `createRequire` 显式按
 *        `$DSH_HOME/profiles/node_modules` 解析（无 $DSH_HOME 时退 `~/.dsh`）；
 *        两级都不可达才退化为内置 DSL→JSON Schema 编译器（少一层运行期参数校验，其余不变）。
 *      任何一步失败都不得抛错，否则整个插件树加载失败（dsh 起不来）。
 *
 * 用法：
 *   node deploy/static/build-static.mjs                 # 按 versions/manifest.json 的稳定线构建
 *   node deploy/static/build-static.mjs --src versions/refix-v1.07.js
 *   node deploy/static/build-static.mjs --out packages/dsh-refix
 *   node deploy/static/build-static.mjs --check         # 只做结构断言，不落盘
 *   node deploy/static/build-static.mjs --pack          # 构建后再 npm pack 出 tgz（供一行命令安装）
 *
 * 默认落盘到 `packages/dsh-refix`（**必须入库**）：awesome-dsh-plugin 收录 CI 只从
 * 仓库根或 packages/ · plugins/ · apps/ 子包抓取 package.json 找 `dsh.bundle` manifest，
 * 放在 deploy/static/dist 下 CI 永远找不到。tgz 仍打包到 deploy/static/dist/，
 * 路径不变，README 的一行命令安装 URL 不受影响。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本脚本所在目录（`deploy/static`）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录。 */
const REPO = resolve(HERE, '..', '..')

const argv = process.argv.slice(2)

/**
 * 读一个 `--name value` 形式的参数。
 * @param {string} name - 参数名（含前导 `--`）。
 * @param {string|undefined} fallback - 缺省值。
 * @returns {string|undefined} 参数值。
 */
function arg(name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

/**
 * 打印错误并以退出码 1 结束。
 * @param {string} message - 错误信息。
 * @returns {never} 永不返回。
 */
function fail(message) {
  process.stderr.write(`build-static: ${message}\n`)
  process.exit(1)
}

/** `--check`：只断言，不写文件。 */
const CHECK_ONLY = argv.includes('--check')

/** 构建产物包名。必须与插件自报的 `SELF_PLUGIN_NAME` 一致。 */
const PACKAGE_NAME = 'dsh-refix'

// ── 1. 定源 ────────────────────────────────────────────────────────────────
const manifestPath = join(REPO, 'versions', 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const srcRel = arg('--src', manifest.file)
const srcPath = resolve(REPO, srcRel)
if (!existsSync(srcPath)) fail(`source not found: ${srcPath} (manifest.file=${manifest.file})`)

const source = readFileSync(srcPath, 'utf8')
const srcName = srcRel.split(/[\\/]/).pop()
const srcSha = createHash('sha256').update(source, 'utf8').digest('hex')

// ── 2. 结构断言 + 切片 ─────────────────────────────────────────────────────
/**
 * 断言条件成立。
 * @param {boolean} condition - 待断言条件。
 * @param {string} message - 失败信息。
 * @returns {void}
 */
function assert(condition, message) {
  if (!condition) fail(`source structure changed: ${message} (${srcRel})`)
}

const APPLY_OPEN = '\n  apply(ctx) {\n'
const applyAt = source.indexOf(APPLY_OPEN)
assert(applyAt !== -1, `no exact ${JSON.stringify(APPLY_OPEN)}`)
assert(source.indexOf(APPLY_OPEN, applyAt + 1) === -1, 'more than one `apply(ctx) {`')

const head = source.slice(0, applyAt)
const returnAt = head.lastIndexOf('\nreturn {')
assert(returnAt !== -1, 'no `return {` before `apply(ctx) {`')

/** 模块级常量段（REFIX_VERSION / CONTRACT / CAPS / SYMPTOMS / IN_FLIGHT …），逐字节保留。 */
const preamble = head.slice(0, returnAt)
/** `return { name, inject, apply }` 的对象头，用于抽取 name / inject。 */
const pluginHead = head.slice(returnAt)

const nameMatch = /name:\s*'([^']+)'/.exec(pluginHead)
assert(nameMatch !== null, 'no `name: \'…\'` in the returned plugin object')
const injectMatch = /inject:\s*(\[[^\]]*\])/.exec(pluginHead)
assert(injectMatch !== null, 'no `inject: [ … ]` in the returned plugin object')

const pluginName = nameMatch[1]
const pluginInject = injectMatch[1]
assert(pluginName === PACKAGE_NAME, `plugin name ${JSON.stringify(pluginName)} != package name ${JSON.stringify(PACKAGE_NAME)}`)
const closing = /\n  \},\n\}\s*$/.exec(source)
assert(closing !== null, 'file does not end with `\\n  },\\n}`')
assert(closing.index > applyAt, 'closing brace appears before `apply(ctx) {`')

/** `apply(ctx) {` 的函数体，逐字节保留（含结尾 console.log 就绪行）。 */
const body = source.slice(applyAt + APPLY_OPEN.length, closing.index)

// 体内容完整性探针：这些是这个插件"必须存在"的东西，被误删要在这里炸而不是在用户机器上炸。
const defineToolSites = body.split('harness.defineTool(').length - 1
assert(defineToolSites === 5, `expected 5 harness.defineTool( call sites (V1.10: repair/report/patrol/export/restore), found ${defineToolSites}`)
assert(body.includes('ctx.tools.register('), 'no ctx.tools.register( call')
assert(body.includes('ctx.cordisInspect.register('), 'no ctx.cordisInspect.register( call')
assert(body.includes('ctx.interval('), 'no ctx.interval( patrol registration')
assert(/console\.log\('dsh-refix ' \+ REFIX_VERSION \+ ' ready; contract '/.test(body), 'ready line missing')
// 沙箱禁用的 Node API 不得出现：静态包下它们能跑，但出现即说明源码依赖了沙箱外契约。
for (const forbidden of ['require(', 'setTimeout(', 'setInterval(', 'process.env', 'fetch(']) {
  assert(!body.includes(forbidden), `body uses sandbox-withheld \`${forbidden}\` — static port needs review`)
}

// ── 3. 补齐 inject：沙箱无条件提供的服务在真实 ctx 下要声明 ──────────────────
/**
 * 沙箱 facade 对 `ctx.<name>` 的两类放行（`guard.ts` L753-780 `sandboxContext`）：
 *   · 生命周期动词（on/once/effect/provide + timer 家族）——不属服务，无需 inject；
 *   · 名字恰好是 `tools` 的服务——**无条件返回**，于是动态源码可以不把它写进 inject。
 * 真实 cordis ctx 没有这层放行：`ctx.tools` 是服务属性，未声明就读 = 抛
 * `cannot get property "tools" without inject`，整棵插件树加载失败（dsh 起不来）。
 * 2026-09-16 真机启动实测踩到过这条，所以这里必须机器补齐而不是靠人记得。
 */
const LIFECYCLE_VERBS = new Set([
  'get', 'on', 'once', 'effect', 'provide',
  'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
])
/** 沙箱无条件暴露、真实 ctx 需要 inject 的服务名（目前只有 tools）。 */
const SANDBOX_UNCONDITIONAL_SERVICES = new Set(['tools'])

/** 体里所有 `ctx.<ident>` 属性访问的服务名（含方法调用与属性读取），已排除生命周期动词。 */
function servicesTouched(source) {
  const names = new Set()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (!LIFECYCLE_VERBS.has(match[1])) names.add(match[1])
  }
  return names
}

/** 源码 inject 数组的字面量内容。 */
const declaredInject = JSON.parse(pluginInject.replace(/'/g, '"'))
const touched = servicesTouched(body)

// 体里读到的每个服务要么已声明，要么是被沙箱放行的那一类（下面补齐）；两者都不是 = 有服务名写错了。
for (const name of touched) {
  assert(
    declaredInject.includes(name) || SANDBOX_UNCONDITIONAL_SERVICES.has(name),
    `body reads ctx.${name} but inject declares neither it nor a sandbox-unconditional service`,
  )
}

// 静态 inject = 源码 inject ∪ 体里实际读到但源码省略的沙箱无条件服务（顺序稳定）。
const staticInject = [...declaredInject]
const addedInject = []
for (const name of touched) {
  if (!staticInject.includes(name)) {
    staticInject.push(name)
    addedInject.push(name)
  }
}
assert([...touched].every(name => staticInject.includes(name)), 'static inject does not cover every service the body reads')

// ── 4. 版本号 ──────────────────────────────────────────────────────────────
/**
 * 由 tag（`V1.07`）推出 npm semver（`1.7.0`）：`V1.07` → major 1、minor 7 → `1.7.0`。
 * @param {string} tag - manifest.releaseTag。
 * @returns {string} semver 版本号。
 */
function tagToSemver(tag) {
  const match = /^V?(\d+)\.(\d+)$/.exec(tag)
  if (match === null) fail(`cannot derive semver from releaseTag ${JSON.stringify(tag)}; expected V<major>.<minor>`)
  return `${Number(match[1])}.${Number(match[2])}.0`
}

/**
 * 静态包**自己**的发布线（`manifest.static`），与动态包稳定线（顶层 `releaseTag`/`file`）分开：
 * 顶层字段回答"动态包最新是哪个版本"，`static` 段回答"静态包最新是哪个版本"。
 * 静态包是**交付形态**的发布 —— 插件逻辑始终继承 `manifest.file` 指向的那份源码，
 * 所以优先取 `static.packageVersion`，取不到才退回按动态包 tag 推导（老行为）。
 */
const staticRelease = manifest.static ?? {}
const staticTag = staticRelease.releaseTag ?? manifest.releaseTag ?? manifest.version ?? ''
const pkgVersion = staticRelease.packageVersion ?? tagToSemver(staticTag)
const outDir = resolve(REPO, arg('--out', join('packages', PACKAGE_NAME)))

// ── 5. 静态等价层（sandbox `harness` 的替代）───────────────────────────────
/**
 * 生成 `lib/index.js` 里 harness 等价层的源码。
 * 独立成函数是为了让下面 `hostModule()` 的模板保持可读。
 * @returns {string} 模块顶层语句块。
 */
function harnessShim() {
  return `/**
 * 真 ctx 上重现沙箱注入的 \`harness\`。静态等价物只有 \`defineTool\` 一项：
 *   harness.registerTool(ctx, tool) 在静态下就是 ctx.tools.register(tool)（真 register 无 marker 校验），
 *   harness.handle 是动态包客户端半区 RPC，静态包不需要。
 * 解析顺序（两级，顶层 await；**任何一步失败都不能让模块加载抛错**，
 * 否则整棵 profile 插件树加载失败、dsh 起不来）：
 *   L1 裸说明符 '@deepseek-ai/dsh-tools' —— 本包以**实体目录**安装时命中；
 *   L2 \`$DSH_HOME/profiles/node_modules\` —— 宿主 healProfilesModuleFallback
 *      （app-boot/src/profile.ts L547）把安装侧依赖闭包投影在这里。
 *      **pnpm 以 symlink 安装本包时 L1 必然失败**：Node 会先把本模块 realpath 回源目录，
 *      再沿源目录链路向上找依赖，而那条链路里没有 @deepseek-ai/*；此时只能靠 L2。
 *   L3 内置 schema 编译器（L1/L2 都不可达时启用，并打印一条告警）。
 * DSH home 语义：显式路径 > $DSH_HOME > ~/.dsh（util/home-paths/src/index.ts L12/L18/L62）。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function loadHostDefineTool() {
  const pick = mod => {
    const fn = mod?.defineTool ?? mod?.default?.defineTool
    return typeof fn === 'function' ? fn : null
  }
  try {
    const fn = pick(await import('@deepseek-ai/dsh-tools'))
    if (fn) return fn
  } catch (_) { /* 落到 L2 */ }

  const bases = []
  const envHome = process.env && process.env.DSH_HOME
  if (typeof envHome === 'string' && envHome.trim() !== '') {
    bases.push(join(envHome.trim(), 'profiles', 'node_modules'))
  }
  try { bases.push(join(homedir(), '.dsh', 'profiles', 'node_modules')) } catch (_) {}

  const requireFromHere = createRequire(import.meta.url)
  for (const base of bases) {
    try {
      const entry = requireFromHere.resolve('@deepseek-ai/dsh-tools', { paths: [base] })
      const fn = pick(await import(pathToFileURL(entry).href))
      if (fn) return fn
    } catch (_) { /* 下一个候选 */ }
  }
  return null
}

const defineToolImpl = await loadHostDefineTool()
if (defineToolImpl === null) {
  console.error('[refix] 静态包：未能解析 @deepseek-ai/dsh-tools'
    + '（已尝试裸说明符与 $DSH_HOME/profiles/node_modules 投影目录）；'
    + '改用内置 schema 编译器。工具参数将不做运行期校验，其余行为不变。')
}

${fallbackCompiler()}

const harness = {
  defineTool: defineToolImpl ?? fallbackDefineTool,
}
`
}

/**
 * 生成内置兜底编译器源码（`defineTool` 不可达时使用）。
 * 只覆盖 refix 实际用到的 DSL 形状：标量 / object / array + 注解 + enum/const。
 * 与宿主 \`parameterSchemaSpecToJsonSchema\`（core/tools/src/schema.ts L449）产出的
 * \`{ type:'object', properties, required? }\` 结构一致。
 * @returns {string} 源码块。
 */
function fallbackCompiler() {
  return `/* ── 内置兜底：DSL → JSON Schema（仅在 @deepseek-ai/dsh-tools 不可达时启用）── */
const FALLBACK_SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const FALLBACK_ANNOTATIONS = ['description', 'title']

function fallbackCopyAnnotations(from, to) {
  for (const key of FALLBACK_ANNOTATIONS) if (from[key] !== undefined) to[key] = from[key]
  if (from.enum !== undefined) to.enum = from.enum.slice()
  if (from.const !== undefined) to.const = from.const
  if (from.default !== undefined) to.default = from.default
  if (from.examples !== undefined) to.examples = from.examples
}

function fallbackValueSchema(node) {
  const out = {}
  if (node === null || typeof node !== 'object') return { type: 'json' }
  if (node.type === 'object') {
    out.type = 'object'
    out.properties = fallbackPropertyMap(node.properties ?? {})
    out.additionalProperties = node.additionalProperties !== false
    return out
  }
  if (node.type === 'array') {
    out.type = 'array'
    if (node.items !== undefined) out.items = fallbackValueSchema(node.items)
    return out
  }
  out.type = FALLBACK_SCALARS.has(node.type) ? node.type : 'json'
  fallbackCopyAnnotations(node, out)
  return out
}

function fallbackPropertyMap(spec) {
  const properties = {}
  for (const key of Object.keys(spec)) properties[key] = fallbackValueSchema(spec[key])
  return properties
}

/**
 * 兜底 defineTool：与宿主同签名，把 DSL 编译成 JSON Schema 后原样返回 definition。
 * 不做运行期参数校验（那是宿主 defineTool 的额外职责）。
 */
function fallbackDefineTool(options) {
  if (options === null || typeof options !== 'object') throw new Error('harness.defineTool options must be an object')
  const spec = options.parameters ?? {}
  const required = Object.keys(spec).filter(key => spec[key] && spec[key].required === true)
  const parameters = { type: 'object', properties: fallbackPropertyMap(spec) }
  if (required.length > 0) parameters.required = required
  return { ...options, parameters }
}
`
}

/**
 * 组装完整的 `lib/index.js`。
 * @returns {string} 生成文件内容。
 */
function hostModule() {
  return `${header()}
${preamble}
${harnessShim()}
export const name = ${JSON.stringify(pluginName)}
export const inject = ${JSON.stringify(staticInject)}

export function apply(ctx) {
${body}
}
`
}

/**
 * 生成文件头：来源、哈希、语义差异说明。
 * @returns {string} 头部注释块。
 */
function header() {
  const injectNote = addedInject.length === 0
    ? ` *   inject 与源码一致：${JSON.stringify(staticInject)}`
    : ` *   inject 已补齐：源码 ${JSON.stringify(declaredInject)}
 *              → 静态 ${JSON.stringify(staticInject)}
 *   原因：沙箱 facade 对 \`ctx.tools\` 是**无条件**放行的（guard.ts L755 \`if (prop === 'tools') return tools\`），
 *   所以动态源码不必把 tools 写进 inject；真实 cordis ctx 里它是服务属性，未声明就读会抛
 *   \`cannot get property "tools" without inject\`，整棵插件树加载失败。构建期机器补齐，勿手改。`
  return `/**
 * ${PACKAGE_NAME} v${pkgVersion} — DSH **静态**（profile 层）构建。自动生成，请勿手改。
 *
 *   生成器  deploy/static/build-static.mjs
 *   生成源  ${srcRel}
 *   源 sha256  ${srcSha}
 *   插件自报版本  ${manifest.latest}（${manifest.version}）
 *   静态包发布  ${staticTag}（package ${pkgVersion}）
 *
 ${injectNote}
 *
 * 与动态包（cordis_define + cordis_run）的语义差异表：
 *   harness.defineTool  → 模块顶层**两级**解析 @deepseek-ai/dsh-tools 的 defineTool：
 *                         L1 裸说明符 → L2 $DSH_HOME/profiles/node_modules 投影目录
 *                         （pnpm symlink 安装时 L1 必失败，靠 L2 命中安装侧同一份）；
 *                         两级都不可达才退化为内置 DSL→JSON Schema 编译器并打印降级告警。
 *                         调用点逐字节照搬未改写；
 *   ctx.tools.register  → 真 ctx 原生方法（沙箱那个 marker 校验是真 register 没有的）；
 *   inject              → 见上，构建期补齐；
 *   其余 ctx 用法（ctx.get / on / effect / timeout / interval / cordisInspect.register）
 *                        → 真实 ctx 与沙箱 facade 语义一致，逐字节照搬未改写。
 */
`
}

/**
 * 组装静态包的 `package.json`。
 * @returns {string} 缩进 2 空格的 JSON 文本。
 */
function packageJson() {
  const manifestJson = {
    name: PACKAGE_NAME,
    version: pkgVersion,
    description: `dsh-refix ${manifest.latest} — DSH 自诊断·自修复·自迭代插件（静态 profile 层构建）`,
    // 不设 private:true：收录后市场按 npm 下载量排序展示，包必须可发布。
    // （profile 的 pnpm-workspace.yaml 带 autoInstallPeers:false，故 peer 不会被安装，
    // 运行时由 $DSH_HOME/profiles/node_modules 的安装侧投影解析到。）
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml', 'README.md'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    // peer 范围按 awesome-dsh-plugin 指南的 semver prerelease 规则写：
    // 裸 `*` 静默排除 harness 的所有预发布构建（如 0.1.0-rc.6）——node-semver 只在
    // 比较符与版本共享同一 x.y.z 元组且自身带预发布标签时才放行预发布版本，
    // 所以 0.0.x / 0.1.x 两条线各给一个显式预发布分支（<0.2.0-0 挡住 0.2.x 误匹配）。
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-tools': { optional: true } },
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/ckk-09/dsh-refix.git' },
    keywords: ['dsh', 'deepseek-harness', 'cordis', 'self-healing', 'watchdog'],
  }
  return `${JSON.stringify(manifestJson, null, 2)}\n`
}

/**
 * 组装静态包的 `cordis.patch.yml`。
 * 带 `id` 的 insert 会 push 进根数组；`name` 是模块 specifier，由 loader 从 profile 目录解析。
 * @returns {string} YAML 文本。
 */
function patchYml() {
  return `# ${PACKAGE_NAME} v${pkgVersion} — profile 层 patch（自动生成，请勿手改）
# 由 dsh.profile.bundles 中出现的 "${PACKAGE_NAME}" 层自动应用。
# 注意：同一数组内出现两个相同 id 会硬启动失败（vendor/loader/src/config/group.ts L59-66
# entryMap 的 duplicate loader entry id 检查）。改配置用顶层 "- id: X" + config:，不要再 insert。
- insert:
    - id: ${PACKAGE_NAME}
      name: '${PACKAGE_NAME}'
`
}

/**
 * 组装静态包自带的 README。
 * @returns {string} Markdown 文本。
 */
function readme() {
  return `# ${PACKAGE_NAME} v${pkgVersion}（静态包）

DSH 静态 profile 层构建，由 \`deploy/static/build-static.mjs\` 自动生成。
生成源：\`${srcRel}\`（sha256 \`${srcSha.slice(0, 16)}…\`）。

## 装（一条命令）

\`\`\`powershell
dsh plugin --profile web add <本目录的绝对路径>
\`\`\`

装完重启 \`dsh web\`。该命令是宿主原生能力：它把参数转发给 profile 目录里的 pnpm，
然后把声明了 \`dsh.bundle\` 的依赖自动并入 \`dsh.profile.bundles\` 层栈。

卸载：\`dsh plugin --profile web remove ${PACKAGE_NAME}\`。

## 装好的标志

dsh 控制台出现：

\`\`\`
${PACKAGE_NAME} ${manifest.latest} ready; contract OK (兼容性自检通过); baseline plugins: N; patrol every 15000ms
\`\`\`

## 边界（与动态包一致）

- **周期巡检自动**：\`PATROL_PERIOD_MS = 15000\`，插件自己起定时器，无需任何外部触发。
- **修复与报告不自动**：修复唯一入口是 \`refix_repair\` 工具，报告是 \`refix_report\`，
  巡检是 \`refix_patrol\` —— 都要由会话模型按需调用。插件源码里没有 prompt/systemPrompt
  注入，所以它**不会主动对被修复的会话说话**。
  要"全自动"，请在挂载后授权会话模型：先 \`refix_patrol\` 建立基线，之后按需 \`refix_report\`、
  可修症状直接 \`refix_repair\`。

## 运行期依赖

\`@deepseek-ai/dsh-tools\`（取 \`defineTool\` 做 DSL→JSON Schema 编译与参数校验）。

解析分两级：① 裸说明符 —— 本包以**实体目录**安装时命中；② \`$DSH_HOME/profiles/node_modules\`
—— DSH 启动时把安装侧依赖闭包投影在这里（\`healProfilesModuleFallback\`）。
pnpm 以 symlink 安装本包时第 ① 级必然失败（Node 会把模块 realpath 回源目录再找依赖），
靠第 ② 级命中安装侧同一份。

两级都不可达时插件**仍会加载并巡检**，只是工具 schema 走内置编译器、参数不做运行期校验，
控制台打印一行 \`[refix] 静态包：未能解析 …\` 警告。看到它不影响使用；
要消除它，确认 \`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools\` 存在即可。
`
}

// ── 6. 落盘 ────────────────────────────────────────────────────────────────
const outputs = new Map([
  ['package.json', packageJson()],
  ['cordis.patch.yml', patchYml()],
  ['README.md', readme()],
  [join('lib', 'index.js'), hostModule()],
])

process.stdout.write(`build-static: ${srcRel}\n`)
process.stdout.write(`  sha256      ${srcSha}\n`)
process.stdout.write(`  plugin      ${pluginName} ${manifest.latest}\n`)
process.stdout.write(`  inject      source ${JSON.stringify(declaredInject)}\n`)
process.stdout.write(`              static ${JSON.stringify(staticInject)}${addedInject.length === 0 ? ' (unchanged)' : `  ← +${addedInject.join(', ')} (沙箱无条件提供，真实 ctx 需声明)`}\n`)
process.stdout.write(`  package     ${PACKAGE_NAME}@${pkgVersion}\n`)
process.stdout.write(`  body        ${body.split('\n').length} lines kept verbatim, ${defineToolSites} harness.defineTool sites\n`)
process.stdout.write(`  out         ${CHECK_ONLY ? '(check only, nothing written)' : relative(REPO, outDir)}\n`)

if (CHECK_ONLY) {
  process.stdout.write('build-static: OK (structural assertions passed)\n')
  process.exit(0)
}

rmSync(outDir, { recursive: true, force: true })
for (const [rel, content] of outputs) {
  const target = join(outDir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  process.stdout.write(`  wrote       ${relative(outDir, target)}  ${Buffer.byteLength(content, 'utf8')}B\n`)
}
process.stdout.write(`build-static: done — ${outDir}\n`)

// ── 7. 打包（--pack）：产出可直接 `dsh plugin add <tgz>` 的 tarball ─────────
// 为什么需要它：静态包是**目录**（4 个文件），逐文件下载比"动态包 1 个文件 + 贴话术"更麻烦，
// 那这个方案就白做了。打成 tgz 后安装真的只剩一条命令（pnpm 接受 tarball 规格），且
// `dsh plugin` 会把声明了 `dsh.bundle` 的依赖自动并进 `dsh.profile.bundles`
// （apps/cli/src/plugin.ts L120），卸载时同样自动摘除。
if (argv.includes('--pack')) {
  // tgz 固定打到 deploy/static/dist/（历史路径，README 一行命令安装 URL 指向这里），
  // 与展开目录（packages/dsh-refix）解耦。
  const distDir = join(REPO, 'deploy', 'static', 'dist')
  mkdirSync(distDir, { recursive: true })
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = spawnSync(npmCmd, ['pack', '--pack-destination', distDir], {
    cwd: outDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const nameLine = (packed.stdout ?? '')
    .split(/\r?\n/).map(line => line.trim())
    .filter(line => line.endsWith('.tgz')).pop()
  if (packed.status !== 0 || nameLine === undefined) {
    process.stdout.write(`  pack        FAILED (status=${packed.status})\n${packed.stderr ?? ''}\n`)
    process.exit(1)
  }
  const tgzPath = join(distDir, nameLine)
  const bytes = readFileSync(tgzPath)
  process.stdout.write(`  pack        ${relative(REPO, tgzPath)}  ${bytes.length}B\n`)
  process.stdout.write(`              sha256 ${createHash('sha256').update(bytes).digest('hex')}\n`)
}
