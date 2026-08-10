/**
 * 最小沙箱进程会话验证：startProcess → writeStdin → readProcess
 * 用 sh 交互式验证 IO 往返。
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";
import type { ScopeId } from "../../src/types.ts";

async function main() {
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: "qm-sandbox-prime:latest", defaultTimeoutSec: 120 });
  const handle = await sandbox.provision([], { scopeId: "person:jakeliu" as unknown as ScopeId });
  console.log("handle:", handle.id);

  console.log("\n== 1. startProcess (sh 循环 echo) ==");
  const { processId } = await sandbox.startProcess!(handle, "sh -c 'while read l; do echo \"got:$l\"; done'", {});
  console.log("processId:", processId);

  console.log("\n== 2. writeStdin + readProcess ==");
  await sandbox.writeStdin!(handle, processId, "hello sandbox\n");
  const r1 = await sandbox.readProcess!(handle, processId, { sinceCursor: 0, waitMs: 3000 });
  console.log("read1:", JSON.stringify(r1).slice(0, 300));

  await sandbox.writeStdin!(handle, processId, "second line\n");
  const r2 = await sandbox.readProcess!(handle, processId, { sinceCursor: r1.cursor, waitMs: 3000 });
  console.log("read2:", JSON.stringify(r2).slice(0, 300));

  console.log("\n== 3. signalProcess (TERM) ==");
  await sandbox.signalProcess!(handle, processId, "SIGTERM");
  const r3 = await sandbox.readProcess!(handle, processId, { sinceCursor: r2.cursor, waitMs: 3000 });
  console.log("read3 (after TERM):", JSON.stringify(r3).slice(0, 300));

  await sandbox.teardown(handle);
  console.log("\ndone");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
