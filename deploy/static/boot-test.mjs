#!/usr/bin/env node
/**
 * dsh-refix 静态包**真机启动**验证（第三条腿；前两条是 build-static --check 与 test-static）。
 *
 * 干三件事：
 *   1. 用**隔离 profile** 真启动 dsh（`--port 0 --no-open`），**完整**捕获 stdout+stderr —— 不做任何
 *      过滤。历史的教训：把 `[refix] …` 当"插件噪音"过滤掉，会把"降级告警"一并吞掉，
 *      于是"真机无降级"就成了假绿。
 *   2. 就绪后统计三件证据：
 *        ready    `dsh-refix <ver> ready; contract OK …; patrol every 15000ms`
 *        degrade  `[refix] 静态包：…`      ← 出现即说明两级解析都没命中，走了内置编译器
 *        treefail `plugin tree failed to load`  ← 出现即插件没挂上（最严重）
 *   3. 收工用 `taskkill /PID <pid> /T /F` **树杀**（Windows 下 .cmd 派生的 node 不树杀会残留）。
 *
 * 用法：
 *   node deploy/static/boot-test.mjs [--profile refixtest] [--timeout 120000] [--settle 3000]
 *
 * 退出码：0 = 就绪且无降级无树失败；1 = 有降级；2 = 没等到就绪行；3 = 插件树加载失败。
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const PROFILE = arg('--profile', 'refixtest')
const TIMEOUT_MS = Number(arg('--timeout', '120000'))
const SETTLE_MS = Number(arg('--settle', '3000'))
const DSH_CMD = arg('--dsh', 'D:\\Node.js\\dsh.cmd')

const READY_RE = /dsh-refix\s+\S+\s+ready;\s*contract OK/
const DEGRADE_RE = /\[refix\]\s*静态包：/
const TREE_FAIL_RE = /plugin tree failed to load/

const lines = []
let child = null
let settled = false

function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch (_) { /* 已退出 */ }
}

function finish(code) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  if (child && child.pid) killTree(child.pid)

  const readyLine = lines.find(l => READY_RE.test(l))
  const degrade = lines.filter(l => DEGRADE_RE.test(l))
  const treeFail = lines.filter(l => TREE_FAIL_RE.test(l))
  const url = lines.find(l => /https?:\/\/127\.0\.0\.1:\d+/.test(l))

  const logPath = join(tmpdir(), `refix-boot-full-${child?.pid ?? 'x'}.log`)
  try { writeFileSync(logPath, lines.join('\n'), 'utf8') } catch (_) {}

  process.stdout.write('\n── 真机启动验证结果 ─────────────────────────────\n')
  process.stdout.write(`  profile     ${PROFILE}\n`)
  process.stdout.write(`  完整日志    ${logPath}  (${lines.length} 行，未过滤)\n`)
  process.stdout.write(`  ready       ${readyLine ? 'YES  ' + readyLine.trim() : 'NO'}\n`)
  process.stdout.write(`  url         ${url ? url.trim() : '(未捕获)'}\n`)
  process.stdout.write(`  degrade     ${degrade.length === 0 ? 'NO (两级解析命中宿主真 defineTool)' : 'YES x' + degrade.length}\n`)
  for (const l of degrade) process.stdout.write(`              ${l.trim()}\n`)
  process.stdout.write(`  tree failed ${treeFail.length === 0 ? 'NO' : 'YES x' + treeFail.length}\n`)
  for (const l of treeFail) process.stdout.write(`              ${l.trim()}\n`)

  const exit = treeFail.length > 0 ? 3 : !readyLine ? 2 : degrade.length > 0 ? 1 : 0
  process.stdout.write(`  verdict     ${exit === 0 ? 'PASS' : exit === 1 ? 'PASS(降级)' : 'FAIL'}\n`)
  process.exit(exit)
}

const timer = setTimeout(() => {
  process.stdout.write(`boot-test: 超时 ${TIMEOUT_MS}ms 未见就绪行\n`)
  finish(2)
}, TIMEOUT_MS)

process.stdout.write(`boot-test: profile=${PROFILE} timeout=${TIMEOUT_MS}ms dsh=${DSH_CMD}\n`)

child = spawn(DSH_CMD, ['--profile', PROFILE, '--port', '0', '--no-open'], {
  shell: true,
  windowsHide: true,
  env: { ...process.env },
})

const onChunk = chunk => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim() === '') continue
    lines.push(line)
    if (READY_RE.test(line) && !settled) setTimeout(() => finish(0), SETTLE_MS)
    if (TREE_FAIL_RE.test(line) && !settled) setTimeout(() => finish(3), SETTLE_MS)
  }
}
child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)
child.on('error', error => {
  process.stdout.write(`boot-test: 启动失败 ${error.message}\n`)
  finish(2)
})
child.on('exit', code => {
  process.stdout.write(`boot-test: dsh 进程退出 code=${code}\n`)
  finish(2)
})
