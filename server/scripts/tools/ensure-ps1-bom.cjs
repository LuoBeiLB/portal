/**
 * 确保 .ps1 脚本带 UTF-8 BOM。
 *
 * 为什么需要：Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 文件时会按 ANSI(GBK) 解码，
 * 中文注释里的引号会打乱语法，报出一堆与真实原因无关的 ParserError。
 * 任何编辑 .ps1 的工具（包括 AI 编辑）都可能把 BOM 丢掉，所以改完就重新跑一次这个脚本。
 *
 * 用法（在 portal/server 下）：node scripts/tools/ensure-ps1-bom.cjs
 *
 * 2026-10-13：改为**递归扫描 scripts/ 全部子目录** —— 脚本分层后 .ps1 在 scripts/e2e/ 下，
 * 原来只扫 scripts/ 顶层会漏掉，而漏掉的后果是"改了 .ps1 却没人补 BOM"。
 */
const { readdirSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIR = join(process.cwd(), 'scripts');

/** 递归收集 scripts/ 下所有 .ps1 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.ps1')) out.push(p);
  }
  return out;
}

let fixed = 0;
let ok = 0;

const files = collect(DIR);
if (files.length === 0) {
  console.log(`  ⚠ ${DIR} 下没有找到任何 .ps1`);
}

for (const file of files) {
  const label = file.slice(DIR.length + 1).replace(/\\/g, '/');
  const buf = readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  if (hasBom) {
    console.log(`  = ${label}（已有 BOM）`);
    ok += 1;
    continue;
  }

  // 关键：先按 UTF-8 解码成字符串，再带 BOM 写回，避免在字节层面重复插入
  const text = buf.toString('utf8');
  writeFileSync(file, Buffer.concat([BOM, Buffer.from(text, 'utf8')]));
  console.log(`  + ${label}（已补 BOM）`);
  fixed += 1;
}

console.log(`\n已有 BOM ${ok} 个，本次补齐 ${fixed} 个`);
