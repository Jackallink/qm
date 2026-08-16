import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRoutes } from "../src/api/routes/index.ts";
import { findRoute } from "../src/api/routes/route.ts";

test("agent management routes are registered in the route table", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["GET", "/v1/agent-templates"],
    ["GET", "/v1/admin/workspaces/ws-1/agents"],
    ["POST", "/v1/admin/workspaces/ws-1/agents"],
    ["GET", "/v1/admin/workspaces/ws-1/agents/agent-1"],
    ["PUT", "/v1/admin/workspaces/ws-1/agents/agent-1"],
    ["DELETE", "/v1/admin/workspaces/ws-1/agents/agent-1"],
    ["GET", "/v1/admin/agents/running"],
    ["GET", "/v1/admin/agents/agent-1/health"],
    ["POST", "/v1/admin/agents/agent-1/control-heartbeat"],
    ["GET", "/v1/admin/workspaces/ws-1/sop-runs"],
    ["POST", "/v1/admin/workspaces/ws-1/sop-runs"],
    ["GET", "/v1/sop-runs/sop-1"],
    ["POST", "/v1/sop-runs/sop-1/gates/1/sign"],
    ["POST", "/v1/sop-runs/sop-1/gates/1/rollback"],
    ["GET", "/v1/sop-runs/sop-1/history"],
    ["POST", "/v1/admin/agents/agent-1/messages"],
    ["GET", "/v1/admin/agents/agent-1/inbox"],
    ["POST", "/v1/admin/agents/agent-1/subscribe"],
    ["POST", "/v1/admin/agents/agent-1/heartbeat"],
    ["GET", "/v1/admin/scheduler/jobs"],
    ["POST", "/v1/admin/scheduler/jobs"],
    ["POST", "/v1/admin/scheduler/jobs/job-1/pause"],
    ["POST", "/v1/admin/scheduler/jobs/job-1/resume"],
    ["POST", "/v1/admin/scheduler/check-loop"],
  ];
  for (const [method, path] of cases) {
    assert.ok(findRoute(apiRoutes, method, path), `${method} ${path} must be registered`);
  }
});

test("emergency and dashboard paths remain absent (still F0)", () => {
  for (const [method, path] of [
    ["POST", "/v1/admin/emergency/circuit-break"],
    ["GET", "/v1/admin/dashboard/summary"],
  ] as const) {
    assert.equal(findRoute(apiRoutes, method, path), null, `${method} ${path} must stay absent`);
  }
});
