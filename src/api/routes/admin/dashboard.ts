/**
 * 运营看板 — 聚合查询 API。
 *
 * 对标标书 #18（运营分析）
 * 数据源：audit_log + session_llm_requests + budget_spend
 */
import { sendJson } from "../../http.ts";
import type { ApiCtx, Route } from "../route.ts";
import { authorizeAdmin, orgScope } from "../shared.ts";

export async function dashboardSummary(ctx: ApiCtx): Promise<void> {
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  // 从 audit_log / budget_spend 聚合数据
  // MVP: 返回框架 + 说明（真实聚合需要 Postgres 查询）
  return sendJson(ctx.res, 200, {
    agents: { total: "FROM agent_registry", online: "FROM agent_health" },
    turns: { total24h: "FROM audit_log WHERE action=turn AND at>now()-86400000", successRate: "FROM turn_metrics" },
    tokens: { total24h: "FROM budget_spend WHERE at>now()-86400000" },
    topSkills: "FROM audit_log GROUP BY resource",
  });
}

export async function tokenTrends(ctx: ApiCtx): Promise<void> {
  const days = Number(ctx.url?.searchParams?.get("days") ?? 7);
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  return sendJson(ctx.res, 200, {
    period: `${days}d`,
    data: "FROM budget_spend GROUP BY date_trunc('day', to_timestamp(at/1000))",
  });
}

export async function agentActivity(ctx: ApiCtx): Promise<void> {
  const authorized = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!authorized) return;
  return sendJson(ctx.res, 200, {
    active: "FROM audit_log WHERE action=turn AND at>now()-86400000 GROUP BY principal_id",
    topAgents: "FROM audit_log GROUP BY scope_label ORDER BY count DESC LIMIT 10",
  });
}

export const dashboardRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/dashboard/summary", auth: "either", handle: dashboardSummary },
  { method: "GET", path: "/v1/admin/dashboard/token-trends", auth: "either", handle: tokenTrends },
  { method: "GET", path: "/v1/admin/dashboard/agent-activity", auth: "either", handle: agentActivity },
];
