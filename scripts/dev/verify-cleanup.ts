/**
 * 手动验证：清理残留 + 一次性管道 get_state（QM 沙箱）
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";

const log = (m: string) => process.stderr.write(`[v] ${m}\n`);

async function main() {
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: "qm-sandbox-prime:latest", defaultTimeoutSec: 60 });
  const handle = await sandbox.provision([], {});
  log(`handle: ${handle.id}`);

  const cleanup =
    'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *prime-agent*|*bundle/cli.js*) kill -9 "${p#/proc/}" 2>/dev/null ;; esac; done; rm -rf /tmp/prime-agent-0 "$HOME/.prime/agent/daemon-workers" 2>/dev/null';
  const cmd =
    `${cleanup}; echo '{"type":"get_state"}' | DEEPSEEK_API_KEY=xx node /opt/prime-agent/dist/bundle/cli.js --mode rpc --no-session 2>&1 | head -c 300`;
  const r = await sandbox.run(handle, cmd, { timeoutMs: 60_000 });
  log(`exit: ${r.code} | out: ${JSON.stringify((r.stdout ?? "").slice(0, 300))}`);

  await sandbox.teardown(handle).catch(() => undefined);
  log("done");
}

main().catch((e) => {
  log("FAIL: " + (e as Error).stack);
  process.exit(1);
});
