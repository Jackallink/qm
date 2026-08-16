/**
 * Agent Runtime Launcher — 把 Manifest 变成真实运行的进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentManifest } from "./agent-manifest.ts";

export interface AgentRuntime {
  agentId: string;
  status: "online" | "error";
  pid?: number;
  sessionId?: string;
  startedAt: number;
  errorMessage?: string;
}

const runningAgents = new Map<string, ChildProcess>();

export async function launchAgent(manifest: AgentManifest): Promise<AgentRuntime> {
  const bin = "prime-agent";
  const useNode = bin.endsWith(".js") || bin.endsWith(".mjs");

  if (runningAgents.has(manifest.id)) {
    const existing = runningAgents.get(manifest.id)!;
    if (existing.exitCode === null) {
      return { agentId: manifest.id, status: "online", pid: existing.pid ?? undefined, startedAt: Date.now() };
    }
    runningAgents.delete(manifest.id);
  }

  const args = ["--mode", "rpc", "--provider", resolveProvider(manifest.model.primary), "--model", manifest.model.primary, "--session-dir", `/tmp/agent-sessions/${manifest.workspace}/${manifest.id}`];

  let child: ChildProcess;
  try {
    child = useNode
      ? spawn("node", [bin, ...args], { detached: true, stdio: ["ignore", "ignore", "ignore"] })
      : spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  } catch (error) {
    return { agentId: manifest.id, status: "error", startedAt: Date.now(), errorMessage: "spawn: " + ((error as Error).message || String(error)) };
  }

  child.on("exit", (code) => { if (code !== 0) console.error(`[launcher] ${manifest.id} exit=${code}`); runningAgents.delete(manifest.id); });
  runningAgents.set(manifest.id, child);

  const earlyExit = await new Promise<number | null>((resolve) => {
    setTimeout(() => resolve(child.exitCode), 2000);
  });
  if (earlyExit !== null) {
    runningAgents.delete(manifest.id);
    return { agentId: manifest.id, status: "error", startedAt: Date.now(), errorMessage: `exited early with code ${earlyExit}` };
  }

  return { agentId: manifest.id, status: "online", pid: child.pid!, sessionId: `agent-${manifest.id}-${Date.now().toString(36)}`, startedAt: Date.now() };
}

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function stopAgent(agentId: string): Promise<void> {
  if (!AGENT_ID_PATTERN.test(agentId)) return;
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("pkill", ["-f", `agent-sessions/.*/${agentId}`], { stdio: "ignore" });
  } catch {
    // pkill exits 1 when no process matched; that is expected.
  }
  runningAgents.delete(agentId);
}

export function getRunningAgents(): { id: string; pid?: number }[] {
  return [...runningAgents.entries()].filter(([, c]) => c.exitCode === null).map(([id, c]) => ({ id, pid: c.pid ?? undefined }));
}

function resolveProvider(modelId: string): string {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1")) return "openai";
  return "deepseek";
}
