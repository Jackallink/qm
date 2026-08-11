#!/usr/bin/env node
/**
 * Skill 完整性校验 — 验证本地 skill 与 clawhub 安装时的 fingerprint 一致。
 * 用法: node scripts/verify-skill.mjs <skill-dir>
 * 退出码: 0 = 一致, 1 = 不一致/文件缺失
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const skillDir = process.argv[2] || ".";
const originFile = join(skillDir, ".clawhub", "origin.json");

// 1. 读安装时的 fingerprint
let expected;
try {
  expected = JSON.parse(readFileSync(originFile, "utf8")).fingerprint;
} catch {
  console.error("❌ 缺少 .clawhub/origin.json — 请用 clawhub install 安装");
  process.exit(1);
}

// 2. 递归收集所有文件
function collectFiles(dir, base = dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith(".clawhub")) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectFiles(full, base));
    } else {
      const bytes = readFileSync(full);
      result.push({
        path: relative(base, full),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return result;
}

// 3. 复算 fingerprint（与 clawhub 同算法）
const files = collectFiles(skillDir)
  .sort((a, b) => a.path.localeCompare(b.path));
const payload = files.map((f) => `${f.path}:${f.sha256}`).join("\n");
const actual = createHash("sha256").update(payload).digest("hex");

// 4. 比对
if (actual !== expected) {
  console.error(`❌ 完整性校验失败`);
  console.error(`   期望: ${expected.slice(0, 16)}...`);
  console.error(`   实际: ${actual.slice(0, 16)}...`);
  console.error(`   文件数: ${files.length}`);
  process.exit(1);
}

console.log(`✅ 校验通过 (${files.length} 文件, ${actual.slice(0, 12)}…)`);
process.exit(0);
