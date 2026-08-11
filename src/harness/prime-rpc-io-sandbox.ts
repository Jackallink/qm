/**
 * Sandbox one-shot I/O for PrimeRpcClient.
 *
 * prime-agent's RPC loop does not work well over QM's sandbox process
 * sessions (FIFO stdin): with no stdin EOF the agent loop polls for
 * steering messages forever and never emits turn_end/agent_end. The working
 * shape is a one-shot pipe: `echo '<command>' | cli --mode rpc ...` — stdin
 * EOF lets the loop settle and emit agent_end normally (verified: full turn
 * with IPython kernel in ~6s warm).
 *
 * Multi-turn context is preserved across one-shots via `--session-dir` +
 * `--continue` (prime persists memory/harness state per session dir).
 *
 * This io accumulates everything written via `write()` and executes the
 * whole batch once per `executeAll()` (invoked by the client on send).
 */
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { PrimeRpcIo } from "./prime-rpc-io.ts";

export interface SandboxOneShotIoOptions {
  sandbox: Sandbox;
  handle: SandboxHandle;
  /** Full command line (without the echo prefix / pipe). */
  command: string;
  /** Shell prefix, e.g. "DEEPSEEK_API_KEY=... PRIME_AGENT_KERNEL_VENV=/opt/prime-kernel-venv". */
  envPrefix?: string;
  timeoutMs?: number;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function createSandboxOneShotIo(opts: SandboxOneShotIoOptions): PrimeRpcIo {
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let started = false;
  let exited = false;
  let input = "";

  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const l of [...exitListeners]) l(code);
  };

  const executeAll = async (): Promise<void> => {
    if (!input.trim()) return;
    // Prime's daemon supervisor owns a fixed socket (/tmp/prime-agent-0); a
    // reused sandbox container accumulates stale supervisors whose lock
    // conflicts with the next run. Clean residual prime processes + sockets
    // before each one-shot (no `ps` in the image — scan /proc).
    const cleanup =
      'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; ' +
      'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
      'case "$c" in *prime-agent*|*bundle/cli.js*) kill -9 "${p#/proc/}" 2>/dev/null ;; esac; done; ' +
      'rm -rf /tmp/prime-agent-0 "$HOME/.prime/agent/daemon-workers" 2>/dev/null';
    const cmd =
      `${cleanup}; echo ${shellQuote(input.trim())} | ${opts.envPrefix ? opts.envPrefix + " " : ""}${opts.command} 2>/dev/null`;
    try {
      const r = await opts.sandbox.run(opts.handle, cmd, { timeoutMs: opts.timeoutMs ?? 300_000 });
      const out = r.stdout ?? "";
      // Emit in chunks so the client's LF framing works identically.
      for (let i = 0; i < out.length; i += 16 * 1024) {
        for (const l of [...listeners]) l(out.slice(i, i + 16 * 1024));
      }
      finish(r.code);
    } catch (error) {
      finish(null);
    } finally {
      input = "";
    }
  };

  return {
    kind: "sandbox-one-shot",
    async start() {
      if (started) throw new Error("io already started");
      started = true;
    },
    write(data) {
      input += data;
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
      finish(null);
    },
    stderrTail() {
      return "";
    },
    /** Execute the accumulated input as one sandboxed pipe; used by the client. */
    executeAll,
  };
}
