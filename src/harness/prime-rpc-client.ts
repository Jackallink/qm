/**
 * Prime Agent RPC client (JSONL over stdio).
 *
 * A focused, dependency-free client for the prime-agent `--mode rpc` protocol:
 * commands are JSON lines on stdin, responses and events are JSON lines on
 * stdout. Framing is LF-only; unlike node readline we never split on the
 * Unicode separators (U+2028/U+2029) that may legitimately appear inside a
 * JSON string payload.
 *
 * Reference: PrimeIntellect-ai/prime-agent packages/coding-agent/src/modes/rpc/
 *   - rpc-types.ts  (command / response / event shapes)
 *   - rpc-mode.ts   (server behavior: prompt ack + async event stream)
 *   - rpc-client.ts (official typed client this is a trimmed port of)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface PrimeRpcClientOptions {
  /** CLI entry point. If it ends with .js/.mjs it is run via `node`, else exec directly. */
  cliPath: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Provider (e.g. "deepseek", "anthropic"). */
  provider?: string;
  /** Model id (e.g. "deepseek-v4-flash"). */
  model?: string;
  /** Per-scope session directory (multi-tenant file boundary). */
  sessionDir?: string;
  /** Replace the default system prompt (QM org soul / harness prompt). */
  systemPrompt?: string;
  /** Additional CLI args. */
  args?: string[];
  env?: Record<string, string>;
  /** Receive extension UI requests (approval bridge). Return a response value to answer. */
  onExtensionUiRequest?: (request: RpcExtensionUiRequest) => void | Promise<void>;
  /** Called for every inbound event (streaming progress). */
  onEvent?: (event: PrimeAgentEvent) => void;
  /** Called for daemon/observe wrapped events. */
  onObservedSessionEvent?: (event: unknown) => void;
}

export interface PrimeRpcSendOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Wire types (subset of prime-agent rpc-types.ts)
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "refine"; instructions?: string; rollbackId?: string; global?: boolean }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "observe"; activeSessionId: string }
  | { id?: string; type: "unobserve"; activeSessionId: string };

export type RpcResponse = { id?: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string };

export type RpcExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor"; title: string; options?: string[]; message?: string; placeholder?: string; prefill?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text"; [k: string]: unknown };

export type PrimeAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown[] }
  | { type: "message_start"; message?: unknown }
  | { type: "message_update"; message?: unknown; assistantMessageEvent?: { type: string; delta?: string; [k: string]: unknown } }
  | { type: "message_end"; message?: unknown }
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId?: string; toolName?: string; partialResult?: unknown }
  | { type: "tool_execution_end"; toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "session_action_update"; [k: string]: unknown }
  | { [k: string]: unknown };

