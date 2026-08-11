/**
 * Agent Registry API — /v1/admin/workspaces/:ws/agents
 *
 * 注册、查看、更新、删除 workspace 级别的 Agent。
 * Auth: admin（复用 QM 的 authorizeAdmin）。
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { AgentManifest, AgentStatus, AgentTemplateId } from "../../../agent/agent-manifest.ts";
import { AGENT_TEMPLATES } from "../../../agent/agent-manifest.ts";
import { isValidStatusTransition, newAgentFromTemplate } from "../../../agent/agent-registry.ts";
import { reviewAgentRegistration } from "../../../agent/registration-pipeline.ts";

// ---- Helpers ----

function extractBody(ctx: ApiCtx) {
  const raw = (ctx.body ?? {}) as Record<string, unknown>;
  return {
    name: raw.name,
    template: raw.template,
    harness: raw.harness,
    model: raw.model,
    capabilities: raw.capabilities,
    runtime: raw.runtime,
    security: raw.security,
    status: raw.status,
  };
}

function agentFromBody(ws: string, agentId: string, body: ReturnType<typeof extractBody>): AgentManifest | null {
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  if (!name) return null;
  const templateId: AgentTemplateId =
    typeof body.template === "string" && body.template in AGENT_TEMPLATES
      ? (body.template as AgentTemplateId)
      : "custom";
  const registeredBy = "admin"; // TODO: from actor
  const overrides: Partial<AgentManifest> = {};
  if (typeof body.harness === "string") overrides.harness = body.harness as AgentManifest["harness"];
  if (body.model && typeof body.model === "object") {
    const m = body.model as Record<string, unknown>;
    overrides.model = {
      primary: typeof m.primary === "string" ? m.primary : "deepseek-v4-flash",
      ...(typeof m.fallback === "object" ? { fallback: m.fallback as string[] } : {}),
      ...(typeof m.tokenLimit === "number" ? { tokenLimit: m.tokenLimit } : {}),
      ...(typeof m.costLimit === "number" ? { costLimit: m.costLimit } : {}),
    };
  }
  // 传递 capabilities / security 嵌套对象
  if (body.capabilities && typeof body.capabilities === "object") {
    overrides.capabilities = body.capabilities as AgentManifest["capabilities"];
  }
  if (body.security && typeof body.security === "object") {
    overrides.security = body.security as AgentManifest["security"];
  }
  return newAgentFromTemplate(ws, agentId, name, templateId, registeredBy, overrides);
}

// ---- Handlers ----

export async function listAgents(ctx: ApiCtx): Promise<void> {
  const ws = ctx.params.ws!;
  if (!ctx.deps.agentRegistry) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const agents = await ctx.deps.agentRegistry.list(ws);
  return sendJson(ctx.res, 200, { agents });
}

export async function getAgent(ctx: ApiCtx): Promise<void> {
  const { ws, id } = ctx.params;
  if (!ws || !id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.deps.agentRegistry) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const agent = await ctx.deps.agentRegistry.get(ws, id);
  if (!agent) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { agent });
}

export async function createAgent(ctx: ApiCtx): Promise<void> {
  const ws = ctx.params.ws!;
  const bodyObj = (ctx.body ?? {}) as Record<string, unknown>;
  const id = (typeof bodyObj.id === 'string' ? bodyObj.id : '') ||
    (typeof bodyObj.name === 'string' ? (bodyObj.name as string).toLowerCase().replace(/[^a-z0-9-_]+/g, '-') : '');
  if (!ctx.deps.agentRegistry) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const body = extractBody(ctx);
  const manifest = agentFromBody(ws, id, body);
  if (!manifest) return sendJson(ctx.res, 400, { error: "bad_request", message: "name is required" });
  const existing = await ctx.deps.agentRegistry.get(ws, id);
  if (existing) return sendJson(ctx.res, 409, { error: "conflict", message: `agent ${id} already exists` });

  // 🔒 安全审查流水线
  const review = reviewAgentRegistration(manifest, {
    isPlatformAdmin: false, // 默认非平台管理员；公开 Agent 需额外审批
  });
  if (!review.passed) {
    return sendJson(ctx.res, 403, {
      error: "registration_rejected",
      message: `Gate ${review.blockedBy} failed`,
      review,
    });
  }

  await ctx.deps.agentRegistry.put(ws, manifest);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "agent.create",
    resource: id,
    scopeLabel: ws,
  });
  return sendJson(ctx.res, 201, { agent: manifest });
}

export async function updateAgent(ctx: ApiCtx): Promise<void> {
  const { ws, id } = ctx.params;
  if (!ws || !id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.deps.agentRegistry) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const existing = await ctx.deps.agentRegistry.get(ws, id);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = extractBody(ctx);

  // 状态转换
  if (typeof body.status === "string") {
    const newStatus = body.status as AgentStatus;
    if (!isValidStatusTransition(existing.status, newStatus)) {
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: `Invalid status transition: ${existing.status} → ${newStatus}`,
      });
    }
    existing.status = newStatus;
  }

  // 模型配置更新（需审批——TODO）
  if (body.model && typeof body.model === "object") {
    const m = body.model as Record<string, unknown>;
    if (typeof m.primary === "string") existing.model.primary = m.primary;
    if (typeof m.fallback === "object") existing.model.fallback = m.fallback as string[];
  }

  await ctx.deps.agentRegistry.put(ws, existing);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "agent.update",
    resource: id,
    scopeLabel: ws,
  });
  return sendJson(ctx.res, 200, { agent: existing });
}

export async function deleteAgent(ctx: ApiCtx): Promise<void> {
  const { ws, id } = ctx.params;
  if (!ws || !id) return sendJson(ctx.res, 404, { error: "not_found" });
  if (!ctx.deps.agentRegistry) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const ok = await ctx.deps.agentRegistry.delete(ws, id);
  if (!ok) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "agent.delete",
    resource: id,
    scopeLabel: ws,
  });
  return sendJson(ctx.res, 200, { ok: true });
}

export async function getTemplates(_ctx: ApiCtx): Promise<void> {
  const templates = Object.entries(AGENT_TEMPLATES).map(([id, tpl]) => ({ id, ...tpl }));
  return sendJson(_ctx.res, 200, { templates });
}

// ---- Routes ----

export const agentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/agent-templates", auth: "either", handle: getTemplates },
  { method: "GET", path: "/v1/admin/workspaces/:ws/agents", auth: "either", handle: listAgents },
  { method: "GET", path: "/v1/admin/workspaces/:ws/agents/:id", auth: "either", handle: getAgent },
  { method: "POST", path: "/v1/admin/workspaces/:ws/agents", auth: "either", handle: createAgent },
  { method: "PUT", path: "/v1/admin/workspaces/:ws/agents/:id", auth: "either", handle: updateAgent },
  { method: "DELETE", path: "/v1/admin/workspaces/:ws/agents/:id", auth: "either", handle: deleteAgent },
];
