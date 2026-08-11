/**
 * Prime Agent harness adapter.
 *
 * Registers prime-agent (the RLM execution kernel) as a first-class QM
 * harness engine over its `--mode rpc` protocol (JSONL over stdio).
 *
 * Design notes (see docs/prime-integration / P0 调研报告):
 * - One prime-agent child process per QM scope, with --session-dir isolated
 *   per scope (multi-tenant file boundary). Processes are lazily spawned and
 *   re-created on crash.
 * - runTurn maps to RPC prompt → stream until agent_end → assemble reply from
 *   text_delta events. `cancel` (AbortSignal) aborts the RPC prompt.
 * - systemPrompt is injected at process spawn via --system-prompt (QM org
 *   soul). Turn-level system prompt deltas are ignored for now (a real
 *   per-turn injection would go through a session pre-seed).
 * - extension_ui_request dialogs (select/confirm/input/editor) are answered
 *   with `cancelled` by default so they never block; wiring may supply a
 *   custom onExtensionUiRequest to bridge into QM's approval flow.
 */
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import type { ScopeId } from "../types.ts";
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { PrimeRpcClient, type PrimeRpcClientOptions, type RpcExtensionUiRequest } from "./prime-rpc-client.ts";
import { createSandboxOneShotIo } from "./prime-rpc-io-sandbox.ts";

export interface PrimeHarnessOptions {
  /** prime-agent CLI entry. If it ends with .js/.mjs it is run via `node`. */
  primeBin?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /** Default provider (e.g. "deepseek"). */
  provider?: string;
  /** Default model (e.g. "deepseek-v4-flash"). */
  model?: string;
  /** Resolve provider/model per scope (falls back to provider/model). */
  resolveProviderModel?: (scope: ScopeId) => { provider?: string; model?: string };
  /** Per-scope session dirs live under this base. */
  sessionDirBase?: string;
  /** Base org system prompt (soul). Injected at spawn. */
  systemPrompt?: string;
  /** Context token budget reported to QM. Defaults to 200_000. */
  contextTokenBudget?: number;
  /** Reset (new_session) on harness switch, clearing IPython state. Default true. */
  kernelResetOnSwitch?: boolean;
  /** Bridge for extension UI requests (approval flow). */
  onExtensionUiRequest?: (request: RpcExtensionUiRequest, scope: ScopeId) => void | Promise<void>;
  /**
   * Check whether an approval grant exists for (scope, session, approvalKey).
   * Used when QM does not provide a toolApprovalGate (non-strict postures),
   * so previously approved operations auto-confirm instead of re-prompting.
   */
  resolveApprovalGrant?: (scope: ScopeId, sessionId: string, approvalKey: string) => Promise<boolean>;
  /** Extra CLI args for the prime-agent process. */
  args?: string[];
  /** Extra env for the prime-agent process. */
  env?: Record<string, string>;
  /**
   * Forced egress: route prime's network through QM's egress proxy.
   * Set both to have the child process send proxy-authorization and route
   * HTTP/HTTPS through the proxy (deployment environments; locally the
   * decision chain is verified via scripts/dev/egress-probe.ts).
   */
  egressProxyUrl?: string;
  egressToken?: string;
  /**
   * Run prime inside a QM sandbox (local docker / sprites / AWS MicroVM)
   * instead of a host child process. When set, prime's RPC process is
   * started via sandbox.startProcess and I/O bridged through
   * readProcess/writeStdin (see prime-rpc-io-sandbox.ts).
   */
  sandbox?: {
    sandbox: Sandbox;
    /** Provision/resolve the per-scope sandbox handle (wiring-owned). */
    handleFor(scope: ScopeId): Promise<SandboxHandle>;
    /** prime CLI path inside the sandbox. */
    cliPath?: string;
    /** Session dir base inside the sandbox (default: handle rootDir). */
    sessionDirBase?: string;
  };
}

const DEFAULT_BUDGET = 200_000;

