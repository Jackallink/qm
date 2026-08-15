import type { Destination, SessionEntry, TurnOrigin } from "../types.ts";
import type { CustomProviderSpec } from "../model/custom-providers.ts";
import { contextSummaryPayload } from "../harness/context-compaction.ts";
import { resolveTurnOrigin } from "./turn-origin.ts";

type TextOnlyTurnInput = {
  surface?: string;
  text?: string;
  origin?: TurnOrigin;
  conversation?: { kind?: unknown };
  harness?: string;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  conversationHeader?: string;
  attachments?: readonly unknown[];
  inboundNotes?: readonly unknown[];
  surfaceTools?: boolean;
  proactiveOpener?: boolean;
  approval?: unknown;
  gatewayContext?: unknown;
  priorTurns?: readonly unknown[];
  overheard?: readonly unknown[];
  detectContext?: string;
  detectOpener?: string;
  envelopeWrapped?: boolean;
  triggered?: boolean;
  unprompted?: boolean;
  securityScreenData?: string;
  triggerDestination?: Destination;
  ownerKeychainUnion?: boolean;
  spawned?: boolean;
  liveActor?: boolean;
  triggerTs?: string;
  entryTs?: string;
  images?: unknown;
};

type TextOnlyProviderSnapshot = {
  providers: readonly CustomProviderSpec[];
  keys: Readonly<Record<string, string | undefined>>;
};

export function textOnlyNoRedirectFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, redirect: "manual" });
}

export function installTextOnlyNoRedirectFetch(): void {
  globalThis.fetch = textOnlyNoRedirectFetch(globalThis.fetch);
}

export function textOnlyTurnRefusal(input: TextOnlyTurnInput): string | undefined {
  const origin = resolveTurnOrigin(input);
  if (input.surface !== "web" || origin.kind !== "human" || input.conversation?.kind !== "dm") {
    return "text-only mode only accepts human web turns";
  }
  if (!input.text?.trim()) return "text-only mode requires text";
  if (input.harness !== undefined || input.model !== undefined || input.thinkingLevel !== undefined || input.fastMode !== undefined) {
    return "text-only mode only permits the server-selected pi runtime";
  }
  if (
    input.attachments?.length ||
    input.inboundNotes?.length ||
    input.surfaceTools ||
    input.proactiveOpener ||
    input.approval ||
    input.gatewayContext ||
    input.conversationHeader ||
    input.priorTurns?.length ||
    input.overheard?.length ||
    input.detectContext ||
    input.detectOpener ||
    input.envelopeWrapped ||
    input.triggered ||
    input.unprompted ||
    input.securityScreenData ||
    input.triggerDestination ||
    input.ownerKeychainUnion ||
    input.spawned ||
    input.images !== undefined
  ) {
    return "text-only mode does not permit tools, files, or automated input";
  }
  return undefined;
}

export function textOnlyModelRefusal(
  snapshot: TextOnlyProviderSnapshot | undefined,
  modelId: string,
): string | undefined {
  if (!snapshot) return "text-only mode requires an enabled custom-provider model with a configured key";
  const provider = snapshot.providers.find((candidate) => candidate.models.some((model) => model.id === modelId));
  if (!provider || !snapshot.keys[provider.id]?.trim()) {
    return "text-only mode requires an enabled custom-provider model with a configured key";
  }
  return textOnlyCustomProviderEndpointRefusal(provider.baseUrl);
}

export function textOnlyCustomProviderEndpointRefusal(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).protocol === "https:"
      ? undefined
      : "text-only mode requires an HTTPS custom-provider endpoint";
  } catch {
    return "text-only mode requires an HTTPS custom-provider endpoint";
  }
}

function hasFileBearingPayload(payload: Record<string, unknown>): boolean {
  return ["files", "attachments", "images", "artifacts", "artifactRefs", "file"].some(
    (name) => payload[name] !== undefined,
  );
}

export function textOnlyHistoryForModel(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.flatMap((entry) => {
    if (contextSummaryPayload(entry)) return [];
    if (entry.type !== "user" && entry.type !== "assistant") return [];
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (
      typeof payload.text !== "string" ||
      !payload.text.trim() ||
      payload.overheard === true ||
      payload.hidden === true ||
      payload.steered === true ||
      hasFileBearingPayload(payload)
    )
      return [];
    return [{ ...entry, payload: { text: payload.text } }];
  });
}
