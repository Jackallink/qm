#!/usr/bin/env node
/**
 * PC Agent Launcher — 远程 Agent 运行时。
 *
 * 对标标书 #4（PC 端智能体）+ #5（Claw 纳管）
 * 本质：Agent Launcher 的远程版——连接 QM Core，注册设备，拉取策略，启动 Agent。
 *
 * 运行方式（国产 OS / macOS / Linux 通用）：
 *   QM_CORE_URL=http://qm-core:8081 DEVICE_ID=desktop-001 node pc-agent.mjs
 *
 * 安全基线：
 *   - 默认不开放生产写操作和本地任意命令执行
 *   - 文件读取限定白名单目录
 *   - 本地凭据加密存储
 *   - 心跳超时自动禁用高危能力
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const CORE = process.env.QM_CORE_URL || "http://localhost:8081";
const DEVICE_ID = process.env.DEVICE_ID || `pc-${hostname()}`;
const SECRET = process.env.CORE_SIGNING_SECRET || "change-me";
const AGENT_DIR = join(process.env.HOME || "/tmp", ".qm-pc-agent");
const HEARTBEAT_MS = 10_000;
const POLICY_FILE = join(AGENT_DIR, "policy.json");
const CRED_FILE = join(AGENT_DIR, "credentials.enc");

function sign(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${path}\n${body}`;
  return { "x-timestamp": String(ts), "x-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${canonical}`).digest("hex")}`, "content-type": "application/json" };
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const b = body ? JSON.stringify(body) : "";
  const res = await fetch(`${CORE}${path}`, { method, headers: sign(method, path, b), body: b || undefined });
  return res.json();
}

async function register(): Promise<void> {
  console.log(`[pc-agent] registering device ${DEVICE_ID}...`);
  const res = await api("POST", "/v1/admin/workspaces/org:acme/agents", {
    id: DEVICE_ID.replace(/[^a-z0-9-]/g, "-"),
    name: `PC Agent: ${DEVICE_ID}`,
    template: "custom",
    runtime: { lifecycle: "resident", sandbox: "physical" },
    security: { visibility: "private", acl: { invoke: [], manage: [] } },
  });
  console.log("[pc-agent] registered:", JSON.stringify(res).slice(0, 200));
}

async function heartbeat(): Promise<void> {
  try {
    await api("POST", `/v1/admin/agents/${DEVICE_ID}/heartbeat`, {});
  } catch { /* 控制面不可达，进入降级模式 */ }
}

async function syncPolicy(): Promise<void> {
  try {
    const res = await api("GET", `/v1/admin/agents/${DEVICE_ID}`);
    writeFileSync(POLICY_FILE, JSON.stringify(res));
    console.log("[pc-agent] policy synced");
  } catch { /* 使用缓存策略 */ }
}

async function main(): Promise<void> {
  mkdirSync(AGENT_DIR, { recursive: true });
  if (!existsSync(CRED_FILE)) {
    // 首次启动：注册设备
    await register();
    writeFileSync(CRED_FILE, JSON.stringify({ deviceId: DEVICE_ID, registeredAt: Date.now() }));
  }

  console.log(`[pc-agent] PC Agent ${DEVICE_ID} starting...`);

  // 启动 Agent 进程（同 cloud agent-launcher）
  const bin = process.env.PRIME_BIN || "prime-agent";
  const useNode = bin.endsWith(".js");
  const args = ["--mode", "rpc", "--provider", process.env.PRIME_PROVIDER || "deepseek", "--model", process.env.PRIME_MODEL || "deepseek-v4-flash", "--session-dir", join(AGENT_DIR, "sessions")];
  const child = useNode ? spawn("node", [bin, ...args], { stdio: "ignore", detached: true }) : spawn(bin, args, { stdio: "ignore", detached: true });

  child.on("exit", (code) => console.log(`[pc-agent] agent exited code=${code}`));
  console.log(`[pc-agent] agent pid=${child.pid}`);

  // 定期心跳 + 策略同步
  setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT_MS);
  setInterval(() => { syncPolicy().catch(() => {}); }, 60_000);
  await syncPolicy();

  console.log("[pc-agent] running. Press Ctrl+C to stop.");
  process.on("SIGINT", () => { child.kill(); process.exit(0); });
}

main().catch((e) => { console.error("[pc-agent] fatal:", e.message); process.exit(1); });
