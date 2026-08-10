#!/usr/bin/env node
/**
 * QM dev API 客户端 — source-auth 签名
 * 用法: node scripts/dev/api.mjs <method> <path> [jsonBody] [--no-body]
 * 示例:
 *   node scripts/dev/api.mjs GET /api/admin/custom-providers
 *   node scripts/dev/api.mjs PUT /api/admin/custom-providers/deepseek '{"name":"DeepSeek",...}'
 */
import { createHmac } from "node:crypto";

const SECRET = process.env.CORE_SIGNING_SECRET || "qm-dev-signing-secret-for-minions-poc-2026-0801";
const ADMIN_ACTOR = process.env.ADMIN_ACTOR || "admin@acme";
const BASE = process.env.QM_CORE_URL || "http://localhost:8081";

const args = process.argv.slice(2);
const method = args[0];
const path = args[1];
let body = args[2];
if (body && body !== "--no-body") {
  // validate JSON
  JSON.parse(body);
}

function sign(secret, timestampSec, canonical) {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:${canonical}`).digest("hex")}`;
}

async function main() {
  const url = new URL(path, BASE);
  const nowSec = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${path}\n${body ?? ""}`;
  const headers = {
    "content-type": "application/json",
    "x-timestamp": String(nowSec),
    "x-signature": sign(SECRET, nowSec, canonical),
    "x-admin-actor": ADMIN_ACTOR,
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body && body !== "--no-body" ? body : undefined,
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