// ---------------------------------------------------------------------------
// JSONL framing (LF-only, mirrors prime-agent jsonl.ts)
// ---------------------------------------------------------------------------

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachJsonlLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  let pendingLength = 0;
  const emitLine = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const resetPending = () => {
    pending = [];
    pendingLength = 0;
  };
  const appendPending = (segment: string) => {
    if (segment.length === 0) return;
    pending.push(segment);
    pendingLength += segment.length;
  };
  const emitFrom = (segment: string) => {
    appendPending(segment);
    if (pendingLength === 0) return;
    emitLine(pending.join(""));
    resetPending();
  };
  const onData = (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    let newlineIndex = text.indexOf("\n");
    while (newlineIndex !== -1) {
      emitFrom(text.slice(start, newlineIndex));
      start = newlineIndex + 1;
      newlineIndex = text.indexOf("\n", start);
    }
    if (start < text.length) appendPending(text.slice(start));
  };
  const onEnd = () => {
    const tail = decoder.end();
    if (tail.length > 0) appendPending(tail);
    if (pendingLength > 0) emitLine(pending.join(""));
    resetPending();
  };
  stream.on("data", onData as (chunk: unknown) => void);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData as (chunk: unknown) => void);
    stream.off("end", onEnd);
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PrimeRpcClient {
  private process: ChildProcess | null = null;
  private stopReadingStdout: (() => void) | null = null;
  private pendingRequests = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private requestId = 0;
  private stderr = "";
  private exitCode: number | null = null;

  private options: PrimeRpcClientOptions;

  constructor(options: PrimeRpcClientOptions) {
    this.options = options;
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  get exitReason(): string {
    return this.stderr.slice(-2000);
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("client already started");
    const args = ["--mode", "rpc"];
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
    if (this.options.systemPrompt) args.push("--system-prompt", this.options.systemPrompt);
    if (this.options.args) args.push(...this.options.args);

    const cliPath = this.options.cliPath;
    const useNode = /\.(js|mjs|cjs)$/.test(cliPath);
    const child: ChildProcess = useNode
      ? spawn("node", [cliPath, ...args], this.spawnOpts())
      : spawn(cliPath, args, this.spawnOpts());
    this.process = child;
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr += data.toString();
    });
    child.on("exit", (code) => {
      this.exitCode = code;
    });
    this.stopReadingStdout = attachJsonlLineReader(child.stdout!, (line) => this.handleLine(line));

    // Give the process a beat to initialize (model registry load etc).
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (this.exitCode !== null) {
      throw new Error(`prime-agent exited immediately (code ${this.exitCode}): ${this.stderr.slice(-1500)}`);
    }
  }

  private spawnOpts(): Parameters<typeof spawn>[2] {
    return {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    };
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    this.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 1000);
      this.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.process = null;
    this.pendingRequests.clear();
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return; // ignore non-JSON
    }
    if (typeof data !== "object" || data === null) return;
    const record = data as Record<string, unknown>;
    if (record.type === "response" && typeof record.id === "string" && this.pendingRequests.has(record.id)) {
      const pending = this.pendingRequests.get(record.id)!;
      this.pendingRequests.delete(record.id);
      pending.resolve(record as unknown as RpcResponse);
      return;
    }
    if (record.type === "extension_ui_request") {
      const req = record as unknown as RpcExtensionUiRequest;
      void Promise.resolve(this.options.onExtensionUiRequest?.(req));
      return;
    }
    if (record.type === "observed_session_event" || record.type === "observed_session_closed") {
      this.options.onObservedSessionEvent?.(record);
      return;
    }
    this.options.onEvent?.(record as PrimeAgentEvent);
  }

  /** Send a command and resolve with its correlated response. */
  async send(command: Omit<RpcCommand, "id">, opts: PrimeRpcSendOptions = {}): Promise<RpcResponse> {
    if (!this.process?.stdin) throw new Error("client not started");
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id } as RpcCommand;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`timeout waiting for ${command.type} (${timeoutMs}ms). stderr: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            this.pendingRequests.delete(id);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }
      this.process!.stdin!.write(serializeJsonLine(fullCommand));
    });
  }

  private requireSuccess(response: RpcResponse): void {
    if (!response.success) throw new Error(response.error ?? `prime-agent command ${response.command} failed`);
  }

  /** Answer an in-flight extension UI request (approval bridge). */
  async respondExtensionUi(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    if (!this.process?.stdin) throw new Error("client not started");
    const payload =
      response.cancelled === true
        ? { type: "extension_ui_response", id, cancelled: true }
        : response.value !== undefined
          ? { type: "extension_ui_response", id, value: response.value }
          : { type: "extension_ui_response", id, confirmed: response.confirmed === true };
    this.process.stdin.write(serializeJsonLine(payload));
  }

  // ---- high-level helpers -------------------------------------------------

  async getState(): Promise<Record<string, unknown>> {
    const r = await this.send({ type: "get_state" });
    this.requireSuccess(r);
    return (r.data ?? {}) as Record<string, unknown>;
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    const r = await this.send({ type: "get_session_stats" });
    this.requireSuccess(r);
    return (r.data ?? {}) as Record<string, unknown>;
  }

  async newSession(parentSession?: string): Promise<void> {
    const r = await this.send({ type: "new_session", ...(parentSession ? { parentSession } : {}) });
    this.requireSuccess(r);
  }

  async compact(customInstructions?: string): Promise<string> {
    const r = await this.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
    this.requireSuccess(r);
    const data = (r.data ?? {}) as { summary?: string };
    return data.summary ?? "";
  }

  /** Send a prompt and stream until agent_end. Returns the assistant reply text. */
  async promptAndCollect(
    message: string,
    opts: { streamingBehavior?: "steer" | "followUp"; images?: unknown[]; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ reply: string; events: PrimeAgentEvent[]; toolCalls: number }> {
    const events: PrimeAgentEvent[] = [];
    let toolCalls = 0;
    const collector = (event: PrimeAgentEvent) => {
      events.push(event);
      if (event.type === "tool_execution_start") toolCalls += 1;
    };
    // Subscribe first so no delta is missed between prompt ack and event flush.
    const prev = this.options.onEvent;
    this.options.onEvent = (e) => {
      collector(e);
      prev?.(e);
    };
    try {
      const r = await this.send(
        {
          type: "prompt",
          message,
          ...(opts.images?.length ? { images: opts.images } : {}),
          ...(opts.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : {}),
        } as RpcCommand,
        { timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal },
      );
      this.requireSuccess(r);
      await this.waitForEvent("agent_end", opts.timeoutMs ?? 120_000, opts.signal);
    } finally {
      this.options.onEvent = prev;
    }
    const reply = events
      .filter((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta")
      .map((e) => (e as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta ?? "")
      .join("");
    return { reply, events, toolCalls };
  }

  /** Wait until an event of the given type arrives (after the wait starts). */
  private waitForEvent(type: string, timeoutMs: number, signal?: AbortSignal): Promise<PrimeAgentEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.options.onEvent = prev;
        reject(new Error(`timeout waiting for ${type} (${timeoutMs}ms). stderr: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      const prev = this.options.onEvent;
      const listener = (event: PrimeAgentEvent) => {
        if (event.type === type) {
          clearTimeout(timer);
          this.options.onEvent = prev;
          resolve(event);
        }
      };
      this.options.onEvent = (e) => {
        listener(e);
        prev?.(e);
      };
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            this.options.onEvent = prev;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }
    });
  }
}
