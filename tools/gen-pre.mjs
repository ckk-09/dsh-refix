#!/usr/bin/env node
/**
 * gen-pre.mjs — dsh-refix 生成式定版（Phase 2 · P0 工程债治理）
 *
 * 以 BASE_FILE（见下方常量，当前为 refix-v1.10.js = 稳定线 base，含 I-1/I-2/I-3/I-5/I-7）
 * 为唯一源，按 @refix-gen 锚点注入 tools/segments/ 下的 pre 线独有段落，生成 refix-v1.1-pre3.js。
 * 稳定线/pre 线自此单源：改公共行为 → 只改 base；改 pre 独有行为 → 只改段落库。
 *
 * 已发布版本（如 refix-v1.08.js）**不得再改** —— 它的 sha256 已被文档与 `--check` 钉死，
 * 改一个注释字节就会让发布哈希失效（2026-09-18 实测踩过：给 v1.08 加锚点导致 37013B→37670B）。
 * 需要新锚点请加到当前稳定线上。
 *
 * 用法：node tools/gen-pre.mjs [版本号，默认 p3.9]
 * 退出码：0 = 生成成功且锚点全部消费；1 = 失败（锚点缺失/残留/版本行未命中）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as f6 from './segments/f6.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ver = process.argv[2] || 'p3.9'
if (!/^p\d+\.\d+$/.test(ver)) fail(`版本号须为 pX.Y 形式，收到: ${ver}`)

function fail(msg) {
  console.error('gen-pre: FAIL — ' + msg)
  process.exit(1)
}

const BASE_FILE = 'refix-v1.10.js' // base = 当前稳定线（单源：base 改一处，两条线同步受益）
const base = readFileSync(join(root, 'versions', BASE_FILE), 'utf8')
const lines = base.split('\n')

// 锚点 → 段落。interval/ready 特殊：标记行连同 base 中被替换的语句行一起吞掉。
const SEGMENTS = {
  constants: f6.constants,
  state: f6.state,
  'selfcheck-update': f6.selfcheckUpdate,
  body: f6.body,
  interval: f6.interval,
  events: f6.events,
  ready: f6.ready,
}

const out = []
let consumed = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const m = line.match(/^(\s*)\/\/ @refix-gen:([a-z-]+)(?:（.*)?$/)
  if (!m) { out.push(line); continue }
  const name = m[2]
  if (!(name in SEGMENTS)) fail(`未知锚点 @refix-gen:${name}（段落库缺该段？）`)
  consumed += 1
  if (name === 'interval') {
    // 跳过紧随的 base interval 单行（唯一性由下方命中计数保证）
    const next = lines[i + 1] || ''
    if (!/ctx\.interval\(function \(\) \{ patrolSafe\('interval:' \+ PATROL_PERIOD_MS \+ 'ms'\) \}, PATROL_PERIOD_MS\)/.test(next)) {
      fail('@refix-gen:interval 锚点后未命中 base interval 单行 —— base 结构已漂移，禁止盲替')
    }
    i += 1 // 吞掉 base interval 行
  }
  if (name === 'ready') {
    // 吞掉 base 3 行就绪日志语句（console.log + contract 三元行 + baseline/patrol 行），逐行验签防漂移
    const b1 = lines[i + 1] || ''
    const b2 = lines[i + 2] || ''
    const b3 = lines[i + 3] || ''
    if (!/console\.log\('dsh-refix ' \+ REFIX_VERSION \+ ' ready; contract '/.test(b1)
      || !/contractMissing\.length === 0/.test(b2)
      || !/baseline plugins:/.test(b3)
      || !/patrol every/.test(b3)) {
      fail('@refix-gen:ready 锚点后未命中 base 就绪日志 3 行 —— base 结构已漂移，禁止盲替')
    }
    i += 3
  }
  out.push(SEGMENTS[name])
}

let text = out.join('\n')

// 版本参数化
const versionRe = /const REFIX_VERSION = 'p\d+\.\d+'/
if (!versionRe.test(text)) fail('base 未命中 REFIX_VERSION 行')
text = text.replace(versionRe, `const REFIX_VERSION = '${ver}'`)

// 残留锚点检查（全部必须被消费）
if (text.includes('@refix-gen:')) fail('存在未消费的 @refix-gen 锚点 —— base 与段落库失配')

// 头部横幅。f6.banner 里的基线名是写死的旧串，这里把它改写成真正的 BASE_FILE
// —— 横幅会原样进入生成物，改这里等于改产物字节，所以只做「旧串→BASE_FILE」这一个替换，
// 不顺手改 f6.mjs 里的措辞（那会改动已被审查过的 pre3）。
text = f6.banner.replace('versions/refix-v1.08.js', 'versions/' + BASE_FILE) + text

const dest = join(root, 'versions', `refix-v1.1-pre3.js`)
writeFileSync(dest, text, 'utf8')
console.log(`gen-pre: OK — versions/refix-v1.1-pre3.js（自报 ${ver}），锚点消费 ${consumed}/7，${text.split('\n').length} 行`)
