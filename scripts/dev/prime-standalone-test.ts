/**
 * standalone 单测：prime-harness runTurn（不依赖 QM 完整运行）
 * 用法: npx tsgo --noEmit 后直接跑，或
 *   node --experimental-strip-types scripts/dev/prime-standalone-test.ts
 */
import { createPrimeHarness } from "../../src/harness/prime-harness.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../../src/harness/harness.ts";

const PRIME_BIN = "/Users/jakeliu/Workspace/prime-agent/packages/coding-agent/dist/cli.js";

function mockTurn(text: string, opts: { scope?: string } = {}): HarnessTurnInput {
  const scope = opts.scope ?? "person:jakeliu";
  const entries = [] as unknown as HarnessTurnInput["history"];
  return {
    session: { id: "test-session-1", type: "dm" } as unknown as HarnessTurnInput["session"],
    input: text,
    systemPrompt: "You are QM's prime execution engine. Be concise.",
    history: entries,
    tools: {} as unknown as HarnessTurnInput["tools"],
    scopeLabel: scope as unknown as import("../../src/types.ts").ScopeId,
    orgScopeId: "org:acme" as unknown as import("../../src/types.ts").ScopeId,
    emit: async (entry) => entry as unknown as import("../../src/types.ts").SessionEntry,
    recordModelCall: () => {},
    onDelta: (chunk) => process.stdout.write(`\x1b[90m[delta]\x1b[0m ${chunk}\n`),
    onProgress: (p) => console.log(`[progress] toolCalls=${p.toolCalls}`),
  } as HarnessTurnInput;
}

async function main() {
  const harness = createPrimeHarness({
    primeBin: PRIME_BIN,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    sessionDirBase: "/tmp/prime-qm-test",
    contextTokenBudget: 200_000,
  });

  console.log("=== 1. 基本对话 ===");
  const r1 = await harness.turns.runTurn(mockTurn("你好！请用一句话介绍你自己。"));
  console.log("回复:", r1.reply.slice(0, 300));

  console.log("\n=== 2. 多轮（同 scope，上下文延续） ===");
  const r2 = await harness.turns.runTurn(
    mockTurn("记下一个数字：42。之后我会问你。"),
  );
  console.log("回复:", r2.reply.slice(0, 300));
  const r3 = await harness.turns.runTurn(mockTurn("我刚才让你记的数字是什么？只回答数字。"));
  console.log("回复:", r3.reply.slice(0, 300));

  console.log("\n=== 3. 不同 scope 隔离 ===");
  const r4 = await harness.turns.runTurn(
    mockTurn("记下一个数字：99。", { scope: "person:alice" }),
  );
  console.log("回复:", r4.reply.slice(0, 200));
  const r5 = await harness.turns.runTurn(
    mockTurn("我刚才让你记的数字是什么？只回答数字。", { scope: "person:jakeliu" }),
  );
  console.log("回复(应仍为42):", r5.reply.slice(0, 200));

  console.log("\n=== 4. contextTokenBudget ===");
  console.log("budget:", harness.models.contextTokenBudget?.());

  console.log("\n=== 5. close ===");
  await harness.turns.close?.();
  console.log("closed ✓");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
