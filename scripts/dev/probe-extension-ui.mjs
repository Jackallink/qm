#!/usr/bin/env node
/**
 * 验证 prime-agent 扩展 → extension_ui_request(select) 的协议链路。
 * 用法: node scripts/dev/probe-extension-ui.mjs
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";

const cliPath = "/Users/jakeliu/Workspace/prime-agent/packages/coding-agent/dist/cli.js";
const extPath = new URL("./test-extensions/permission-gate.mjs", import.meta.url).pathname;

const child = spawn(
  "node",
  [cliPath, "--mode", "rpc", "--provider", "deepseek", "--model", "deepseek-v4-flash", "--no-session", "--extension", extPath],
  { cwd: "/tmp", env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
);

const decoder = new StringDecoder("utf8");
let buffer = "";
let reqId = 0;
const pending = new Map();
const uiRequests = [];

function onLine(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return;
  }
  if (data.type === "response" && data.id && pending.has(data.id)) {
    pending.get(data.id).resolve(data);
    pending.delete(data.id);
    return;
  }
  if (data.type === "extension_ui_request") {
    console.log(`[extension_ui] ${data.method}: ${(data.title ?? data.message ?? "").slice(0, 80)}`);
    uiRequests.push(data);
    // 模拟 QM 审批：先 cancel
    if (["select", "confirm", "input", "editor"].includes(data.method)) {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: data.id, cancelled: true }) + "\n");
    }
    return;
  }
  if (data.type === "message_update" && data.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(data.assistantMessageEvent.delta);
  }
  if (data.type === "tool_execution_start") console.log(`\n[tool] ${data.toolName}`);
  if (data.type === "agent_end") console.log("\n[agent_end]");
}

child.stdout.on("data", (c) => {
  buffer += decoder.write(c);
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) onLine(line);
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

function send(cmd) {
  return new Promise((resolve) => {
    const id = `req_${++reqId}`;
    pending.set(id, { resolve });
    child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

await sleep(1000);
console.log("== prompt: 执行 rm -rf /tmp/test-dir（应触发 select） ==");
const r = await send({ type: "prompt", message: "执行命令：rm -rf /tmp/qm-prime-ui-test-dir。只执行这一步。" });
console.log("prompt:", JSON.stringify(r).slice(0, 120));

await sleep(30000);
console.log(`\n== extension_ui 请求数: ${uiRequests.length} ==`);
child.kill("SIGTERM");
process.exit(0);
