/**
 * SOP Engine API — /v1/sop-runs
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { newSopRun } from "../../../agent/sop-engine.ts";
import type { GateNumber } from "../../../agent/sop-engine.ts";

function parseGate(s: string | undefined): GateNumber | null {
  if (!s) return null;
  const n = Number(s);
  if (n >= 0 && n <= 5 && Number.isInteger(n)) return n as GateNumber;
  return null;
}

// ---- Handlers ----

export async function listRuns(ctx: ApiCtx): Promise<void> {
  const { ws } = ctx.params;
  if (!ws || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const runs = await ctx.deps.sopStore.list(ws);
  return sendJson(ctx.res, 200, { runs });
}

export async function getRun(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const run = await ctx.deps.sopStore.get(id);
  if (!run) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { run });
}

export async function createRun(ctx: ApiCtx): Promise<void> {
  const { ws } = ctx.params;
  if (!ws || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : null;
  const agentId = typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : "default";
  if (!modelId) return sendJson(ctx.res, 400, { error: "bad_request", message: "modelId is required" });
  const id = typeof body.id === "string" && body.id.trim()
    ? body.id.trim()
    : `${modelId}-${Date.now().toString(36)}`;
  const run = newSopRun(id, modelId, ws, agentId);
  await ctx.deps.sopStore.create(run);
  audit(ctx.deps, { principalId: authorized.id, action: "soprun.create", resource: id, scopeLabel: ws });
  return sendJson(ctx.res, 201, { run });
}

export async function signGate(ctx: ApiCtx): Promise<void> {
  const { id, gate } = ctx.params;
  if (!id || !gate || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const g = parseGate(gate);
  if (g === null) return sendJson(ctx.res, 400, { error: "bad_request", message: "gate must be 0-5" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const productHash = typeof body.productHash === "string" ? body.productHash : undefined;
  const auditScore = typeof body.auditScore === "number" ? body.auditScore : undefined;
  try {
    const run = await ctx.deps.sopStore.signGate(id, g, authorized.id, productHash, auditScore);
    audit(ctx.deps, { principalId: authorized.id, action: "soprun.sign", resource: id, scopeLabel: run.workspace });
    return sendJson(ctx.res, 200, { run });
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
}

export async function rollbackGate(ctx: ApiCtx): Promise<void> {
  const { id, gate } = ctx.params;
  if (!id || !gate || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const g = parseGate(gate);
  if (g === null) return sendJson(ctx.res, 400, { error: "bad_request", message: "gate must be 0-5" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason : "manual rollback";
  try {
    const run = await ctx.deps.sopStore.rollback(id, g, reason);
    audit(ctx.deps, { principalId: authorized.id, action: "soprun.rollback", resource: id, scopeLabel: run.workspace });
    return sendJson(ctx.res, 200, { run });
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
}

export async function getHistory(ctx: ApiCtx): Promise<void> {
  const { id } = ctx.params;
  if (!id || !ctx.deps.sopStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const run = await ctx.deps.sopStore.get(id);
  if (!run) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { gates: run.gates, currentGate: run.currentGate, status: run.status });
}

// ---- Routes ----

export const sopRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/workspaces/:ws/sop-runs", auth: "either", handle: listRuns },
  { method: "GET", path: "/v1/sop-runs/:id", auth: "either", handle: getRun },
  { method: "POST", path: "/v1/admin/workspaces/:ws/sop-runs", auth: "either", handle: createRun },
  { method: "POST", path: "/v1/sop-runs/:id/gates/:gate/sign", auth: "either", handle: signGate },
  { method: "POST", path: "/v1/sop-runs/:id/gates/:gate/rollback", auth: "either", handle: rollbackGate },
  { method: "GET", path: "/v1/sop-runs/:id/history", auth: "either", handle: getHistory },
];
