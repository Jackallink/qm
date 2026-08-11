/**
 * 最小验证：PrimeRpcClient + sandbox-one-shot io 直接跑 prompt
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";
import { PrimeRpcClient } from "../../src/harness/prime-rpc-client.ts";
import { createSandboxOneShotIo } from "../../src/harness/prime-rpc-io-sandbox.ts";

const log = (m: string) => process.stderr.write(`[t] ${m}\n`);

async function main() {
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: "qm-sandbox-prime:latest", defaultTimeoutSec: 60 });
  const handle = await sandbox.provision([], {});
  log(`handle: ${handle.id}`);

  const io = createSandboxOneShotIo({
    sandbox,
    handle,
    command:
      "stdbuf -oL node /opt/prime-agent/dist/bundle/cli.js --mode rpc --no-session --provider deepseek --model deepseek-v4-flash --session-dir /root/harness-sessions --continue",
    envPrefix: `DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY ?? ""} PRIME_AGENT_KERNEL_VENV=/opt/prime-kernel-venv`,
    timeoutMs: 180_000,
  });
  const client = new PrimeRpcClient({
    cliPath: "unused",
    io,
    onEvent: (e) => {
      const ev = e as { type: string; assistantMessageEvent?: { type: string; delta?: string } };
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        process.stderr.write(ev.assistantMessageEvent.delta ?? "");
      }
    },
  });

  log("client.start()");
  await client.start();

  log("turn1: 记住 42");
  const types = new Set<string>();
  const origOnEvent = (io as any).options ? undefined : undefined;
  // 观察事件类型：临时订阅
  const watch = (e: any) => { types.add((e as any).type); };
  const prevEvt = (client as any).options.onEvent;
  (client as any).options.onEvent = (e: any) => { watch(e); prevEvt?.(e); };
  const r1 = await client.promptAndCollect("记住数字 42。", { timeoutMs: 180_000 }).catch((e) => ({ reply: "ERR:" + (e as Error).message, events: [], toolCalls: 0 }));
  (client as any).options.onEvent = prevEvt;
  log(`turn1 reply: ${(r1 as any).reply.slice(0, 120)}`);
  log("turn1 事件类型: " + [...types].join(","));

  log("turn2: 问数字");
  const types2 = new Set<string>();
  const watch2 = (e: any) => { types2.add((e as any).type); };
  const prevEvt2 = (client as any).options.onEvent;
  (client as any).options.onEvent = (e: any) => { watch2(e); prevEvt2?.(e); };
  const r2 = await client.promptAndCollect("刚才的数字是什么？只回答数字。", { timeoutMs: 180_000 }).catch((e) => ({ reply: "ERR:" + (e as Error).message, events: [], toolCalls: 0 }));
  (client as any).options.onEvent = prevEvt2;
  log("turn2 事件类型: " + [...types2].join(","));
  log(`turn2 reply: ${r2.reply.slice(0, 120)}`);

  await client.stop();
  await sandbox.teardown(handle).catch(() => undefined);
  log("done");
}

main().catch((e) => {
  log("FAIL: " + (e as Error).stack);
  process.exit(1);
});
