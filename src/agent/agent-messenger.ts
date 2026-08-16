/**
 * Agent Messenger — Agent 间通信 + 三种模式。
 *
 * 设计决策：
 * - Event（fire-and-forget）+ RPC（请求/响应）+ Observe（状态订阅）
 * - 消息携带 nonce 与 HMAC 签名（由 store 进程内 secret 生成；MVP 阶段
 *   签名由 admin-gated 路由保护，接收端验证留给后续迭代）
 * - 内建异常：去重/指数退避重试/死信队列/循环检测
 * - 订阅管理 + 心跳检测
 * - 能力检查（消息类型 × sender → 授权列表）
 */

export type MessageMode = "event" | "rpc" | "observe";
export type MessageStatus = "pending" | "delivered" | "failed" | "dead";

export interface AgentMessage {
  /** 消息唯一 ID */
  id: string;
  /** 发送方 Agent ID */
  senderId: string;
  /** 接收方 Agent ID */
  receiverId: string;
  /** 通信模式 */
  mode: MessageMode;
  /** 消息类型 */
  type: string;
  /** 消息体 */
  payload: Record<string, unknown>;
  /** 时间戳（Unix ms） */
  timestamp: number;
  /** 防重放 nonce */
  nonce: string;
  /** HMAC 签名 */
  signature: string;
  /** 幂等 key（防重复处理） */
  idempotencyKey: string;
  /** 当前状态 */
  status: MessageStatus;
  /** 重试次数 */
  retryCount: number;
  /** 下次重试时间 */
  nextRetryAt?: number;
  /** 创建时间 */
  createdAt: number;
}

/** 订阅条目 */
export interface AgentSubscription {
  agentId: string;
  /** 订阅的事件类型 */
  eventTypes: string[];
  /** 上次心跳时间 */
  lastHeartbeat: number;
  /** 是否活跃 */
  active: boolean;
}

/** Messenger 配置 */
export interface MessengerConfig {
  /** 签名 secret（每个 Agent 重启时重新生成） */
  agentSecret: string;
  /** 消息时间窗口（ms，默认 5 分钟） */
  timeWindowMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 退避基数（ms） */
  retryBaseMs: number;
  /** 死信阈值（重试耗尽） */
  deadLetterThreshold: number;
  /** 循环检测阈值（同类型消息往返次数） */
  loopThreshold: number;
}

export const DEFAULT_MESSENGER_CONFIG: MessengerConfig = {
  agentSecret: "",
  timeWindowMs: 5 * 60 * 1000,
  maxRetries: 3,
  retryBaseMs: 10_000,
  deadLetterThreshold: 3,
  loopThreshold: 5,
};
