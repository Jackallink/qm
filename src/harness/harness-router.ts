import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { defaultModelForHarness, isHarnessId, modelSupportedByHarness, type HarnessId } from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { Harness, HarnessTurnInput } from "./harness.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";

export interface RuntimeChoice {
  harnessId: HarnessId;
  modelId: string;
}

export type RuntimeChoiceRequest = Partial<RuntimeChoice> & { strictHarness?: HarnessId };

interface RuntimeCandidate {
  choice: RuntimeChoice;
  deferPiModelValidation: boolean;
}

function persistedCandidate(harnessId: HarnessId, modelId: string): RuntimeCandidate {
  return { choice: { harnessId, modelId }, deferPiModelValidation: harnessId === "pi" };
}

function isApprovedCandidate(candidate: RuntimeCandidate, approved: readonly HarnessId[]): boolean {
  return (
    approved.includes(candidate.choice.harnessId) &&
    (candidate.deferPiModelValidation || modelSupportedByHarness(candidate.choice.modelId, candidate.choice.harnessId))
  );
}

export function resolveRuntimeChoice(
  config: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel">,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: RuntimeChoiceRequest,
): RuntimeChoice {
  if (fallback.harnessId === "mock") return fallback;
  const approved = (config.getApprovedHarnesses() ?? [fallback.harnessId]).filter(isHarnessId);
  const strictHarness = requested?.strictHarness;
  const orgStored = config.getRuntimeSelection(orgScopeId);
  const orgLegacy = config.getBaseModel(orgScopeId);
  if (strictHarness && orgStored && orgStored.harnessId !== strictHarness) {
    throw new NonRetryableTurnError(`runtime ${orgStored.harnessId}/${orgStored.modelId} is not permitted in this mode`);
  }
  let configuredOrg: RuntimeCandidate;
  if (orgStored && isHarnessId(orgStored.harnessId)) {
    configuredOrg = persistedCandidate(orgStored.harnessId, orgStored.modelId);
  } else if (orgLegacy) {
    configuredOrg = persistedCandidate(fallback.harnessId, orgLegacy);
  } else {
    configuredOrg = { choice: fallback, deferPiModelValidation: false };
  }
  const firstApproved = approved.find(isHarnessId) ?? fallback.harnessId;
  const safeFallback: RuntimeCandidate =
    approved.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? { choice: fallback, deferPiModelValidation: false }
      : {
          choice: { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) },
          deferPiModelValidation: false,
        };
  const org = isApprovedCandidate(configuredOrg, approved) ? configuredOrg : safeFallback;
  const scopedStored = scope === orgScopeId ? null : config.getRuntimeSelection(scope);
  const scopedLegacy = scope === orgScopeId ? null : config.getBaseModel(scope);
  if (strictHarness && scopedStored && scopedStored.harnessId !== strictHarness) {
    throw new NonRetryableTurnError(
      `runtime ${scopedStored.harnessId}/${scopedStored.modelId} is not permitted in this mode`,
    );
  }
  let inherited = org;
  if (scopedStored && isHarnessId(scopedStored.harnessId)) {
    inherited = persistedCandidate(scopedStored.harnessId, scopedStored.modelId);
  } else if (scopedLegacy) {
    inherited = persistedCandidate(fallback.harnessId, scopedLegacy);
  }
  const hasRequestedChoice = Boolean(requested?.harnessId || requested?.modelId);
  if (strictHarness && requested?.harnessId && requested.harnessId !== strictHarness) {
    throw new NonRetryableTurnError(`runtime ${requested.harnessId} is not permitted in this mode`);
  }
  const selected: RuntimeCandidate =
    requested?.harnessId || requested?.modelId
      ? {
          choice: {
            harnessId: requested.harnessId ?? inherited.choice.harnessId,
            modelId: requested.modelId ?? inherited.choice.modelId,
          },
          deferPiModelValidation: false,
        }
      : inherited;
  if (!isApprovedCandidate(selected, approved)) {
    if (hasRequestedChoice)
      throw new NonRetryableTurnError(`runtime ${selected.choice.harnessId}/${selected.choice.modelId} is not approved`);
    return org.choice;
  }
  return selected.choice;
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: RuntimeChoiceRequest,
): Promise<RuntimeChoice> {
  const approved = (await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId];
  const [orgStored, scopedStored, orgLegacy, scopedLegacy] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    config.getBaseModelOwnDurable(orgScopeId),
    scope === orgScopeId ? null : config.getBaseModelOwnDurable(scope),
  ]);
  const view: Pick<ScopedConfigStore, "getApprovedHarnesses" | "getRuntimeSelection" | "getBaseModel"> = {
    getApprovedHarnesses: () => approved,
    getRuntimeSelection: (id: ScopeId) => {
      if (id === orgScopeId) return orgStored;
      return id === scope ? scopedStored : null;
    },
    getBaseModel: (id: ScopeId) => {
      if (id === orgScopeId) return orgLegacy;
      return id === scope ? scopedLegacy : null;
    },
  };
  return resolveRuntimeChoice(view, orgScopeId, scope, fallback, requested);
}

export function createHarnessRouter(
  adapters: ReadonlyMap<HarnessId, Harness>,
  utility: Harness,
  resolve: (input: HarnessTurnInput) => RuntimeChoice | Promise<RuntimeChoice>,
): Harness {
  const lastHarness = new Map<string, HarnessId>();
  return {
    profile: utility.profile,
    models: utility.models,
    tools: utility.tools,
    turns: {
      async runTurn(input) {
        const choice = await resolve(input);
        const adapter = adapters.get(choice.harnessId);
        if (!adapter) throw new Error(`harness ${choice.harnessId} is unavailable`);
        const prior = lastHarness.get(input.session.id);
        if (prior && prior !== choice.harnessId) {
          await adapters.get(prior)?.turns.resetSession?.(input.session.id);
          await adapter.turns.resetSession?.(input.session.id);
        }
        lastHarness.set(input.session.id, choice.harnessId);
        return adapter.turns.runTurn({ ...input, harness: choice.harnessId, model: choice.modelId });
      },
      async resetSession(sessionId) {
        lastHarness.delete(sessionId);
        await Promise.all([...adapters.values()].map((adapter) => adapter.turns.resetSession?.(sessionId)));
      },
      async close() {
        await Promise.all([...new Set(adapters.values())].map((adapter) => adapter.turns.close?.()));
      },
    },
  };
}
