#!/usr/bin/env node
/**
 * profile 配置树探针：`dsh --profile <p> --dump-config` 的离线核对器。
 *
 * 为什么需要它：`duplicate loader entry id` 会让 dsh **硬启动失败**，而事后从报错栈里
 * 反推是哪一层 patch 重复很费劲。本探针把合成后的树抓下来，**按 `^- id: <x>$` 数行**给计数：
 *   1 = 正常；2+ = 重复（dsh 起不来）。注意**不要按关键字数**——`cordis-host-runner`
 *   每出现一次会命中 2 行（`id:` 行 + `name:` 行），数关键字会翻倍误判。
 *
 * dump-config 是**离线合成**，dsh 已经起不来时它照样能跑（exit=0），所以是救援首选。
 *
 * 用法：
 *   node deploy/static/dump-config-check.mjs --profile refixtgz [--ids dsh-refix,cordis-host-runner] [--out <文件>]
 *   node deploy/static/dump-config-check.mjs --profile web --ids tool-cordis,cordis-host-runner
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const PROFILE = arg('--profile', 'web')
const DSH_CMD = arg('--dsh', 'D:\\Node.js\\dsh.cmd')
const OUT = arg('--out', '')
const IDS = arg('--ids', 'dsh-refix,cordis-host-runner').split(',').map(s => s.trim()).filter(Boolean)

const result = spawnSync(DSH_CMD, ['--profile', PROFILE, '--dump-config'], {
  shell: true,
  encoding: 'buffer',
  maxBuffer: 256 * 1024 * 1024,
})
const out = result.stdout ? result.stdout.toString('utf8') : ''
const err = result.stderr ? result.stderr.toString('utf8') : ''

// 严格计数：行首 `- id: <x>`（dump 出来的树就是这种缩进层级）。
const countStrict = id => {
  const m = out.match(new RegExp(`^- id: ${id}$`, 'gm'))
  return m ? m.length : 0
}
// 宽松计数：任何位置出现 `- id: <x>`（含缩进进 group 子数组的 insert）。
const countLoose = id => {
  const m = out.match(new RegExp(`- id: ${id}(?=\\s|$)`, 'gm'))
  return m ? m.length : 0
}

const lines = []
lines.push(`dump-config-check: profile=${PROFILE}  exit=${result.status}  树行数=${out.split(/\r?\n/).length}`)
let duplicate = false
while (IDS.length > 0) {
  const id = IDS.shift()
  const s = countStrict(id)
  const l = countLoose(id)
  const verdict = s === 1 ? 'OK(1)' : s === 0 ? 'MISSING(0)' : `DUPLICATE(${s})`
  if (s > 1) duplicate = true
  lines.push(`  - id: ${id.padEnd(24)} strict=${s}  loose=${l}   ${verdict}`)
}
if (err.trim() !== '') {
  lines.push('  stderr:')
  for (const l of err.split(/\r?\n/).slice(0, 8)) if (l.trim() !== '') lines.push(`    ${l.trim()}`)
}

const text = lines.join('\n') + '\n'
if (OUT !== '') writeFileSync(OUT, out, 'utf8')
process.stdout.write(text)
if (OUT !== '') process.stdout.write(`  (完整树已写入 ${OUT})\n`)
process.exit(duplicate ? 1 : 0)
