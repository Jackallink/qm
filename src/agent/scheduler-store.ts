/**
 * Scheduler Store — cron 任务管理 + 补跑检测 + 循环检测。
 */

import type { ScheduledJob, SchedulerConfig } from "./agent-scheduler.ts";
import { DEFAULT_SCHEDULER_CONFIG } from "./agent-scheduler.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { randomUUID } from "node:crypto";

function jobKey(id: string): string {
  return `scheduled-job:${id}`;
}

export interface SchedulerStore {
  /** 注册 cron 任务 */
  schedule(agentId: string, workspace: string, cron: string): Promise<ScheduledJob>;
  /** 列出所有活跃任务 */
  listActive(): Promise<ScheduledJob[]>;
  /** 标记任务开始执行 */
  startRun(jobId: string): Promise<ScheduledJob | null>;
  /** 标记任务完成 */
  completeRun(jobId: string, success: boolean, sopRunId?: string): Promise<ScheduledJob | null>;
  /** 暂停任务 */
  pause(jobId: string): Promise<void>;
  /** 恢复任务 */
  resume(jobId: string): Promise<void>;
  /** 获取需要补跑的任务（控制面恢复后） */
  getStaleJobs(sinceMs?: number): Promise<ScheduledJob[]>;
  /** 检测循环（同 sopRun audit→fix 轮数） */
  checkLoop(sopRunId: string): Promise<{ loop: boolean; count: number }>;
}

export function createSchedulerStore(
  jobs: DurableMap<ScheduledJob>,
  config?: SchedulerConfig,
): SchedulerStore {
  const cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

  return {
    async schedule(agentId: string, workspace: string, cron: string): Promise<ScheduledJob> {
      const now = Date.now();
      const job: ScheduledJob = {
        id: randomUUID(),
        agentId,
        workspace,
        cron,
        status: "scheduled",
        consecutiveFailures: 0,
        missedRuns: 0,
        sopRunIds: [],
        createdAt: now,
        updatedAt: now,
        lastRunAt: now,
      };
      await jobs.put(jobKey(job.id), job);
      return job;
    },

    async listActive(): Promise<ScheduledJob[]> {
      return (await jobs.all()).filter((j) => j.status !== "paused");
    },

    async startRun(jobId: string): Promise<ScheduledJob | null> {
      const job = await jobs.get(jobKey(jobId));
      if (!job) return null;
      job.status = "running";
      job.updatedAt = Date.now();
      job.lastRunAt = Date.now();
      await jobs.put(jobKey(jobId), job);
      return job;
    },

    async completeRun(jobId: string, success: boolean, sopRunId?: string): Promise<ScheduledJob | null> {
      const job = await jobs.get(jobKey(jobId));
      if (!job) return null;
      if (success) {
        job.status = "scheduled";
        job.consecutiveFailures = 0;
        job.missedRuns = 0;
      } else {
        job.consecutiveFailures += 1;
        if (job.consecutiveFailures >= cfg.maxConsecutiveFailures) {
          job.status = "paused";
        } else {
          job.status = "scheduled";
        }
      }
      if (sopRunId && !job.sopRunIds.includes(sopRunId)) {
        job.sopRunIds.push(sopRunId);
      }
      job.updatedAt = Date.now();
      await jobs.put(jobKey(jobId), job);
      return job;
    },

    async pause(jobId: string): Promise<void> {
      const job = await jobs.get(jobKey(jobId));
      if (!job) return;
      job.status = "paused";
      job.updatedAt = Date.now();
      await jobs.put(jobKey(jobId), job);
    },

    async resume(jobId: string): Promise<void> {
      const job = await jobs.get(jobKey(jobId));
      if (!job) return;
      job.status = "scheduled";
      job.consecutiveFailures = 0;
      job.updatedAt = Date.now();
      await jobs.put(jobKey(jobId), job);
    },

    async getStaleJobs(sinceMs?: number): Promise<ScheduledJob[]> {
      const since = sinceMs ?? 300_000; // 默认 5 分钟
      const now = Date.now();
      return (await jobs.all()).filter(
        (j) => j.status === "scheduled" && j.lastRunAt && now - j.lastRunAt > since,
      );
    },

    async checkLoop(sopRunId: string): Promise<{ loop: boolean; count: number }> {
      let count = 0;
      for (const job of await jobs.all()) {
        count += job.sopRunIds.filter((id) => id === sopRunId).length;
      }
      return { loop: count >= cfg.loopThreshold, count };
    },
  };
}
