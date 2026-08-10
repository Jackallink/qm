/**
 * Sandbox process I/O for PrimeRpcClient.
 *
 * Runs `prime-agent --mode rpc` inside a QM sandbox (local docker / sprites /
 * AWS MicroVM) using the sandbox's process-session API. The sandbox's
 * process sessions are exec-file based (output appended to ~/.agent-proc/<id>/out,
 * read via `readProcess` with blocking wait), so this implementation bridges
 * that polling model onto the stream-ish PrimeRpcIo contract.
 */
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { PrimeRpcIo } from "./prime-rpc-io.ts";

export interface SandboxProcessIoOptions {
  sandbox: Sandbox;
  handle: SandboxHandle;
  /** Full command line for the prime-agent process inside the sandbox. */
  command: string;
  env?: Record<string, string>;
  /** readProcess poll interval in ms (default 250). */
  pollMs?: number;
}

const DEFAULT_MAX_BYTES = 128 * 1024;

export function createSandboxProcessIo(opts: SandboxProcessIoOptions): PrimeRpcIo {
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const pollMs = opts.pollMs ?? 250;
  let processId: string | null = null;
  let cursor = 0;
  let started = false;
  let exited = false;
  let stderr = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const pollOnce = async (): Promise<void> => {
    if (!processId) return;
    try {
      const r = await opts.sandbox.readProcess?.(opts.handle, processId, {
        sinceCursor: cursor,
        maxBytes: DEFAULT_MAX_BYTES,
        waitMs: pollMs,
      });
      if (!r) return;
      if (r.chunks && r.chunks.length > cursor) {
        const delta = r.chunks.slice(cursor);
        cursor = r.chunks.length;
        for (const l of [...listeners]) l(delta);
      }
      if (r.status.state !== "running") {
        finish(r.status.code);
      }
    } catch (error) {
      // readProcess throws when the session is gone → treat as exit.
      finish(null);
    }
  };

  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const l of [...exitListeners]) l(code);
  };

  return {
    kind: "sandbox",
    async start() {
      if (started) throw new Error("io already started");
      const { processId: pid } = await opts.sandbox.startProcess?.(opts.handle, opts.command, {
        env: opts.env,
      }) ?? { processId: undefined };
      if (!pid) throw new Error("sandbox startProcess returned no processId");
      processId = pid;
      started = true;
      // Kick off the poll loop.
      void pollOnce().catch(() => finish(null));
      pollTimer = setInterval(() => void pollOnce().catch(() => finish(null)), pollMs);
    },
    write(data) {
      if (processId) void opts.sandbox.writeStdin?.(opts.handle, processId, data).catch(() => finish(null));
    },
    onData(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async kill() {
      if (processId) {
        await opts.sandbox.signalProcess?.(opts.handle, processId, "SIGTERM").catch(() => undefined);
      }
      finish(null);
    },
    stderrTail() {
      return stderr;
    },
  };
}
