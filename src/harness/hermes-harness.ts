/**
 * Hermes Agent harness adapter — ACP (Agent Client Protocol) stdio client.
 *
 * Hermes runs `hermes acp` as a JSON-RPC 2.0 stdio server (stdout is the
 * protocol transport, stderr is logs). QM owns the session lifecycle and
 * routing; Hermes owns the agent execution loop. Per-scope Hermes
 * sessions keep context across turns.
 */
import { spawn } from "node:child_process";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";

export interface HermesHarnessOptions {
  /** hermes CLI path (default: "hermes" on PATH). */
  cliPath?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /** Default model (e.g. "deepseek-v4-flash"). */
  model?: string;
  /** Default provider (e.g. "deepseek"). */
  provider?: string;
  /** Per-scope session base dir (multi-tenant boundary). */
  sessionDirBase?: string;
  /** Extra env for the child process. */
  env?: Record<string, string>;
  /** Turn timeout (ms). Default 300s. */
  timeoutMs?: number;
}

interface AcpClient {
  call(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

function createAcpClient(opts: {
  cliPath: string;
  cwd?: string;
  env?: Record<string, string>;
}): AcpClient {
  const child = spawn(opts.cliPath, ["acp"], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  let nextId = 0;
  const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "hermes ACP error"));
        else p.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
    }
  });
  child.on("exit", (code) => {
    const err = new Error(`hermes ACP exited (code ${code})`);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  });
  return {
    call(method, params, timeoutMs = 300_000): Promise<Record<string, unknown>> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`hermes ACP ${method} timed out (${timeoutMs}ms)`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async stop(): Promise<void> {
      if (child.exitCode === null) child.kill();
    },
  };
}

export function createHermesHarness(opts: HermesHarnessOptions = {}): Harness {
  const cliPath = opts.cliPath ?? "hermes";
  const sessionDirBase = opts.sessionDirBase ?? "/tmp/hermes-sessions";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const clients = new Map<string, AcpClient>();
  const sessionIds = new Map<string, string>();

  const profile = {
    id: "hermes" as const,
    controlTransport: "json-rpc" as const,
    toolTransport: "in-process" as const,
    transcriptFormat: "json",
    capabilities: new Set(["abort", "steer", "thinking-level", "fast-mode"] as const),
  };

  const scopeDir = (scope: string): string => {
    const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${sessionDirBase.replace(/\/$/, "")}/${safe}`;
  };

  const clientFor = async (scope: string): Promise<AcpClient> => {
    let client = clients.get(scope);
    if (!client) {
      client = createAcpClient({ cliPath, cwd: scopeDir(scope), env: opts.env });
      await client.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: "qm", title: "QM Agent", version: "1" },
      }, 30_000);
      clients.set(scope, client);
    }
    return client;
  };

  const sessionFor = async (scope: string): Promise<string> => {
    let id = sessionIds.get(scope);
    if (!id) {
      const client = await clientFor(scope);
      const res = await client.call("session/new", { cwd: scopeDir(scope), mcpServers: [] }, 60_000);
      id = String((res as { sessionId?: string }).sessionId ?? "");
      if (!id) throw new Error("hermes ACP did not return a sessionId");
      sessionIds.set(scope, id);
    }
    return id;
  };

  const teardown = async (): Promise<void> => {
    await Promise.allSettled([...clients.values()].map((c) => c.stop()));
    clients.clear();
    sessionIds.clear();
  };

  const runTurn = async (input: HarnessTurnInput): Promise<HarnessTurnResult> => {
    const scope = input.scopeLabel;
    const client = await clientFor(scope);
    const sessionId = await sessionFor(scope);
    const abortController = input.cancel;
    const abortPromise = abortController
      ? new Promise<never>((_, reject) =>
          abortController.addEventListener(
            "abort",
            () => {
              void client.call("session/abort", { sessionId }).catch(() => undefined);
              reject(new Error("aborted"));
            },
            { once: true },
          ),
        )
      : null;

    const promptParams = {
      sessionId,
      prompt: [{ type: "text", text: input.input }],
      ...(input.model ? { model: { provider: opts.provider ?? "deepseek", model: input.model } } : {}),
    };
    try {
      const started = Date.now();
      const result = await Promise.race([
        client.call("session/prompt", promptParams, timeoutMs),
        ...(abortPromise ? [abortPromise] : []),
      ]);
      const text = String((result as { text?: unknown }).text ?? "");
      input.onDelta?.(text.slice(0, 100));
      input.recordLlmRequest?.({
        turnSeq: null,
        step: 0,
        model: input.model ?? "hermes",
        request: { prompt: input.input },
        truncated: false,
        durationMs: Date.now() - started,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
      });
      return { reply: text.trim(), modelCalls: 1 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.cancel?.aborted) return { reply: "", stopped: true, modelCalls: 0 };
      throw error;
    }
  };

  return defineHarness(profile, {
    runTurn,
    close: teardown,
    resetSession: async () => {
      await teardown();
    },
  });
}
