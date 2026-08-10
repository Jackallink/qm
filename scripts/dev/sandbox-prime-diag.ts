/**
 * 诊断：QM 沙箱内 prime RPC 交互（绕过 harness，直接 sandbox io）
 * 每步用 process.stderr 打点（stderr 无缓冲）。
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";
import { createSandboxProcessIo } from "../../src/harness/prime-rpc-io-sandbox.ts";
import type { ScopeId } from "../../src/types.ts";

const log = (m: string) => process.stderr.write(`[diag] ${m}\n`);

async function main() {
  log("1. workspace + sandbox");
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: "qm-sandbox-prime:latest", defaultTimeoutSec: 60 });
  const handle = await sandbox.provision([], {});
  log(`handle: ${handle.id}`);

  const cmd =
    "node '/opt/prime-agent/dist/bundle/cli.js' --mode rpc --no-session --provider deepseek --model deepseek-v4-flash";
  log(`2. startProcess: ${cmd.slice(0, 60)}...`);
  const io = createSandboxProcessIo({
    sandbox,
    handle,
    command: cmd,
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "", PRIME_AGENT_KERNEL_VENV: "/opt/prime-kernel-venv" },
    pollMs: 500,
  });
  io.onData((chunk) => {
    const types = [...chunk.matchAll(/\{"type":"([a-z_]+)"/g)].map((m) => m[1]);
    log(`data+(${chunk.length}B) types=[${types.join(",")}]`);
    (globalThis as any).__collected = ((globalThis as any).__collected ?? "") + chunk;
  });
  io.onExit((code) => log(`EXIT: ${code}`));
  await io.start();
  log("io started");

  const t0 = Date.now();
  log("3. send prompt");
  io.write(JSON.stringify({ type: "prompt", message: "用 Python 计算 17*23。" }) + "\n");
  await new Promise((r) => setTimeout(r, 150000));
  log("4. done (150s elapsed)");
  const collected = (globalThis as any).__collected ?? "";
  const types = [...collected.matchAll(/\{"type":"([a-z_]+)"/g)].map((m) => m[1]);
  log("事件类型: " + [...new Set(types)].join(", "));
  const hasAgentEnd = types.includes("agent_end");
  log("agent_end 到达: " + hasAgentEnd);
  log("末尾 400 字符: " + collected.slice(-400));
  if (hasAgentEnd) {
    const deltas = [...collected.matchAll(/text_delta[^}]*"delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    log("text: " + deltas.slice(0, 300));
    log("总耗时: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  }
  await io.kill();
  await sandbox.teardown(handle).catch(() => undefined);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[diag] FAIL: ${(e as Error).stack}\n`);
  process.exit(1);
});
