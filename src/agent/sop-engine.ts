/**
 * SOP Engine — Gate DAG 状态机 + 产物版本号 + 签收审计。
 *
 * 设计决策（来自八轮评审）：
 * - Git-like DAG：回退 = 新版本 + superseded，旧版本保留不删
 * - Gate 5 签收后 frozen → 修改走新 major version
 * - 独立签收页（预览/审计/diff），签收不可撤回（法律意义）
 * - advisory_lock 防并发修改
 * - 7 天不活动通知，30 天 stale
 * - 交叉 SopRun 引用感知 superseded 状态
 */

export type GateNumber = 0 | 1 | 2 | 3 | 4 | 5;
export type GateStatus = "pending" | "in_progress" | "done" | "superseded" | "obsolete";
export type SopRunStatus = "active" | "stale" | "frozen" | "archived";

export interface GateRecord {
  gate: GateNumber;
  /** 当前状态 */
  status: GateStatus;
  /** 产物版本号（每次回退+重做 = 新版本） */
  productVersion: number;
  /** 产物文件 hash */
  productHash?: string;
  /** 产物文件路径列表 */
  productFiles?: string[];
  /** 签收人 */
  signedBy?: string;
  /** 签收时间 */
  signedAt?: number;
  /** 审计得分 */
  auditScore?: number;
  /** 审计详情 */
  auditDetail?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

export interface SopRun {
  /** 唯一标识 */
  id: string;
  /** 模型 ID */
  modelId: string;
  /** 所属 workspace */
  workspace: string;
  /** 执行 Agent ID */
  agentId: string;
  /** 当前 Gate */
  currentGate: GateNumber;
  /** 状态 */
  status: SopRunStatus;
  /** 所有 Gate 的历史记录（含回退分支） */
  gates: GateRecord[];
  /** 跨 SopRun 引用（其他模型依赖本模型） */
  referencedBy?: string[];
  /** 外部依赖声明 */
  externalDeps?: Array<{
    type: string;
    name: string;
    verifiedAt?: number;
  }>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 最后活动时间（用于 stale 检测） */
  lastActiveAt: number;
}

/** Gate 前进规则：Gate N → Gate N+1 */
export function nextGate(current: GateNumber): GateNumber | null {
  if (current < 5) return (current + 1) as GateNumber;
  return null; // Gate 5 是终点
}

/** Gate 回退规则：可以回退到任意小于当前的 Gate */
export function canRollbackTo(from: GateNumber, to: GateNumber): boolean {
  return to < from;
}

/** 超时检测 */
export function isStale(lastActiveAt: number, now: number = Date.now()): boolean {
  const days = (now - lastActiveAt) / (1000 * 60 * 60 * 24);
  return days > 7;
}

export function isArchivable(lastActiveAt: number, now: number = Date.now()): boolean {
  const days = (now - lastActiveAt) / (1000 * 60 * 60 * 24);
  return days > 30;
}

/** 创建新的 Gate 记录 */
export function newGateRecord(gate: GateNumber, version: number): GateRecord {
  const now = Date.now();
  return {
    gate,
    status: "in_progress",
    productVersion: version,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建新的 SopRun */
export function newSopRun(
  id: string,
  modelId: string,
  workspace: string,
  agentId: string,
): SopRun {
  const now = Date.now();
  return {
    id,
    modelId,
    workspace,
    agentId,
    currentGate: 0,
    status: "active",
    gates: [newGateRecord(0, 1)],
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}
