/**
 * SOP Engine Store — CRUD + sign + rollback。
 *
 * 每个 SopRun 有独立的 advisory lock（复用 QM advisoryLock）。
 * 签收：当前 Gate 标记 done，产物冻结，进入下一 Gate。
 * 回退：当前 Gate 标记 superseded，创建新版本，回到指定 Gate。
 */
import type { SopRun, GateNumber } from "./sop-engine.ts";
import { newGateRecord, nextGate, canRollbackTo } from "./sop-engine.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface SopRunStore {
  create(run: SopRun): Promise<SopRun>;
  get(id: string): Promise<SopRun | null>;
  list(workspace: string): Promise<SopRun[]>;
  /** 签收当前 Gate，进入下一 Gate */
  signGate(id: string, gate: GateNumber, signedBy: string, productHash?: string, auditScore?: number): Promise<SopRun>;
  /** 回退到指定 Gate（旧产物 superseded，新建版本） */
  rollback(id: string, toGate: GateNumber, _reason: string): Promise<SopRun>;
  /** 标记 stale / archived */
  updateStatus(id: string, status: SopRun["status"]): Promise<SopRun>;
  /** 更新外部依赖验证时间 */
  verifyDeps(id: string, depNames: string[]): Promise<SopRun>;
}

function runKey(id: string): string {
  return `soprun:${id}`;
}

export function createSopRunStore(backing: DurableMap<SopRun>): SopRunStore {
  return {
    async create(run: SopRun): Promise<SopRun> {
      await backing.put(runKey(run.id), run);
      return run;
    },

    async get(id: string): Promise<SopRun | null> {
      return backing.get(runKey(id));
    },

    async list(workspace: string): Promise<SopRun[]> {
      const all = await backing.all();
      return all.filter((r) => r.workspace === workspace);
    },

    async signGate(
      id: string,
      gate: GateNumber,
      signedBy: string,
      productHash?: string,
      auditScore?: number,
    ): Promise<SopRun> {
      const updated = await backing.update!(runKey(id), (run) => {
        if (run.currentGate !== gate) throw new Error(`Expected gate ${run.currentGate}, got ${gate}`);
        const current = run.gates.find((g) => g.gate === gate && g.status === "in_progress");
        if (!current) throw new Error(`Gate ${gate} not in_progress`);
        current.status = "done";
        current.signedBy = signedBy;
        current.signedAt = Date.now();
        current.productHash = productHash;
        current.auditScore = auditScore;
        current.updatedAt = Date.now();
        const next = nextGate(gate);
        if (next !== null) {
          run.currentGate = next;
          run.gates.push(newGateRecord(next, 1));
        } else {
          run.status = "frozen";
        }
        run.updatedAt = Date.now();
        run.lastActiveAt = Date.now();
        return run;
      });
      if (!updated) throw new Error(`SopRun ${id} not found`);
      return updated;
    },

    async rollback(id: string, toGate: GateNumber, _reason: string): Promise<SopRun> {
      const updated = await backing.update!(runKey(id), (run) => {
        if (!canRollbackTo(run.currentGate, toGate))
          throw new Error(`Cannot rollback from gate ${run.currentGate} to ${toGate}`);
        for (const g of run.gates) {
          if (g.gate >= toGate && g.gate <= run.currentGate && g.status !== "superseded") {
            g.status = "superseded";
            g.updatedAt = Date.now();
          }
        }
        const existingVersions = run.gates
          .filter((g) => g.gate === toGate)
          .map((g) => g.productVersion);
        const newVersion = Math.max(0, ...existingVersions) + 1;
        run.currentGate = toGate;
        run.gates.push(newGateRecord(toGate, newVersion));
        run.updatedAt = Date.now();
        run.lastActiveAt = Date.now();
        return run;
      });
      if (!updated) throw new Error(`SopRun ${id} not found`);
      return updated;
    },

    async updateStatus(id: string, status: SopRun["status"]): Promise<SopRun> {
      const run = await backing.get(runKey(id));
      if (!run) throw new Error(`SopRun ${id} not found`);
      run.status = status;
      run.updatedAt = Date.now();
      await backing.put(runKey(id), run);
      return run;
    },

    async verifyDeps(id: string, depNames: string[]): Promise<SopRun> {
      const run = await backing.get(runKey(id));
      if (!run) throw new Error(`SopRun ${id} not found`);
      const now = Date.now();
      if (!run.externalDeps) run.externalDeps = [];
      for (const name of depNames) {
        const dep = run.externalDeps.find((d) => d.name === name);
        if (dep) dep.verifiedAt = now;
        else run.externalDeps.push({ type: "unknown", name, verifiedAt: now });
      }
      run.lastActiveAt = now;
      run.updatedAt = now;
      await backing.put(runKey(id), run);
      return run;
    },
  };
}