export function createPrimeHarness(opts: PrimeHarnessOptions = {}): Harness {
  const clients = new Map<string, PrimeRpcClient>();
  let lastSessionStats: Record<string, unknown> | null = null;

  const resolveProviderModel = (scope: ScopeId): { provider?: string; model?: string } => ({
    provider: opts.provider,
    model: opts.model,
    ...(opts.resolveProviderModel ? opts.resolveProviderModel(scope) : {}),
  });

  const sessionDirFor = (scope: ScopeId): string | undefined => {
    if (!opts.sessionDirBase) return undefined;
    const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${opts.sessionDirBase.replace(/\/$/, "")}/${safe}`;
  };

  const clientOptions = (scope: ScopeId): PrimeRpcClientOptions => {
    const { provider, model } = resolveProviderModel(scope);
    return {
      cliPath: opts.sandbox?.cliPath ?? opts.primeBin ?? "prime-agent",
      cwd: opts.cwd ?? sessionDirFor(scope),
      provider,
      model,
      sessionDir: sessionDirFor(scope),
      systemPrompt: opts.systemPrompt,
      args: opts.args,
      env: {
        ...opts.env,
        ...(opts.egressProxyUrl
          ? {
              HTTP_PROXY: opts.egressProxyUrl,
              HTTPS_PROXY: opts.egressProxyUrl,
              NO_PROXY: "",
              ...(opts.egressToken ? { PRIME_EGRESS_TOKEN: opts.egressToken } : {}),
            }
          : {}),
      },
    };
  };

  const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  /** Build the prime RPC command line that runs inside the sandbox. */
  const sandboxCommandFor = (scope: ScopeId): string => {
    const { provider, model } = resolveProviderModel(scope);
    const cliPath = opts.sandbox!.cliPath ?? "/opt/prime-agent/dist/bundle/cli.js";
    const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sessionDir = `${opts.sandbox!.sessionDirBase ?? "$HOME"}/prime-sessions/${safe}`;
    const args: string[] = ["--mode", "rpc"];
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    args.push("--session-dir", sessionDir);
    args.push("--continue");
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    if (opts.args) args.push(...opts.args);
    return `node ${shellQuote(cliPath)} ${args.map((a) => (a.startsWith("-") ? a : shellQuote(a))).join(" ")}`;
  };

  const getClient = async (scope: ScopeId): Promise<PrimeRpcClient> => {
    let client = clients.get(scope);
    if (!client || client.exited) {
      if (client) clients.delete(scope);
      const optsForScope = clientOptions(scope);
      if (opts.sandbox) {
        const handle = await opts.sandbox.handleFor(scope);
        // One-shot pipe mode (FIFO process sessions are incompatible with
        // prime's RPC loop — no EOF means agent_end never settles).
        const envPrefix = Object.entries(optsForScope.env ?? {})
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${k}=${shellQuote(v!)}`)
          .join(" ");
        optsForScope.io = createSandboxOneShotIo({
          sandbox: opts.sandbox.sandbox,
          handle,
          command: sandboxCommandFor(scope),
          envPrefix,
          timeoutMs: 300_000,
        });
      }
      client = new PrimeRpcClient(optsForScope);
      await client.start();
      clients.set(scope, client);
    }
    return client;
  };

  const teardown = async (): Promise<void> => {
    await Promise.allSettled([...clients.values()].map((c) => c.stop()));
    clients.clear();
  };

  const handleExtensionUiRequest = async (
    client: PrimeRpcClient,
    request: RpcExtensionUiRequest,
    scope: ScopeId,
    input: HarnessTurnInput,
    pendingApprovals: NonNullable<HarnessTurnResult["pendingApprovals"]>,
  ): Promise<void> => {
    // One-way UI updates never block the turn.
    if (request.method === "notify" || request.method === "setStatus" || request.method === "setWidget") return;
    if (request.method === "setTitle" || request.method === "set_editor_text") return;
    // Dialog requests (select/confirm/input/editor): bridge into QM's approval
    // gate. Approved tools are auto-confirmed (Auto posture grants); a denied
    // dialog is cancelled AND recorded as a pending approval so the user can
    // grant it for future turns (QM's grant→retry model).
    const label = [request.title, request.message].filter(Boolean).join(" — ") || request.method;
    const approvalKey = `tool:${label}`;
    const gate = input.toolApprovalGate;
    const granted = gate
      ? gate(approvalKey)
      : opts.resolveApprovalGrant
        ? await opts.resolveApprovalGrant(scope, input.session.id, approvalKey)
        : false;
    if (granted) {
      if (request.method === "confirm") {
        await client.respondExtensionUi(request.id, { confirmed: true });
      } else if (request.method === "select" && request.options?.length) {
        await client.respondExtensionUi(request.id, { value: request.options[0]! });
      } else {
        await client.respondExtensionUi(request.id, { value: "" });
      }
      return;
    }
    // Denied by gate (or no gate → conservative deny). Record for approval UI.
    pendingApprovals.push({
      command: label,
      reason: request.method === "confirm" ? "prime agent requests confirmation" : `prime agent requests ${request.method}`,
      approvalKey,
      kind: "approval",
      purpose: label,
    });
    await client.respondExtensionUi(request.id, { cancelled: true });
  };

  void handleExtensionUiRequest;

  return defineHarness(
    {
      id: "prime",
      controlTransport: "json-rpc",
      toolTransport: "in-process",
      transcriptFormat: "jsonl",
      capabilities: new Set(["abort", "steer", "images", "thinking-level", "fast-mode"]),
    },
    {
      async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
        const scope = input.scopeLabel;
        const client = await getClient(scope);
        const pendingApprovals: HarnessTurnResult["pendingApprovals"] = [];
        const extensionBridge = clientOptions(scope).onExtensionUiRequest;

        // Forward streaming deltas / tool progress to QM callbacks.
        const prevOnEvent = client["options"]?.onEvent as ((e: unknown) => void) | undefined;
        client["options"].onEvent = (event: unknown) => {
          const e = event as { type: string; assistantMessageEvent?: { type: string; delta?: string }; toolName?: string };
          if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
            input.onDelta?.(e.assistantMessageEvent.delta);
          }
          if (e.type === "tool_execution_start") {
            input.onProgress?.({ toolCalls: 1 });
          }
          prevOnEvent?.(event);
        };
        // extension UI requests need the turn input for the approval gate.
        (client["options"] as { onExtensionUiRequest?: (r: RpcExtensionUiRequest) => void | Promise<void> }).onExtensionUiRequest =
          (request) => handleExtensionUiRequest(client, request, scope, input, pendingApprovals);

        try {
          const started = Date.now();
          // One-shot sandbox mode: each getSessionStats is a fresh process run
          // (daemon start ~seconds), so reuse the previous turn's stats as
          // the baseline instead of issuing a second run just to read it.
          let statsBefore = lastSessionStats;
          if (!opts.sandbox) {
            statsBefore = await client.getSessionStats().catch(() => null);
          }
          const result = await client.promptAndCollect(input.input, {
            // One-shot sandbox mode has no live streaming context, so steer
            // queue semantics don't apply (and would error on a fresh process).
            ...(opts.sandbox ? {} : { streamingBehavior: "steer" as const }),
            ...(input.images?.length ? { images: input.images } : {}),
            signal: input.cancel,
            timeoutMs: 300_000,
          });
          const reply = result.reply.trim();
          // Report token/cost usage to QM (budget tracking + session_llm_requests).
          // Session stats are cumulative, so take the delta between before/after.
          const { model } = resolveProviderModel(scope);
          // One-shot sandbox mode: a second getSessionStats would spawn a
          // fresh process run (~seconds to tens of seconds) just to read
          // cumulative stats; skip precise usage and report zero (QM budget
          // still records the call). Child mode keeps exact deltas.
          let stats = lastSessionStats;
          if (!opts.sandbox) {
            stats = await client.getSessionStats().catch(() => null);
          }
          if (stats && input.recordLlmRequest && !opts.sandbox) {
            const t = (tokens: Record<string, unknown> | null | undefined) => ({
              input: Number((tokens?.input as number | undefined) ?? 0),
              output: Number((tokens?.output as number | undefined) ?? 0),
              cacheRead: Number((tokens?.cacheRead as number | undefined) ?? 0),
              cacheWrite: Number((tokens?.cacheWrite as number | undefined) ?? 0),
            });
            const after = t(stats.tokens as Record<string, unknown> | undefined);
            const before = t(statsBefore?.tokens as Record<string, unknown> | undefined);
            const costUsd = Math.max(0, (typeof stats.cost === "number" ? stats.cost : 0) - (typeof statsBefore?.cost === "number" ? statsBefore.cost : 0));
            lastSessionStats = stats;
            const tokenInput = after.input - before.input;
            const output = after.output - before.output;
            const cacheRead = after.cacheRead - before.cacheRead;
            const cacheWrite = after.cacheWrite - before.cacheWrite;
            await Promise.resolve(
              input.recordLlmRequest({
                turnSeq: null,
                step: 0,
                model: model ?? "prime",
                request: { prompt: input.input },
                truncated: false,
                durationMs: Date.now() - started,
                usage: {
                  input: Math.max(0, tokenInput),
                  output: Math.max(0, output),
                  cacheRead: Math.max(0, cacheRead),
                  cacheWrite: Math.max(0, cacheWrite),
                  totalTokens: Math.max(0, tokenInput + output + cacheRead + cacheWrite),
                  costUsd,
                },
              }),
            ).catch(() => undefined);
          }
          return {
            reply,
            modelCalls: result.toolCalls + 1,
            ...(pendingApprovals.length ? { pendingApprovals } : {}),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (input.cancel?.aborted) {
            return { reply: "", stopped: true, modelCalls: 0 };
          }
          return {
            reply: `[prime harness] turn failed: ${message}`,
            modelCalls: 0,
          };
        } finally {
          client["options"].onEvent = prevOnEvent;
          (client["options"] as { onExtensionUiRequest?: unknown }).onExtensionUiRequest = extensionBridge;
        }
      },

      async close(): Promise<void> {
        await teardown();
      },

      async resetSession(sessionId: string): Promise<void> {
        // Called by QM when the harness choice changes for a session.
        if (opts.kernelResetOnSwitch === false) return;
        for (const client of clients.values()) {
          try {
            await client.newSession(sessionId);
          } catch {
            // a dead process will be re-created lazily on the next turn
          }
        }
      },

      contextTokenBudget(): number | undefined {
        return opts.contextTokenBudget ?? DEFAULT_BUDGET;
      },
    },
    {
      name: (coreName) => (coreName === "execute" ? "prime_execute" : coreName),
    },
  );
}
