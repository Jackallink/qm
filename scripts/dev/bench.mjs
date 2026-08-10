#!/usr/bin/env node
/**
 * 效率对比基线：pi harness vs prime harness（QM 路径实测）
 * 用法: node scripts/dev/bench.mjs [--runs 2]
 */
import { createHmac } from "node:crypto";

const SECRET = process.env.CORE_SIGNING_SECRET || "qm-dev-signing-secret-for-minions-poc-2026-0801";
const BASE = process.env.QM_CORE_URL || "http://localhost:8081";
const RUNS = Number(process.argv[2] ?? 2);

const TASKS = [
  { id: "qa-simple", text: "请用一句话解释什么是递归语言模型（RLM）。" },
  {
    id: "code-gen",
    text: "写一个 Python 函数 binary_search(arr, target)，返回目标索引或 -1，包含类型注解和 docstring。只输出代码。",
  },
  {
    id: "code-review",
    text: "审查这段代码的问题：\ndef calc(nums):\n  total = 0\n  for n in nums:\n    total = total + n\n    return total\n指出至少 2 个 bug。",
  },
  {
    id: "reasoning",
    text: "假设要在一个 5 人团队中部署一个需要 Postgres 和 Redis 的新服务。列出部署步骤和主要风险，最多 5 步。",
  },
  {
    id: "summarize",
    text: "请用 3 句话总结这段话：Agentic AI 正从单机工具走向组织级部署。企业需要的不只是更聪明的模型，而是能把聪明的 agent 安全地放进公司组织、并证明其 ROI 的平台。QM 提供多租户隔离、审计、预算和沙箱；Prime Agent 提供递归子 agent、持久 IPython 和自改进能力。两者共享 pi 底座，天然互补。集成后，组织层管安全地干什么，执行层管把活干聪明。",
  },
];

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
  return { status: res.status, wallMs, sessionId: data.sessionId, reply: data.reply ?? "", refused: data.reason };
}

async function main() {
  const results = [];
  for (const task of TASKS) {
    for (const harness of ["pi", "prime"]) {
      for (let r = 0; r < RUNS; r++) {
        const threadRef = `bench-${task.id}-${harness}-${r}-${Date.now()}`;
        const out = await turn(harness, task.text, threadRef);
        results.push({ task: task.id, harness, run: r, ...out });
        const tag = out.status === 200 ? "ok" : `FAIL(${out.status})`;
        console.log(`[${tag}] ${task.id} ${harness} run${r}: ${out.wallMs}ms reply=${out.reply.length}ch`);
        if (out.status !== 200) console.log(`   refused: ${out.refused}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // 汇总
  console.log("\n=== 汇总 ===");
  for (const task of TASKS) {
    const rows = results.filter((x) => x.task === task.id);
    for (const harness of ["pi", "prime"]) {
      const hs = rows.filter((x) => x.harness === harness);
      const ok = hs.filter((x) => x.status === 200);
      const walls = ok.map((x) => x.wallMs).sort((a, b) => a - b);
      const median = walls.length ? walls[Math.floor(walls.length / 2)] : null;
      const avgLen = ok.length ? Math.round(ok.reduce((s, x) => s + x.reply.length, 0) / ok.length) : 0;
      console.log(`${task.id} ${harness}: ok=${ok.length}/${hs.length} median=${median}ms avg_reply=${avgLen}ch`);
    }
  }

  // 输出原始数据供后续查询 token
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/bench-results.json", JSON.stringify(results, null, 2));
  console.log("\n原始结果已存 /tmp/bench-results.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
