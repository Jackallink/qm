#!/usr/bin/env node
/**
 * /refine 回流验证：prime refine 产物 → QM skill 仓库
 * 1. spawn prime RPC（连 scope sessionDir）
 * 2. 触发 refine（基于已有会话轨迹）
 * 3. 读 harness state 提取 skill 类型 entries
 * 4. POST /v1/skills 导入 QM
 * 用法: node --experimental-strip-types scripts/dev/refine-sync.ts [--dry-run]
 */
import { PrimeRpcClient } from "../../src/harness/prime-rpc-client.ts";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const PRIME_BIN = "/Users/jakeliu/Workspace/prime-agent/packages/coding-agent/dist/cli.js";
const SESSION_DIR = "/tmp/qm-prime-sessions/personal_jakeliu";
const SECRET = process.env.CORE_SIGNING_SECRET || "qm-dev-signing-secret-for-minions-poc-2026-0801";
const BASE = process.env.QM_CORE_URL || "http://localhost:8081";
const DRY = process.argv.includes("--dry-run");

function sign(secret: string, ts: number, canonical: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${canonical}`).digest("hex")}`;
}

async function qmPost(path, body) {
  const b = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `POST\n${path}\n${b}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": sign(SECRET, ts, canonical),
      "x-admin-actor": "jakeliu@acme",
    },
    body: b,
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log("== 1. spawn prime RPC（scope 会话） ==");
  const client = new PrimeRpcClient({
    cliPath: PRIME_BIN,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionDir: SESSION_DIR,
  });
  await client.start();
  const state = await client.getState();
  console.log("sessionId:", state.sessionId, "| messageCount:", state.messageCount);

  console.log("\n== 1.5 产生编码轨迹（供 refine 沉淀） ==");
  const t1 = await client.promptAndCollect(
    "写一个 Python 模块 utils.py：包含 dedupe(list)、chunk(list, n)、retry(fn, times) 三个函数，带类型注解和 docstring。",
    { timeoutMs: 180_000 },
  );
  console.log("turn1 完成:", t1.reply.slice(0, 60));
  const t2 = await client.promptAndCollect(
    "为 utils.py 写一个简单的 pytest 测试文件 test_utils.py，覆盖三个函数。",
    { timeoutMs: 180_000 },
  );
  console.log("turn2 完成:", t2.reply.slice(0, 60));

  console.log("\n== 2. 触发 refine ==");
  const refineRes = await client.send({ type: "refine", instructions: "请沉淀本次会话中值得复用的编码经验为 skill。" }, { timeoutMs: 600_000 });
  console.log("refine success:", refineRes.success);
  if (!refineRes.success) {
    console.log("error:", refineRes.error);
    await client.stop();
    process.exit(1);
  }
  const data = refineRes.data;
  console.log("refine id:", data?.id);
  console.log("summary:", (data?.summary ?? "").slice(0, 200));
  console.log("harnessStatePath:", data?.harnessStatePath);
  console.log("appliedEdits:", (data?.appliedEdits ?? []).length);

  console.log("\n== 3. 读取 harness state，提取 skill entries ==");
  let skills = [];
  try {
    const raw = readFileSync(data.harnessStatePath, "utf8");
    const hs = JSON.parse(raw);
    const skillEntries = Object.values(hs.entries?.skill ?? {});
    console.log("skill entries:", skillEntries.length);
    for (const e of skillEntries.slice(0, 5)) {
      console.log(`- [${e.scope ?? "local"}] ${e.title} (${(e.content ?? "").length} chars)`);
      skills.push(e);
    }
  } catch (e) {
    console.log("harness state 读取失败:", e.message);
  }

  console.log("\n== 4. 导入 QM skills ==");
  for (const s of skills) {
    const payload = {
      principalId: "jakeliu",
      scopeId: "personal:jakeliu",
      name: s.title.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").slice(0, 60),
      description: (s.metadata?.description ?? s.title ?? "").slice(0, 200),
      body: s.content ?? "",
    };
    if (DRY) {
      console.log(`[dry-run] would import: ${payload.name}`);
      continue;
    }
    const r = await qmPost("/v1/skills", payload);
    console.log(`import '${payload.name}' → HTTP ${r.status}`, r.body?.id ? `(id: ${r.body.id})` : JSON.stringify(r.body).slice(0, 120));
  }

  await client.stop();
  console.log("\n完成");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
