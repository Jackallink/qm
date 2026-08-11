/**
 * Agent Scheduler — 统一编排 cron Agent + 错峰 + 合并查询 + 补跑。
 *
 * 设计决策：
 * - Scheduler 统一编排所有 cron Agent（不各自独立定时）
 * - 错峰：同数据源的查询合并
 * - 补跑：控制面恢复后自动补跑错过任务（上限 3 次）
 * - 循环检测：同 SopRun audit→fix 超过 5 轮 → 暂停
 */

export interface ScheduledJob {
  id: string;
  agentId: string;
  workspace: string;
  /** cron 表达式 */
  cron: string;
  /** 上次执行时间 */
  lastRunAt?: number;
  /** 下次执行时间 */
  nextRunAt?: number;
  /** 执行状态 */
  status: "scheduled" | "running" | "completed" | "failed" | "paused";
  /** 连续失败次数（用于补跑上限检测） */
  consecutiveFailures: number;
  /** 错过次数（控制面断开期间的） */
  missedRuns: number;
  /** 创建的 SOP 运行 ID（用于循环检测） */
  sopRunIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Scheduler 配置 */
export interface SchedulerConfig {
  /** 最大补跑次数 */
  maxCatchupRuns: number;
  /** 最大连续失败次数 */
  maxConsecutiveFailures: number;
  /** 循环检测阈值 */
  loopThreshold: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxCatchupRuns: 3,
  maxConsecutiveFailures: 5,
  loopThreshold: 5,
};
