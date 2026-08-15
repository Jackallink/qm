/**
 * Claw Agent harness adapter.
 *
 * 对标标书 #5（Claw 类智能体纳管）
 * 模式：复制 hermes-harness.ts — HTTP API adapter + 标准化接入协议。
 *
 * Claw Agent 作为"云端智能体"的一种运行形态，通过 QM harness-router
 * 接入统一控制面。实例注册 → QM Agent Registry；身份绑定 → QM identity；
 * 策略下发 → QM configStore；运行监控 → QM audit_log。
 *
 * Profile:
 *   controlTransport: "json-rpc"
 *   capabilities: abort, steer, images, thinking-level, fast-mode
 */
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";

export interface ClawHarnessOptions {
  /** Claw Agent HTTP API base URL */
  baseUrl?: string;
  /** API 路径 */
  agentPath?: string;
  /** Claw Agent 认证 token */
  apiToken?: string;
  /** 默认模型 */
  model?: string;
  timeoutMs?: number;
}

export function createClawHarness(opts: ClawHarnessOptions = {}): Harness {
  const baseUrl = (opts.baseUrl ?? "http://claw-agent:8080").replace(/\/$/, "");
  const agentPath = opts.agentPath ?? "/api/v1/agent/run";
  const profile = {
    id: "claw" as const,
    controlTransport: "json-rpc" as const,
    toolTransport: "in-process" as const,
    transcriptFormat: "json",
    capabilities: new Set(["abort", "steer", "images", "thinking-level", "fast-mode"] as const),
  };

  const clawCall = async (input: HarnessTurnInput): Promise<HarnessTurnResult> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiToken) headers["Authorization"] = `Bearer ${opts.apiToken}`;

    const body = JSON.stringify({
      session_id: input.session.id,
      scope: input.scopeLabel,
      message: input.input,
      system_prompt: input.systemPrompt,
      model: input.model ?? opts.model ?? "default",
      history: (input.history ?? []).map((e) => {
        const raw = e as unknown as Record<string, unknown>;
        return { role: raw.role ?? "user", content: raw.content ?? "" };
      }),
    });

    const controller = new AbortController();
    if (input.cancel) input.cancel.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const res = await fetch(`${baseUrl}${agentPath}`, { method: "POST", headers, body, signal: controller.signal });
      if (!res.ok) return { reply: `[claw] HTTP ${res.status}`, modelCalls: 0 };
      const data = (await res.json()) as { reply?: string; error?: string; model_calls?: number };
      return { reply: data.reply ?? data.error ?? "[claw] empty", modelCalls: data.model_calls ?? 1 };
    } catch (error) {
      return { reply: `[claw] ${(error as Error).message}`, modelCalls: 0 };
    }
  };

  return defineHarness(
    profile,
    {
      async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> { return clawCall(input); },
      async close(): Promise<void> {},
      contextTokenBudget(): number | undefined { return 200_000; },
    },
    { name: (coreName) => (coreName === "execute" ? "claw_execute" : coreName) },
  );
}
