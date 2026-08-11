/**
 * Agent Manifest — 企业 Agent 注册的完整类型定义。
 *
 * 设计决策（来自八轮评审）：
 * - identity（平台签发，不可变）+ capabilities（skill 决定，Registry 背书）
 * - 模板化注册：3 种预设 + 自定义模式
 * - 6 状态生命周期
 * - 私有/公开可见性
 * - per Agent egress policy
 * - 备用模型支持
 */

export type AgentLifecycleType = "on-demand" | "resident";
export type AgentTriggerMode = "manual" | "cron" | "event" | "webhook";
export type AgentVisibility = "private" | "public";
export type AgentStatus =
  | "draft"       // 草稿，未提交
  | "deploying"   // 部署中
  | "online"      // 正常运行
  | "error"       // 健康检查失败
  | "stopping"    // 关闭中
  | "stopped";    // 已停止

export type AgentTemplateId = "modeler" | "auditor" | "custom";

/** 单个 Skill 的版本锁定声明 */
export interface AgentSkillBinding {
  /** Skill slug（如 "itsi-metric-skill"） */
  slug: string;
  /** 锁定版本（如 "2.0.0"），空 = latest */
  version?: string;
  /** Skill 的依赖声明 */
  dependencies?: Record<string, string>;
}

/** 模型配置（含备用） */
export interface AgentModelConfig {
  /** 首选模型 */
  primary: string;
  /** 备用模型列表（primary 不可用时按顺序切换） */
  fallback?: string[];
  /** 单任务 token 上限 */
  tokenLimit?: number;
  /** 单任务成本上限（USD） */
  costLimit?: number;
}

/** 触发配置 */
export interface AgentTriggerConfig {
  mode: AgentTriggerMode;
  /** cron 表达式（mode=cron 时必填） */
  cron?: string;
  /** webhook URL（mode=webhook 时） */
  webhookUrl?: string;
}

/** 身份层（平台签发，Agent 不能修改） */
export interface AgentIdentity {
  /** 平台生成的唯一 ID */
  agentId: string;
  /** 注册人 */
  registeredBy: string;
  /** 签发时间 */
  issuedAt: number;
}

/** 能力层（由 Skill 决定，Registry 背书） */
export interface AgentCapabilities {
  /** 加载的 Skill 列表 */
  skills: AgentSkillBinding[];
  /** 能力标签列表 */
  tags: string[];
  /** 操作声明：哪些操作是允许的 */
  operations: {
    read?: string[];   // 可读的数据源
    write?: string[];  // 可写的数据源
    deploy?: boolean;  // 是否可部署
    audit?: boolean;   // 是否可审计
  };
}

/** 运行配置 */
export interface AgentRuntimeConfig {
  lifecycle: AgentLifecycleType;
  trigger?: AgentTriggerConfig;
  /** 按需 Agent 的 idle 超时（秒），默认 600 */
  idleTimeoutSec?: number;
  /** 执行沙箱：physical（独立容器）| logical（进程内隔离） */
  sandbox: "physical" | "logical";
}

/** 安全配置 */
export interface AgentSecurityConfig {
  /** 可见性 */
  visibility: AgentVisibility;
  /** 允许调用此 Agent 的角色 */
  acl: { invoke: string[]; manage: string[] };
  /** egress 策略 */
  egressPolicy?: {
    allowedDomains: string[];
    allowedInternal: string[];
  };
  /** 数据驻留区域 */
  dataResidency?: string;
}

/** Agent Manifest — 完整定义 */
export interface AgentManifest {
  /** 唯一标识（slug） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 所属 workspace */
  workspace: string;
  /** 模板类型 */
  template: AgentTemplateId;
  /** 状态 */
  status: AgentStatus;
  /** 当前版本 */
  version: number;

  /** 身份层（不可变） */
  identity: AgentIdentity;
  /** 能力层 */
  capabilities: AgentCapabilities;
  /** harness 引擎 */
  harness: "prime" | "hermes" | "opencode" | "codex" | "claude" | "pi";
  /** 模型配置 */
  model: AgentModelConfig;
  /** 运行配置 */
  runtime: AgentRuntimeConfig;
  /** 安全配置 */
  security: AgentSecurityConfig;

  /** 创建/更新时间 */
  createdAt: number;
  updatedAt: number;
  /** 最后活跃时间 */
  lastActiveAt?: number;
  /** 健康检查状态 */
  health?: { status: "healthy" | "degraded" | "unhealthy"; lastCheck: number };
}

/** 模板定义 */
export const AGENT_TEMPLATES: Record<
  AgentTemplateId,
  { name: string; description: string; manifest: Partial<AgentManifest> }
> = {
  modeler: {
    name: "建模 Agent",
    description: "加载 ITSI 建模 Skill，支持交互式建模 + Gate 签收",
    manifest: {
      template: "modeler",
      harness: "prime",
      runtime: { lifecycle: "on-demand" as const, sandbox: "physical" as const, idleTimeoutSec: 600 },
      capabilities: {
        skills: [{ slug: "itsi-metric-skill" }],
        tags: ["modeling", "itsi", "yhp"],
        operations: { read: ["yhp:*"], write: ["yhp:view", "yhp:search"] },
      },
    },
  },
  auditor: {
    name: "审计 Agent",
    description: "加载 ITSI 审计 Skill，定时巡检 + 交叉审计",
    manifest: {
      template: "auditor",
      harness: "prime",
      runtime: {
        lifecycle: "resident" as const,
        sandbox: "logical" as const,
        trigger: { mode: "cron", cron: "0 * * * *" },
      },
      capabilities: {
        skills: [{ slug: "itsi-metric-skill" }],
        tags: ["audit", "model-quality", "pdca"],
        operations: { read: ["yhp:*", "models:*"], audit: true },
      },
    },
  },
  custom: {
    name: "自定义 Agent",
    description: "自由配置",
    manifest: { template: "custom", harness: "prime" },
  },
};
