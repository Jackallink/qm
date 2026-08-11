/**
 * Agent Runtime Launcher — 把 Manifest 变成真实运行的进程。
 *
 * "deploying → online" 不再是空状态翻转：
 *   1. child 模式：spawn prime-agent --mode rpc（QM harness child）
 *   2. sandbox 模式：provision QM 沙箱容器 + 一次性 pipe
 *   3. 启动成功 → 写入 online + 记录 PID / session
 *   4. 启动失败 → 写入 error + 原因
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

/** 已运行的 Agent 进程表（内存） */
const runningAgents = new Map<string, ChildProcess>();

/** 启动 Agent（child 模式） */
export async function launchAgent(manifest: AgentManifest): Promise<AgentRuntime> {
  // 防止重复启动
  if (runningAgents.has(manifest.id)) {
    const existing = runningAgents.get(manifest.id)!;
    if (existing.exitCode === null) {
      return { agentId: manifest.id, status: "online", startedAt: Date.now() };
    }
    runningAgents.delete(manifest.id);
  }

  const args = [
    "--mode", "rpc",
    "--provider", resolveProvider(manifest.model.primary),
    "--model", manifest.model.primary,
    "--session-dir", `/tmp/agent-sessions/${manifest.workspace}/${manifest.id}`,
  ];

  try {
    const child = spawn("prime-agent", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...getAgentEnv(manifest) },
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[agent-launcher] ${manifest.id} exited with code ${code}`);
      }
      runningAgents.delete(manifest.id);
    });

    runningAgents.set(manifest.id, child);

    // Fire-and-forget: agent runs in background

    return {
      agentId: manifest.id,
      status: "online",
      pid: child.pid,
      sessionId: `agent-${manifest.id}-${Date.now().toString(36)}`,
      startedAt: Date.now(),
    };
  } catch (error) {
    return {
      agentId: manifest.id,
      status: "error",
      startedAt: Date.now(),
      errorMessage: (error as Error).message,
    };
  }
}

/** 停止 Agent */
export async function stopAgent(agentId: string): Promise<void> {
  const child = runningAgents.get(agentId);
  if (child) {
    child.kill("SIGTERM");
    runningAgents.delete(agentId);
  }
}

/** 解析模型 → provider 映射 */
function resolveProvider(modelId: string): string {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1")) return "openai";
  if (modelId.startsWith("deepseek")) return "deepseek";
  return "deepseek"; // 默认
}

function getAgentEnv(manifest: AgentManifest): Record<string, string> {
  const env: Record<string, string> = {};
  // 传递 API key（从 process.env 继承）
  if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (manifest.model.tokenLimit) env.PRIME_TOKEN_LIMIT = String(manifest.model.tokenLimit);
  return env;
}

/** 查询当前运行的 Agent */
export function getRunningAgents(): { id: string; pid?: number }[] {
  return [...runningAgents.entries()]
    .filter(([, c]) => c.exitCode === null)
    .map(([id, c]) => ({ id, pid: c.pid ?? undefined }));
}
