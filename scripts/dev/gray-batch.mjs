#!/usr/bin/env node
/** 灰度批量：org 默认 runtime=prime，5 任务各 2 轮，记录耗时/成功率 */
import { createHmac } from "node:crypto";
const SECRET = process.env.CORE_SIGNING_SECRET || "qm-dev-signing-secret-for-minions-poc-2026-0801";
const BASE = "http://localhost:8081";
const TASKS = [
  { id: "qa", text: "什么是 RLM？一句话解释。" },
  { id: "code", text: "写一个 Python 函数 fibonacci(n)，包含类型注解。" },
  { id: "review", text: "审查：def calc(l):\n  s=0\n  for x in l:\n    s=s+x\n  return s\n  print(s)。指出 bug。" },
  { id: "reason", text: "一个 5 人团队要部署新微服务，列出 3 个关键步骤。" },
  { id: "summary", text: "用 2 句话总结：AI 正从单机工具走向组织级部署，企业需要安全可控的平台。" },
];

function sign(secret, ts, canonical) {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${canonical}`).digest("hex")}`;
}

async function turn(text, threadRef) {
  const body = JSON.stringify({ surface: "web", actor: { externalId: "jakeliu" }, conversation: { kind: "dm", threadRef, audience: [{ externalId: "jakeliu" }] }, text });
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `POST\n/v1/turns\n${body}`;
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/turns`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sign(SECRET, ts, canonical), "x-admin-actor": "jakeliu@acme" }, body });
  const wallMs = Date.now() - started;
  const data = await res.json();
  return { status: res.status, wallMs, text: (data.reply ?? "").slice(0, 80) };
}

async function main() {
  const results = [];
  for (const task of TASKS) {
    for (let r = 0; r < 2; r++) {
      const out = await turn(task.text, `gray-batch-${task.id}-${r}`);
      results.push({ task: task.id, ...out });
      const tag = out.status === 200 ? "OK" : `ERR(${out.status})`;
      console.log(`[${tag}] ${task.id} r${r}: ${out.wallMs}ms | ${out.text.slice(0,60)}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const ok = results.filter(r => r.status === 200);
  const walls = ok.map(r => r.wallMs).sort((a,b)=>a-b);
  const median = walls[Math.floor(walls.length/2)];
  console.log(`\n=== 汇总 === ok=${ok.length}/${results.length} median=${median}ms avg=${Math.round(ok.reduce((s,r)=>s+r.wallMs,0)/ok.length)}ms`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/gray-batch.json", JSON.stringify(results));
  console.log("→ /tmp/gray-batch.json");
}
main().catch(e => { console.error(e); process.exit(1); });
