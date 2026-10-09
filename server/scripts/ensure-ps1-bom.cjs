/**
 * 确保 .ps1 脚本带 UTF-8 BOM。
 *
 * 为什么需要：Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 文件时会按 ANSI(GBK) 解码，
 * 中文注释里的引号会打乱语法，报出一堆与真实原因无关的 ParserError。
 * 任何编辑 .ps1 的工具（包括 AI 编辑）都可能把 BOM 丢掉，所以改完就重新跑一次这个脚本。
 *
 * 用法：node scripts/ensure-ps1-bom.cjs
 */
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIR = join(process.cwd(), 'scripts');

let fixed = 0;
let ok = 0;

for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.ps1')) continue;
  const file = join(DIR, name);
  const buf = readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  if (hasBom) {
    console.log(`  = ${name}（已有 BOM）`);
    ok += 1;
    continue;
  }

  // 关键：先按 UTF-8 解码成字符串，再带 BOM 写回，避免在字节层面重复插入
  const text = buf.toString('utf8');
  writeFileSync(file, Buffer.concat([BOM, Buffer.from(text, 'utf8')]));
  console.log(`  + ${name}（已补 BOM）`);
  fixed += 1;
}

console.log(`\n已有 BOM ${ok} 个，本次补齐 ${fixed} 个`);
