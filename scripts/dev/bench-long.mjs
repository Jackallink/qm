#!/usr/bin/env node
/**
 * 长对话 token 曲线基准：pi vs prime（20 轮连续对话）
 * 每轮记录一个 key-value，历史逐步累积；对比 input/cacheRead/total 曲线。
 * 用法: node scripts/dev/bench-long.mjs
 */
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";

const SECRET = process.env.CORE_SIGNING_SECRET || "qm-dev-signing-secret-for-minions-poc-2026-0801";
const BASE = process.env.QM_CORE_URL || "http://localhost:8081";
const ROUNDS = 20;

// 20 轮渐进任务：记录 key-value（历史自然累积）
const MSGS = Array.from({ length: ROUNDS }, (_, i) => `记录第 ${i + 1} 条：key${i + 1}=value${String.fromCharCode(65 + (i % 26))}`);

function sign(secret, ts, canonical) {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${canonical}`).digest("hex")}`;
}

async function turn(harness, text, threadRef) {
  const path = "/v1/turns";
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: "jakeliu" },
    conversation: { kind: "dm", threadRef, audience: [{ externalId: "jakeliu" }] },
    text,
    harness,
  });
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `POST\n${path}\n${body}`;
  const headers = {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": sign(SECRET, ts, canonical),
    "x-admin-actor": "jakeliu@acme",
  };
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body });
  const wallMs = Date.now() - started;
  const data = await res.json();
  return { status: res.status, wallMs, sessionId: data.sessionId, reply: data.reply ?? "" };
}

// 查询某 session 最新一条 LLM usage（每次 turn 后 DB 里新增一条）
function latestUsage(sessionId) {
  const out = execSync(
    `docker exec qm-dev-postgres psql -U postgres -d qm_dev_781e464198ca -t -A -F "|" -c "SELECT usage_json FROM session_llm_requests WHERE session_id='${sessionId}' ORDER BY created_at DESC LIMIT 1"`,
    { encoding: "utf8" },
  );
  try {
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

async function runSeries(harness) {
  const threadRef = `bench-long-${harness}-${Date.now()}`;
  const rows = [];
  let cumInput = 0, cumOutput = 0, cumCache = 0, cumTotal = 0;
  for (let i = 0; i < MSGS.length; i++) {
    const out = await turn(harness, MSGS[i], threadRef);
    const u = latestUsage(out.sessionId) || {};
    const input = u.input ?? 0, output = u.output ?? 0, cache = u.cacheRead ?? 0;
    cumInput += input; cumOutput += output; cumCache += cache; cumTotal += input + output + cache;
    rows.push({
      round: i + 1, status: out.status, wallMs: out.wallMs,
      input, output, cacheRead: cache,
      total: input + output + cache,
      cumInput, cumOutput, cumCache, cumTotal,
    });
    if (out.status !== 200) console.log(`[${harness}] round ${i + 1} FAILED: ${out.reply.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { harness, threadRef, rows };
}

async function main() {
  console.log(`长对话基准：${ROUNDS} 轮 × pi/prime\n`);
  const pi = await runSeries("pi");
  const prime = await runSeries("prime");

  const show = (label, s) => {
    console.log(`\n=== ${label} ===`);
    console.log("round | input | cacheR | total | cumInput | cumCache | cumTotal | wall");
    for (const r of s.rows) {
      console.log(
        `${String(r.round).padStart(4)} | ${String(r.input).padStart(6)} | ${String(r.cacheRead).padStart(6)} | ${String(r.total).padStart(6)} | ${String(r.cumInput).padStart(8)} | ${String(r.cumCache).padStart(8)} | ${String(r.cumTotal).padStart(8)} | ${r.wallMs}`,
      );
    }
  };
  show("pi", pi);
  show("prime", prime);

  // 汇总对比
  const last = (s) => s.rows[s.rows.length - 1];
  const p = last(pi), q = last(prime);
  console.log("\n=== 20 轮累计对比 ===");
  console.log(`         pi     prime    prime/pi`);
  console.log(`input : ${p.cumInput} vs ${q.cumInput}   = ${(q.cumInput / Math.max(1, p.cumInput)).toFixed(2)}x`);
  console.log(`cache : ${p.cumCache} vs ${q.cumCache}   = ${(q.cumCache / Math.max(1, p.cumCache)).toFixed(2)}x`);
  console.log(`total : ${p.cumTotal} vs ${q.cumTotal}   = ${(q.cumTotal / Math.max(1, p.cumTotal)).toFixed(2)}x`);
  const wallAvg = (s) => Math.round(s.rows.reduce((a, r) => a + r.wallMs, 0) / s.rows.length);
  console.log(`wall  : ${wallAvg(pi)}ms vs ${wallAvg(prime)}ms avg/turn`);

  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/bench-long.json", JSON.stringify({ pi, prime }, null, 2));
  console.log("\n原始数据：/tmp/bench-long.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
