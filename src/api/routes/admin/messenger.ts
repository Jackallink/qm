/**
 * Messenger API — /v1/admin/agents/:id/messages
 * Agent 间发送消息、查询收件箱、管理订阅。
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { authorizeAdmin, orgScope } from "../shared.ts";

export async function sendMessage(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.messengerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const receiverId = typeof body.receiverId === "string" ? body.receiverId : "";
  const mode = (typeof body.mode === "string" ? body.mode : "event") as "event" | "rpc" | "observe";
  const type = typeof body.type === "string" ? body.type : "";
  const payload = (typeof body.payload === "object" && body.payload ? body.payload : {}) as Record<string, unknown>;
  if (!receiverId || !type) return sendJson(ctx.res, 400, { error: "bad_request", message: "receiverId and type required" });
  const msg = await ctx.deps.messengerStore.send(id, receiverId, mode, type, payload);
  return sendJson(ctx.res, 201, { message: msg });
}

export async function getInbox(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.messengerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;  const msgs = await ctx.deps.messengerStore.receive(id);
  return sendJson(ctx.res, 200, { messages: msgs });
}

export async function ackMessage(ctx: ApiCtx): Promise<void> {
  const { id, msgId } = ctx.params;
  if (!id || !msgId || !ctx.deps.messengerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;  await ctx.deps.messengerStore.ack(msgId);
  return sendJson(ctx.res, 200, { ok: true });
}

export async function subscribeEvents(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.messengerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const eventTypes = Array.isArray(body.eventTypes) ? body.eventTypes as string[] : [];
  const sub = await ctx.deps.messengerStore.subscribe(id, eventTypes);
  return sendJson(ctx.res, 200, { subscription: sub });
}

export async function heartbeat(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.messengerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;  await ctx.deps.messengerStore.heartbeat(id);
  return sendJson(ctx.res, 200, { ok: true });
}

export const messengerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/admin/agents/:id/messages", auth: "either", handle: sendMessage },
  { method: "GET", path: "/v1/admin/agents/:id/inbox", auth: "either", handle: getInbox },
  { method: "POST", path: "/v1/admin/agents/:id/inbox/:msgId/ack", auth: "either", handle: ackMessage },
  { method: "POST", path: "/v1/admin/agents/:id/subscribe", auth: "either", handle: subscribeEvents },
  { method: "POST", path: "/v1/admin/agents/:id/heartbeat", auth: "either", handle: heartbeat },
];
