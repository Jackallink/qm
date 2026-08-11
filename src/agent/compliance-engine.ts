/**
 * 合规快照引擎 — 定期对比 Agent "声明" vs "实际"，生成合规报告。
 *
 * 对标：标书 #17（全链路审计）、#22（Skill 执行安全）、#24（数据审计安全）
 * 用法：complianceSnapshot(agentId, period) → { score, gaps[], report }
 */
import type { AgentManifest } from "./agent-manifest.ts";

/** 合规维度 */
export type ComplianceDimension =
  | "data_access"      // 声明可访问 vs 实际访问的数据源
  | "operations"       // 声明可执行 vs 实际执行的操作
  | "model_usage"      // 声明模型 vs 实际调用模型
  | "egress"           // 声明 egress vs 实际出网域名
  | "skill_integrity"  // Skill fingerprint vs 注册指纹
  | "lifecycle"        // Agent 状态偏离

export interface ComplianceGap {
  dimension: ComplianceDimension;
  severity: "critical" | "warning" | "info";
  /** 声明值 */
  declared: string;
  /** 实际值 */
  actual: string;
  /** 发现时间 */
  detectedAt: number;
  /** 描述 */
  description: string;
}

export interface ComplianceReport {
  agentId: string;
  workspace: string;
  period: { start: number; end: number };
  score: number;           // 0-100
  gaps: ComplianceGap[];
  generatedAt: number;
}

/** 单个维度的合规检查 */
export interface ComplianceChecker {
  dimension: ComplianceDimension;
  /** 检查函数：对比声明 vs 实际，返回 gap 列表 */
  check(manifest: AgentManifest, auditData: Record<string, unknown>): ComplianceGap[];
}

/** 预置检查器 */
export const DEFAULT_CHECKERS: ComplianceChecker[] = [
  {
    dimension: "data_access",
    check(manifest, auditData) {
      const declared = manifest.capabilities.operations.read ?? [];
      const actual = (auditData.accessedSources as string[] | undefined) ?? [];
      const unauthorized = actual.filter((s) => !declared.includes(s) && declared.length > 0);
      return unauthorized.map((s) => ({
        dimension: "data_access" as const,
        severity: "critical" as const,
        declared: declared.join(", "),
        actual: s,
        detectedAt: Date.now(),
        description: `Agent accessed unauthorized data source: ${s}`,
      }));
    },
  },
  {
    dimension: "model_usage",
    check(manifest, auditData) {
      const declared = manifest.model.primary;
      const actual = (auditData.modelUsed as string | undefined) ?? "";
      if (actual && actual !== declared) {
        return [{
          dimension: "model_usage",
          severity: "warning",
          declared,
          actual,
          detectedAt: Date.now(),
          description: `Agent used different model (${actual}) than declared (${declared})`,
        }];
      }
      return [];
    },
  },
  {
    dimension: "lifecycle",
    check(manifest, _auditData) {
      const now = Date.now();
      const idleDays = manifest.lastActiveAt ? (now - manifest.lastActiveAt) / (1000 * 86400) : 0;
      if (idleDays > 7) {
        return [{
          dimension: "lifecycle",
          severity: "info",
          declared: manifest.status,
          actual: `idle ${idleDays.toFixed(1)} days`,
          detectedAt: now,
          description: `Agent idle for ${idleDays.toFixed(1)} days`,
        }];
      }
      return [];
    },
  },
];

/** 生成合规快照 */
export function generateComplianceSnapshot(
  manifest: AgentManifest,
  auditData: Record<string, unknown>,
  periodStart: number,
  periodEnd: number,
  checkers: ComplianceChecker[] = DEFAULT_CHECKERS,
): ComplianceReport {
  const gaps: ComplianceGap[] = [];
  for (const checker of checkers) {
    gaps.push(...checker.check(manifest, auditData));
  }
  const criticals = gaps.filter((g) => g.severity === "critical").length;
  const warnings = gaps.filter((g) => g.severity === "warning").length;
  const score = Math.max(0, 100 - criticals * 20 - warnings * 5);
  return {
    agentId: manifest.id,
    workspace: manifest.workspace,
    period: { start: periodStart, end: periodEnd },
    score,
    gaps,
    generatedAt: Date.now(),
  };
}
