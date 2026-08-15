/**
 * Hermes Agent harness adapter.
 *
 * Hermes is an external agent execution engine with its own HTTP API.
 * This adapter wraps it as a first-class QM harness — same pattern as
 * the opencode / codex / claude adapters: QM owns the session lifecycle
 * and routing, Hermes owns the agent execution loop.
 *
 * Profile:
 *   controlTransport: "json-rpc" (Hermes speaks JSON over HTTP/stdio)
 *   toolTransport:    "in-process" (tools are provided by QM, not Hermes)
 *   capabilities:     abort, steer, images, thinking-level, fast-mode
 */
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";

export interface HermesHarnessOptions {
  /** Base URL of the deployed Hermes engine (e.g. http://hermes:8080). */
  baseUrl?: string;
  /** Hermes agent endpoint (default: /api/v1/agent/run). */
  agentPath?: string;
  /** Default model id for Hermes. */
  model?: string;
  /** API key for Hermes (if authentication is required). */
  apiKey?: string;
  /** HTTP timeout for turn execution (ms). */
  timeoutMs?: number;
}

export function createHermesHarness(opts: HermesHarnessOptions = {}): Harness {
  const baseUrl = (opts.baseUrl ?? "http://hermes:8080").replace(/\/$/, "");
  const agentPath = opts.agentPath ?? "/api/v1/agent/run";
  const profile = {
    id: "hermes" as const,
    controlTransport: "json-rpc" as const,
    toolTransport: "in-process" as const,
    transcriptFormat: "json",
    capabilities: new Set(["abort", "steer", "images", "thinking-level", "fast-mode"] as const),
  };

  const hermesCall = async (
    input: HarnessTurnInput,
  ): Promise<HarnessTurnResult> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    };

    // Map QM's turn model to Hermes' agent run API.
    const body = JSON.stringify({
      session_id: input.session.id,
      scope: input.scopeLabel,
      message: input.input,
      system_prompt: input.systemPrompt,
      history: (input.history ?? []).map((e) => {
        const raw = e as unknown as Record<string, unknown>;
        return { role: raw.role ?? "user", content: raw.content ?? "" };
      }),
      model: input.model ?? opts.model ?? "default",
      thinking_level: input.thinkingLevel,
      fast_mode: input.fastMode,
      tools: [], // tools are QM-side for the MVP; Hermes can receive them later
    });

    const controller = new AbortController();
    if (input.cancel) {
      input.cancel.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch(`${baseUrl}${agentPath}`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          reply: `[hermes] agent call failed: HTTP ${res.status}`,
          modelCalls: 0,
        };
      }

      const data = (await res.json()) as {
        reply?: string;
        status?: string;
        error?: string;
        model_calls?: number;
        pending_approvals?: Array<{
          command: string;
          reason: string;
          kind?: "approval";
        }>;
      };

      return {
        reply: data.reply ?? data.error ?? "[hermes] empty response",
        modelCalls: data.model_calls ?? 1,
        ...(data.pending_approvals?.length
          ? { pendingApprovals: data.pending_approvals }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reply: `[hermes] agent call failed: ${message}`,
        modelCalls: 0,
      };
    }
  };

  return defineHarness(
    profile,
    {
      async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
        const started = Date.now();
        const result = await hermesCall(input);

        // Emit a fake delta so the UI doesn't look stuck (Hermes response is
        // not streamed in the MVP — future: SSE streaming).
        if (result.reply && !result.reply.startsWith("[hermes]")) {
          // chunk-wise onDelta for basic UX
          for (let i = 0; i < result.reply.length; i += 100) {
            input.onDelta?.(result.reply.slice(i, i + 100));
          }
        }

        // Record model call for audit/budget
        if (input.recordLlmRequest) {
          const rec = input.recordLlmRequest;
          void (rec as (r: unknown) => unknown)({
            turnSeq: null,
            step: 0,
            model: input.model ?? opts.model ?? "hermes",
            request: { prompt: input.input },
            truncated: false,
            durationMs: Date.now() - started,
          });
        }

        return result;
      },

      async close(): Promise<void> {
        // Hermes is externally managed — no local process to tear down.
      },

      contextTokenBudget(): number | undefined {
        return 200_000;
      },
    },
    {
      name: (coreName) => (coreName === "execute" ? "hermes_execute" : coreName),
    },
  );
}
