/**
 * Prime RPC I/O abstraction.
 *
 * PrimeRpcClient only depends on this interface; two implementations exist:
 * - createChildProcessIo: spawn `node cli.js --mode rpc` locally (default)
 * - createSandboxProcessIo (prime-rpc-io-sandbox.ts): run inside a QM
 *   sandbox via startProcess/readProcess/writeStdin/signalProcess
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface PrimeRpcIo {
  readonly kind: string;
  start(): Promise<void>;
  /** Write bytes to the child's stdin. */
  write(data: string): void;
  /** Subscribe to stdout chunks. Returns unsubscribe. */
  onData(listener: (chunk: string) => void): () => void;
  /** Subscribe to process exit (code, or null if signalled). Returns unsubscribe. */
  onExit(listener: (code: number | null) => void): () => void;
  kill(): Promise<void>;
  stderrTail(): string;
  /** One-shot ios: execute the accumulated input batch (pipe mode). */
  executeAll?(): Promise<void>;
}

export interface ChildProcessIoOptions {
  cliPath: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function createChildProcessIo(opts: ChildProcessIoOptions): PrimeRpcIo {
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let child: ChildProcess | null = null;
  let stderr = "";
  let exited = false;

  return {
    kind: "child",
    async start() {
      if (child) throw new Error("io already started");
      const useNode = /\.(js|mjs|cjs)$/.test(opts.cliPath);
      child = useNode
        ? spawn("node", [opts.cliPath, ...opts.args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(opts.cliPath, opts.args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.stdout?.on("data", (data: Buffer) => {
        for (const l of [...listeners]) l(data.toString());
      });
      child.on("exit", (code) => {
        exited = true;
        for (const l of [...exitListeners]) l(code);
      });
      // Give the process a beat to initialize (model registry load etc).
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (exited) {
        throw new Error(`prime-agent exited immediately: ${stderr.slice(-1500)}`);
      }
    },
    write(data) {
      child?.stdin?.write(data);
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
      const c = child;
      if (!c) return;
      c.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          c.kill("SIGKILL");
          resolve();
        }, 1000);
        c.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      child = null;
    },
    stderrTail() {
      return stderr.slice(-2000);
    },
  };
}
