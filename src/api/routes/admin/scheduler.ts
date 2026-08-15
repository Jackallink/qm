/**
 * Scheduler API — /v1/admin/scheduler
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { authorizeAdmin, orgScope } from "../shared.ts";

export async function listJobs(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.schedulerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const jobs = await ctx.deps.schedulerStore.listActive();
  return sendJson(ctx.res, 200, { jobs });
}

export async function scheduleJob(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.schedulerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  const workspace = typeof body.workspace === "string" ? body.workspace : "org:acme";
  const cron = typeof body.cron === "string" ? body.cron : "";
  if (!agentId || !cron) return sendJson(ctx.res, 400, { error: "bad_request", message: "agentId and cron required" });
  const job = await ctx.deps.schedulerStore.schedule(agentId, workspace, cron);
  return sendJson(ctx.res, 201, { job });
}

export async function pauseJob(ctx: ApiCtx): Promise<void> {
  const { jobId } = ctx.params;
  if (!jobId || !ctx.deps.schedulerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  await ctx.deps.schedulerStore.pause(jobId);
  return sendJson(ctx.res, 200, { ok: true });
}

export async function resumeJob(ctx: ApiCtx): Promise<void> {
  const { jobId } = ctx.params;
  if (!jobId || !ctx.deps.schedulerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  await ctx.deps.schedulerStore.resume(jobId);
  return sendJson(ctx.res, 200, { ok: true });
}

export async function checkLoop(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.schedulerStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  const sopRunId = (ctx.body as Record<string, unknown> | null)?.sopRunId as string | undefined;
  if (!sopRunId) return sendJson(ctx.res, 400, { error: "bad_request", message: "sopRunId required" });
  const result = await ctx.deps.schedulerStore.checkLoop(sopRunId);
  return sendJson(ctx.res, 200, result);
}

export const schedulerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/scheduler/jobs", auth: "either", handle: listJobs },
  { method: "POST", path: "/v1/admin/scheduler/jobs", auth: "either", handle: scheduleJob },
  { method: "POST", path: "/v1/admin/scheduler/jobs/:jobId/pause", auth: "either", handle: pauseJob },
  { method: "POST", path: "/v1/admin/scheduler/jobs/:jobId/resume", auth: "either", handle: resumeJob },
  { method: "POST", path: "/v1/admin/scheduler/check-loop", auth: "either", handle: checkLoop },
];
