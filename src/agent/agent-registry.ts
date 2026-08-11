/**
 * Agent Registry — CRUD store backed by QM artifactMap.
 *
 * Each workspace has its own set of registered agents. The store
 * validates the manifest on write and supports listing, lookup,
 * and lifecycle transitions (status machine).
 */
import type { AgentManifest, AgentStatus, AgentTemplateId } from "./agent-manifest.ts";
import { AGENT_TEMPLATES } from "./agent-manifest.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface AgentRegistryStore {
  /** 注册或更新 Agent */
  put(workspace: string, manifest: AgentManifest): Promise<AgentManifest>;
  /** 获取单个 Agent */
  get(workspace: string, agentId: string): Promise<AgentManifest | null>;
  /** 列出 workspace 下所有 Agent */
  list(workspace: string): Promise<AgentManifest[]>;
  /** 删除 Agent（实际是标记 stopped） */
  delete(workspace: string, agentId: string): Promise<boolean>;
}

/** 状态转换规则 */
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  draft: ["deploying"],
  deploying: ["online", "error"],
  online: ["stopping", "error"],
  error: ["deploying", "stopping"],
  stopping: ["stopped"],
  stopped: ["deploying"],
};

export function isValidStatusTransition(from: AgentStatus, to: AgentStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

/** 构建 Manifest key */
function agentKey(workspace: string, agentId: string): string {
  return `agent:${workspace}:${agentId}`;
}

function workspacePrefix(workspace: string): string {
  return `agent:${workspace}:`;
}

/** 从模板构建默认 Manifest */
export function newAgentFromTemplate(
  workspace: string,
  agentId: string,
  name: string,
  templateId: AgentTemplateId,
  registeredBy: string,
  overrides: Partial<AgentManifest> = {},
): AgentManifest {
  const tpl = AGENT_TEMPLATES[templateId];
  const now = Date.now();
  const base: AgentManifest = {
    id: agentId,
    name,
    workspace,
    template: templateId,
    status: "draft",
    version: 1,
    identity: { agentId, registeredBy, issuedAt: now },
    harness: "prime",
    model: { primary: "deepseek-v4-flash", tokenLimit: 100_000 },
    capabilities: { skills: [], tags: [], operations: {} },
    runtime: { lifecycle: "on-demand", sandbox: "physical" },
    security: { visibility: "private", acl: { invoke: [], manage: [] } },
    createdAt: now,
    updatedAt: now,
    ...tpl.manifest,
  };
  // Override name with user-provided
  base.name = name;
  // Apply user overrides (shallow merge for nested)
  if (overrides.harness) base.harness = overrides.harness;
  if (overrides.model) base.model = { ...base.model, ...overrides.model };
  if (overrides.capabilities) base.capabilities = { ...base.capabilities, ...overrides.capabilities };
  if (overrides.runtime) base.runtime = { ...base.runtime, ...overrides.runtime };
  if (overrides.security) base.security = { ...base.security, ...overrides.security };
  return base;
}

export function createAgentRegistryStore(backing: DurableMap<AgentManifest>): AgentRegistryStore {
  return {
    async put(workspace: string, manifest: AgentManifest): Promise<AgentManifest> {
      const existing = await backing.get(agentKey(workspace, manifest.id));
      if (existing) {
        // 状态转换校验
        if (manifest.status !== existing.status) {
          if (!isValidStatusTransition(existing.status, manifest.status)) {
            throw new Error(
              `Invalid status transition: ${existing.status} → ${manifest.status} for agent ${manifest.id}`,
            );
          }
        }
        manifest.version = (existing.version ?? 0) + 1;
      }
      manifest.updatedAt = Date.now();
      await backing.put(agentKey(workspace, manifest.id), manifest);
      return manifest;
    },

    async get(workspace: string, agentId: string): Promise<AgentManifest | null> {
      return backing.get(agentKey(workspace, agentId));
    },

    async list(workspace: string): Promise<AgentManifest[]> {
      const all = await backing.all();
      const prefix = workspacePrefix(workspace);
      return all.filter((m) => m.workspace === workspace && m.status !== "draft");
    },

    async delete(workspace: string, agentId: string): Promise<boolean> {
      const existing = await backing.get(agentKey(workspace, agentId));
      if (!existing) return false;
      // 软删除：标记 stopped
      existing.status = "stopped";
      existing.updatedAt = Date.now();
      await backing.put(agentKey(workspace, agentId), existing);
      return true;
    },
  };
}
