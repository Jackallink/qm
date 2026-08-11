/**
 * Messenger Store — 消息路由/持久化 + 订阅管理。
 */

import type { AgentMessage, AgentSubscription, MessengerConfig } from "./agent-messenger.ts";
import { DEFAULT_MESSENGER_CONFIG } from "./agent-messenger.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createHmac, randomUUID } from "node:crypto";

function msgKey(id: string): string {
  return `agent-msg:${id}`;
}
function subKey(agentId: string): string {
  return `agent-sub:${agentId}`;
}

export interface MessengerStore {
  /** 发送消息（签名 + 持久化） */
  send(
    senderId: string,
    receiverId: string,
    mode: "event" | "rpc" | "observe",
    type: string,
    payload: Record<string, unknown>,
    config?: MessengerConfig,
  ): Promise<AgentMessage>;
  /** 获取 Agent 的待处理消息 */
  receive(agentId: string): Promise<AgentMessage[]>;
  /** 标记消息已处理 */
  ack(messageId: string): Promise<void>;
  /** 标记消息失败（触发重试） */
  nack(messageId: string, error: string): Promise<void>;
  /** 获取死信消息 */
  getDeadLetters(): Promise<AgentMessage[]>;

  /** 订阅事件 */
  subscribe(agentId: string, eventTypes: string[]): Promise<AgentSubscription>;
  /** 取消订阅 */
  unsubscribe(agentId: string): Promise<void>;
  /** 心跳 */
  heartbeat(agentId: string): Promise<void>;
  /** 获取超时未心跳的订阅 */
  getStaleSubscriptions(heartbeatTimeoutMs?: number): Promise<AgentSubscription[]>;

  /** 生成新 secret（Agent 重启时） */
  rotateSecret(agentId: string): Promise<string>;
}

export function createMessengerStore(
  messages: DurableMap<AgentMessage>,
  subscriptions: DurableMap<AgentSubscription>,
): MessengerStore {
  const config = { ...DEFAULT_MESSENGER_CONFIG };
  let agentSecret = "";

  function signMessage(msg: Partial<AgentMessage>, secret: string): string {
    const payload = `${msg.senderId}:${msg.receiverId}:${msg.type}:${msg.timestamp}:${msg.nonce}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  return {
    async send(senderId, receiverId, mode, type, payload, cfg) {
      const secret = cfg?.agentSecret ?? agentSecret ?? randomUUID();
      const now = Date.now();
      const msg: AgentMessage = {
        id: randomUUID(),
        senderId,
        receiverId,
        mode,
        type,
        payload,
        timestamp: now,
        nonce: randomUUID().slice(0, 16),
        signature: "",
        idempotencyKey: `${senderId}:${type}:${now.toString(36)}`,
        status: "pending",
        retryCount: 0,
        createdAt: now,
      };
      msg.signature = signMessage(msg, secret);
      await messages.put(msgKey(msg.id), msg);
      return msg;
    },

    async receive(agentId: string): Promise<AgentMessage[]> {
      const all = await messages.all();
      return all.filter((m) => m.receiverId === agentId && m.status === "pending");
    },

    async ack(messageId: string): Promise<void> {
      const msg = await messages.get(msgKey(messageId));
      if (!msg) return;
      msg.status = "delivered";
      await messages.put(msgKey(messageId), msg);
    },

    async nack(messageId: string, error: string): Promise<void> {
      const msg = await messages.get(msgKey(messageId));
      if (!msg) return;
      msg.retryCount += 1;
      if (msg.retryCount >= config.deadLetterThreshold) {
        msg.status = "dead";
      } else {
        msg.status = "failed";
        msg.nextRetryAt = Date.now() + config.retryBaseMs * Math.pow(2, msg.retryCount - 1);
      }
      await messages.put(msgKey(messageId), msg);
    },

    async getDeadLetters(): Promise<AgentMessage[]> {
      return (await messages.all()).filter((m) => m.status === "dead");
    },

    async subscribe(agentId: string, eventTypes: string[]): Promise<AgentSubscription> {
      const sub: AgentSubscription = {
        agentId,
        eventTypes,
        lastHeartbeat: Date.now(),
        active: true,
      };
      await subscriptions.put(subKey(agentId), sub);
      return sub;
    },

    async unsubscribe(agentId: string): Promise<void> {
      const sub = await subscriptions.get(subKey(agentId));
      if (sub) {
        sub.active = false;
        await subscriptions.put(subKey(agentId), sub);
      }
    },

    async heartbeat(agentId: string): Promise<void> {
      const sub = await subscriptions.get(subKey(agentId));
      if (sub) {
        sub.lastHeartbeat = Date.now();
        sub.active = true;
        await subscriptions.put(subKey(agentId), sub);
      }
    },

    async getStaleSubscriptions(heartbeatTimeoutMs?: number): Promise<AgentSubscription[]> {
      const timeout = heartbeatTimeoutMs ?? 30_000;
      const all = await subscriptions.all();
      const now = Date.now();
      return all.filter((s) => s.active && now - s.lastHeartbeat > timeout);
    },

    async rotateSecret(agentId: string): Promise<string> {
      agentSecret = randomUUID();
      return agentSecret;
    },
  };
}
