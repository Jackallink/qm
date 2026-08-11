/**
 * 跨框架 Agent 上下文交换协议 — 极简 JSON schema。
 *
 * 对标标书 #8（工具调用框架）、#20（AI+ 业务场景多系统编排）、#27（集成要求）
 *
 * 每个 Agent 框架（Prime/LangChain/Dify/HTTP）实现一个 adapter：
 *   内部格式 ↔ AgentContextExchange（本协议）
 *
 * 协议字段语义锚定（类似 HTTP 状态码）：
 *   - model_id: 被操作的业务模型 ID
 *   - health_score: 0-100，数字越大越健康
 *   - critical_kpis: 当前处于 critical band 的 KPI ID 列表
 *   - semantic_summary: 人类可读的一句话总结
 */

export interface AgentContextExchange {
  /** 协议版本 */
  protocolVersion: string;
  /** 交换 ID（唯一） */
  exchangeId: string;
  /** 发送方 Agent ID */
  senderId: string;
  /** 接收方 Agent ID */
  receiverId: string;
  /** 上下文类型（如 model_reference, audit_result, deploy_request） */
  contextType: string;
  /** 上下文 payload（类型特定的数据） */
  payload: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
}

/** 预定义的 context types */
export const CONTEXT_TYPES = {
  MODEL_REFERENCE: "model_reference",
  AUDIT_RESULT: "audit_result",
  DEPLOY_REQUEST: "deploy_request",
  HEALTH_CHECK: "health_check",
  INCIDENT_REPORT: "incident_report",
} as const;

/** 协议版本 */
export const PROTOCOL_VERSION = "agent-context-v1.0";

/** 创建交换消息 */
export function createContextExchange(
  senderId: string,
  receiverId: string,
  contextType: string,
  payload: Record<string, unknown>,
): AgentContextExchange {
  return {
    protocolVersion: PROTOCOL_VERSION,
    exchangeId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    receiverId,
    contextType,
    payload,
    timestamp: Date.now(),
  };
}

/** 验证交换消息格式 */
export function validateContextExchange(data: unknown): data is AgentContextExchange {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.protocolVersion === "string" &&
    d.protocolVersion === PROTOCOL_VERSION &&
    typeof d.exchangeId === "string" &&
    typeof d.senderId === "string" &&
    typeof d.receiverId === "string" &&
    typeof d.contextType === "string" &&
    typeof d.payload === "object" &&
    typeof d.timestamp === "number"
  );
}

/** Adapter 接口：每个框架实现此接口 */
export interface ContextExchangeAdapter {
  /** 将框架内部格式打包为协议格式 */
  pack(contextType: string, internalData: unknown): AgentContextExchange;
  /** 将协议格式解包为框架内部格式 */
  unpack(exchange: AgentContextExchange): unknown;
}

/** Prime Agent 的 Adapter 示例 */
export const primeContextAdapter: ContextExchangeAdapter = {
  pack(contextType, internalData) {
    const data = internalData as Record<string, unknown> | null;
    return createContextExchange("prime-agent", "", contextType, {
      model_id: data?.model_id ?? "",
      health_score: data?.health_score ?? 0,
      critical_kpis: data?.critical_kpis ?? [],
      semantic_summary: data?.semantic_summary ?? "",
      ...data,
    });
  },
  unpack(exchange) {
    return {
      type: exchange.contextType,
      from: exchange.senderId,
      ...exchange.payload,
      _receivedAt: Date.now(),
    };
  },
};
