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
  const bin = process.env.PRIME_BIN || "prime-agent";
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
      ? spawn("node", [bin, ...args], { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, ...getAgentEnv(manifest) } })
      : spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, ...getAgentEnv(manifest) } });
  } catch (error) {
    return { agentId: manifest.id, status: "error", startedAt: Date.now(), errorMessage: "spawn: " + ((error as Error).message || String(error)) };
  }

  child.on("exit", (code) => { if (code !== 0) console.error(`[launcher] ${manifest.id} exit=${code}`); runningAgents.delete(manifest.id); });
  runningAgents.set(manifest.id, child);

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { if (child.exitCode !== null) reject(new Error(`exit ${child.exitCode}`)); else resolve(); }, 2000);
  });

  return { agentId: manifest.id, status: "online", pid: child.pid!, sessionId: `agent-${manifest.id}-${Date.now().toString(36)}`, startedAt: Date.now() };
}

export async function stopAgent(agentId: string): Promise<void> {
  // Detached daemon: kill via pgrep on session dir
  const { execSync } = await import("node:child_process");
  try { execSync(`pkill -f "agent-sessions/.*/${agentId}" 2>/dev/null || true`, { stdio: "ignore" }); } catch { /* ok */ }
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
function getAgentEnv(m: AgentManifest): Record<string, string> {
  const e: Record<string, string> = {};
  if (process.env.DEEPSEEK_API_KEY) e.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) e.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) e.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return e;
}
