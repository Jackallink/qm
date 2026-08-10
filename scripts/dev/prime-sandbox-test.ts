/**
 * standalone 沙箱验证：prime harness 沙箱模式（QM local sandbox 内跑 prime RPC）
 * 验证：provision 沙箱 → sandbox IO → prime 对话（含 IPython kernel）
 * 用法: DEEPSEEK_API_KEY=sk-xxx node --experimental-strip-types scripts/dev/prime-sandbox-test.ts
 */
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createLocalSandbox } from "../../src/sandbox/local-sandbox.ts";
import { createPrimeHarness } from "../../src/harness/prime-harness.ts";
import type { HarnessTurnInput } from "../../src/harness/harness.ts";
import type { ScopeId } from "../../src/types.ts";

const SANDOX_IMAGE = process.env.PRIME_SANDBOX_IMAGE ?? "qm-sandbox-prime:latest";

function mockTurn(text: string, scope: string): HarnessTurnInput {
  return {
    session: { id: "sandbox-test-session", type: "dm" },
    input: text,
    systemPrompt: "You are QM's prime execution engine running inside a sandbox. Be concise.",
    history: [] as unknown as HarnessTurnInput["history"],
    tools: {} as unknown as HarnessTurnInput["tools"],
    scopeLabel: scope as unknown as ScopeId,
    orgScopeId: "org:acme" as unknown as ScopeId,
    emit: async (entry: import("../../src/types.ts").SessionEntry) => entry,
    recordModelCall: () => {},
  } as unknown as HarnessTurnInput;
}

async function main() {
  console.log(`== 1. workspace + local sandbox（image: ${SANDOX_IMAGE}） ==`);
  const ws = createLocalWorkspaceStore("/tmp/qm-sandbox-ws");
  const sandbox = createLocalSandbox(ws, { image: SANDOX_IMAGE, defaultTimeoutSec: 300 });

  const scope: ScopeId = "person:jakeliu" as unknown as ScopeId;
  console.log("provision 沙箱...");
  const handle = await sandbox.provision([], {});
  console.log("handle:", handle.id, "| backend:", handle.backend, "| rootDir:", handle.rootDir);

  const harness = createPrimeHarness({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "" },
    sandbox: {
      sandbox,
      handleFor: async () => handle,
    },
    contextTokenBudget: 200_000,
  });

  console.log("\n== 2. 沙箱内 prime 对话 ==");
  console.log("[turn1 start]");
  const r1 = await harness.turns.runTurn(
    mockTurn("你好！用 Python 计算 17*23 并把结果写进 /tmp/sandbox-result.txt，然后告诉我结果和当前工作目录。", scope),
  );
  console.log("回复:", r1.reply.slice(0, 300));

  console.log("\n== 3. 多轮（沙箱内上下文延续） ==");
  const r2 = await harness.turns.runTurn(mockTurn("刚才计算的结果是什么？只回答数字。", scope));
  console.log("回复:", r2.reply.slice(0, 200));

  console.log("\n== 4. 沙箱内文件验证（结果应已写入容器内 /tmp/sandbox-result.txt） ==");
  const file = await sandbox.readFile(handle, "sandbox-result.txt").catch(() => null);
  console.log("沙箱内 /tmp/sandbox-result.txt:", file ?? "(工作目录未找到，尝试绝对路径)");
  // 直接 exec 查看
  try {
    const exec = await sandbox.run(handle, "cat /tmp/sandbox-result.txt 2>/dev/null || echo 'not found'");
    console.log("exec cat /tmp/sandbox-result.txt:", (exec.stdout ?? "").trim());
  } catch (e) {
    console.log("exec 失败:", (e as Error).message.slice(0, 120));
  }

  console.log("\n== 5. 清理 ==");
  await sandbox.teardown(handle).catch(() => undefined);
  await harness.turns.close?.();
  console.log("done");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
