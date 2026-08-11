/**
 * 方案 C 验证：一次性管道 + --continue 多轮上下文（原始输出）
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";

const log = (m: string) => process.stderr.write(`[bench] ${m}\n`);
const ENV = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "", PRIME_AGENT_KERNEL_VENV: "/opt/prime-kernel-venv" };

async function runTurn(sandbox: any, handle: any, message: string, extraArgs: string): Promise<string> {
  const envPrefix = `DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY ?? ""} PRIME_AGENT_KERNEL_VENV=/opt/prime-kernel-venv`;
  const cmd =
    `echo '${JSON.stringify({ type: "prompt", message })}' | ` +
    `${envPrefix} stdbuf -oL node /opt/prime-agent/dist/bundle/cli.js --mode rpc --no-session --provider deepseek --model deepseek-v4-flash ${extraArgs} ` +
    `2>/dev/null | tail -c 2500`;
  const t0 = Date.now();
  const r = await sandbox.run(handle, cmd, { env: ENV, timeoutMs: 300_000 });
  return `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${(r.stdout ?? "").slice(0, 800)}`;
}

async function main() {
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: "qm-sandbox-prime:latest", defaultTimeoutSec: 60 });
  const handle = await sandbox.provision([], {});
  log(`handle: ${handle.id}`);
  log("turn1: 记住 42");
  log(await runTurn(sandbox, handle, "记住数字 42。", "--session-dir /root/bench-sessions"));
  log("turn2: 问数字（--continue）");
  log(await runTurn(sandbox, handle, "刚才让你记住的数字是什么？只回答数字。", "--session-dir /root/bench-sessions --continue"));
  await sandbox.teardown(handle).catch(() => undefined);
  log("done");
}

main().catch((e) => {
  log("FAIL: " + (e as Error).stack);
  process.exit(1);
});
