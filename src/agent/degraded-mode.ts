/**
 * Agent 降级模式 — 控制面断开时的安全运行策略。
 *
 * 设计决策（R5 评审）：
 * - 控制面不可达 → Agent 进入 degraded mode
 * - 停写（数据修改/部署/配置变更）· 只读+标记 · 暂停定时 · 持续心跳
 * - 恢复后自动补跑错过任务（上限 3 次）
 * - 多租户：单租户故障不影响其他租户
 */

/** 降级状态 */
export type DegradedStatus = "normal" | "degraded" | "disconnected";

export interface AgentHealth {
  agentId: string;
  status: DegradedStatus;
  /** 上次心跳时间 */
  lastHeartbeat: number;
  /** 上次控制面可达时间 */
  lastControlPlaneContact: number;
  /** 进入降级模式的时间（0 = 正常） */
  degradedSince: number;
  /** 降级期间暂停的定时任务数 */
  pausedJobCount: number;
  /** 待补跑的任务数 */
  pendingCatchupCount: number;
}

interface DegradedState {
  health: AgentHealth;
  /** 降级前 Agent 状态（用于恢复） */
  previousStatus?: string;
}

const agentHealthMap = new Map<string, DegradedState>();

/** 心跳间隔（代理检测控制面是否可达） */
/** 控制面超时阈值（超过此时间无响应 = 控制面断开） */
const CONTROL_PLANE_TIMEOUT_MS = 30_000;

/** 初始化 Agent 健康状态 */
export function initAgentHealth(agentId: string): AgentHealth {
  const now = Date.now();
  const h: AgentHealth = {
    agentId,
    status: "normal",
    lastHeartbeat: now,
    lastControlPlaneContact: now,
    degradedSince: 0,
    pausedJobCount: 0,
    pendingCatchupCount: 0,
  };
  agentHealthMap.set(agentId, { health: h });
  return h;
}

/** Agent 心跳（由 Agent 定时调用） */
export function agentHeartbeat(agentId: string): AgentHealth {
  const state = agentHealthMap.get(agentId);
  if (!state) return initAgentHealth(agentId);
  state.health.lastHeartbeat = Date.now();
  return state.health;
}

/** 控制面心跳（由控制面调用，表示自己还活着） */
export function controlPlaneHeartbeat(agentId: string): DegradedStatus {
  const state = agentHealthMap.get(agentId);
  if (!state) {
    initAgentHealth(agentId);
    return "normal";
  }
  const now = Date.now();
  state.health.lastControlPlaneContact = now;
  if (state.health.status === "degraded" || state.health.status === "disconnected") {
    state.health.status = "normal";
    state.health.degradedSince = 0;
    state.health.pendingCatchupCount = state.health.pausedJobCount;
  }
  return "normal";
}

/** 检测控制面是否断开（由 Agent 定期调用） */
export function checkControlPlane(agentId: string): DegradedStatus {
  const state = agentHealthMap.get(agentId);
  if (!state) return "normal";
  const now = Date.now();
  const elapsed = now - state.health.lastControlPlaneContact;

  if (elapsed > CONTROL_PLANE_TIMEOUT_MS * 3) {
    // 超时 3 倍 → disconnected（完全断开）
    if (state.health.status !== "disconnected") {
      state.health.status = "disconnected";
      state.health.degradedSince = now;
    }
    return "disconnected";
  }
  if (elapsed > CONTROL_PLANE_TIMEOUT_MS) {
    // 超时 1 倍 → degraded（降级模式）
    if (state.health.status !== "degraded") {
      state.health.status = "degraded";
      state.health.degradedSince = now;
      // 进入降级时暂停所有定时任务
      state.health.pausedJobCount = 0; // 将在 scheduler 层累加
    }
    return "degraded";
  }
  return "normal";
}

/** 获取 Agent 健康状态 */
export function getAgentHealth(agentId: string): AgentHealth | null {
  return agentHealthMap.get(agentId)?.health ?? null;
}

/** 获取所有 Agent 健康状态 */
export function getAllAgentHealth(): AgentHealth[] {
  return [...agentHealthMap.values()].map((s) => s.health);
}

/** 清理已停止 Agent 的健康状态 */
export function removeAgentHealth(agentId: string): void {
  agentHealthMap.delete(agentId);
}

/** 降级期间判断：操作是否允许 */
export function isOperationAllowed(
  agentId: string,
  operation: "read" | "write" | "deploy" | "config_change" | "schedule",
): { allowed: boolean; reason?: string } {
  const status = checkControlPlane(agentId);
  if (status === "normal") return { allowed: true };

  switch (operation) {
    case "read":
      return { allowed: true, reason: `degraded (${status}) — read-only` };
    case "schedule":
      return { allowed: false, reason: `degraded (${status}) — schedules paused` };
    default:
      return { allowed: false, reason: `degraded (${status}) — write/change blocked` };
  }
}
