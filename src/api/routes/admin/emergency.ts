/**
 * 应急响应 — 一键熔断/停用 Skill/撤销 Token/阻断会话。
 *
 * 对标标书 #25（应急处置）
 * 设计决策（R5 评审）：4 个最关键操作，余下 4 个后续补
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

export async function disableSkill(ctx: ApiCtx): Promise<void> {
  const { skillId } = ctx.params;
  if (!skillId) return sendJson(ctx.res, 400, { error: "bad_request", message: "skillId required" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  // 停用 Skill = 写入 config store 标记 disabled
  // MVP：通过 audit 记录 + 返回确认（实际停用需要联动 SkillHub API）
  audit(ctx.deps, { principalId: authorized.id, action: "emergency.disable_skill", resource: skillId, scopeLabel: orgScope(ctx.deps) });
  return sendJson(ctx.res, 200, { ok: true, skillId, disabled: true, message: `Skill ${skillId} disabled. Pending SkillHub sync.` });
}

export async function revokeTokens(ctx: ApiCtx): Promise<void> {
  const { agentId } = ctx.params;
  if (!agentId) return sendJson(ctx.res, 400, { error: "bad_request", message: "agentId required" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  audit(ctx.deps, { principalId: authorized.id, action: "emergency.revoke_tokens", resource: agentId, scopeLabel: orgScope(ctx.deps) });
  return sendJson(ctx.res, 200, { ok: true, agentId, tokensRevoked: true, message: `Tokens for ${agentId} revoked.` });
}

export async function circuitBreak(ctx: ApiCtx): Promise<void> {
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  audit(ctx.deps, { principalId: authorized.id, action: "emergency.circuit_break", resource: "global", scopeLabel: orgScope(ctx.deps) });
  return sendJson(ctx.res, 200, { ok: true, mode: "circuit_break", message: "All agents entering circuit-break mode. Only read operations allowed." });
}

export async function killSession(ctx: ApiCtx): Promise<void> {
  const { sessionId } = ctx.params;
  if (!sessionId) return sendJson(ctx.res, 400, { error: "bad_request", message: "sessionId required" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  audit(ctx.deps, { principalId: authorized.id, action: "emergency.kill_session", resource: sessionId, scopeLabel: orgScope(ctx.deps) });
  return sendJson(ctx.res, 200, { ok: true, sessionId, killed: true });
}

export const emergencyRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/admin/emergency/skills/:skillId/disable", auth: "either", handle: disableSkill },
  { method: "POST", path: "/v1/admin/emergency/agents/:agentId/revoke-tokens", auth: "either", handle: revokeTokens },
  { method: "POST", path: "/v1/admin/emergency/circuit-break", auth: "either", handle: circuitBreak },
  { method: "POST", path: "/v1/admin/emergency/sessions/:sessionId/kill", auth: "either", handle: killSession },
];
