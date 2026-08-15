/**
 * Custom model providers.
 *
 * An org admin can register additional model providers that speak one of
 * the two wire protocols we already run — OpenAI-compatible or
 * Anthropic-compatible — by giving a base URL, an API key, and the model
 * ids to expose. Registered models resolve like built-ins (the pi
 * harness reaches them through the same request path), surface in the
 * catalog, and are gated to harnesses that route through pi-ai.
 *
 * Secrets never live here: this module holds the runtime registry
 * (everything except the key). Keys stay in the encrypted store and are
 * resolved per-call by wiring alongside the built-in provider keys.
 */

import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { parseProviderBaseUrl, PROVIDER_IDS } from "./provider-endpoints.ts";
import { MODEL_REGISTRY } from "./model-registry.ts";

const nativeModel = getBuiltinModel as unknown as (provider: string, id: string) => unknown;

export const CUSTOM_PROVIDER_PROTOCOLS = ["openai", "anthropic"] as const;
export type CustomProviderProtocol = (typeof CUSTOM_PROVIDER_PROTOCOLS)[number];

interface CustomModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** USD per million input tokens. Defaults to 0 (unknown / not metered). */
  input?: number;
  /** USD per million output tokens. Defaults to 0. */
  output?: number;
}

export interface CustomProviderSpec {
  /** Slug: lowercase, digits, hyphens; also the model's `provider` value. */
  id: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  models: CustomModelSpec[];
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED = new Set<string>([...PROVIDER_IDS, ...getBuiltinProviders(), "mock", "radius"]);

function conflictsWithNativeModel(id: string): boolean {
  return MODEL_REGISTRY.some((model) => model.id === id) || PROVIDER_IDS.some((provider) => Boolean(nativeModel(provider, id)));
}

export function isReservedCustomProviderId(id: string): boolean {
  return RESERVED.has(id);
}

function isCoreManagedProviderId(id: string): boolean {
  return PROVIDER_IDS.some((provider) => provider === id);
}

export function isGrandfatheredCustomProviderId(id: string): boolean {
  return RESERVED.has(id) && !isCoreManagedProviderId(id) && id !== "mock" && id !== "radius";
}

export function validateCustomProviderSpec(
  spec: CustomProviderSpec,
  opts: { allowReservedProviderId?: boolean } = {},
): void {
  if (!SLUG_RE.test(spec.id)) {
    throw new Error(`provider id must match ${SLUG_RE} (lowercase slug), got "${spec.id}"`);
  }
  if (!opts.allowReservedProviderId && RESERVED.has(spec.id)) throw new Error(`provider id "${spec.id}" is reserved`);
  if (!spec.name.trim()) throw new Error("provider name is required");
  if (spec.name.length > 100) throw new Error("provider name must be 100 chars or fewer");
  if (!CUSTOM_PROVIDER_PROTOCOLS.includes(spec.protocol)) {
    throw new Error(`protocol must be one of ${CUSTOM_PROVIDER_PROTOCOLS.join(", ")}`);
  }
  parseProviderBaseUrl(`custom provider ${spec.id} baseUrl`, spec.baseUrl);
  if (!Array.isArray(spec.models) || spec.models.length === 0) {
    throw new Error("at least one model is required");
  }
  if (spec.models.length > 200) throw new Error("at most 200 models per provider");
  const seen = new Set<string>();
  for (const m of spec.models) {
    if (!m.id?.trim() || m.id.length > 200) throw new Error("every model needs an id (<=200 chars)");
    if (conflictsWithNativeModel(m.id)) throw new Error(`model "${m.id}" conflicts with a built-in model`);
    if (m.name !== undefined && (typeof m.name !== "string" || m.name.length > 200))
      throw new Error(`model "${m.id}": name must be a string of 200 chars or fewer`);
    if (seen.has(m.id)) throw new Error(`duplicate model id "${m.id}"`);
    seen.add(m.id);
    for (const [field, v] of [
      ["contextWindow", m.contextWindow],
      ["maxTokens", m.maxTokens],
      ["input", m.input],
      ["output", m.output],
    ] as const) {
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        throw new Error(`model "${m.id}": ${field} must be a non-negative number`);
      }
    }
  }
}

export interface CustomRuntimeModel {
  id: string;
  name: string;
  provider: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  reasoning: boolean;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

function deepSeekSemantics(modelId: string): Pick<CustomRuntimeModel, "reasoning" | "compat" | "thinkingLevelMap"> {
  const native = nativeModel("deepseek", modelId) as
    | {
        api?: unknown;
        reasoning?: unknown;
        compat?: Record<string, unknown>;
        thinkingLevelMap?: Record<string, string | null>;
      }
    | undefined;
  if (!native || native.api !== "openai-completions") return { reasoning: false };
  return {
    reasoning: native.reasoning === true,
    ...(native.compat ? { compat: { ...native.compat } } : {}),
    ...(native.thinkingLevelMap ? { thinkingLevelMap: { ...native.thinkingLevelMap } } : {}),
  };
}

function toRuntimeModel(provider: CustomProviderSpec, m: CustomModelSpec): CustomRuntimeModel {
  const semantics = provider.protocol === "openai" ? deepSeekSemantics(m.id) : { reasoning: false };
  return {
    id: m.id,
    name: m.name?.trim() || m.id,
    provider: provider.id,
    api: provider.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
    baseUrl: provider.baseUrl,
    ...semantics,
    input: ["text"],
    cost: { input: m.input ?? 0, output: m.output ?? 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

function toModelsJsonModel(provider: CustomProviderSpec, model: CustomModelSpec): Record<string, unknown> {
  const runtimeModel = toRuntimeModel(provider, model);
  return {
    id: runtimeModel.id,
    name: runtimeModel.name,
    contextWindow: runtimeModel.contextWindow,
    maxTokens: runtimeModel.maxTokens,
    reasoning: runtimeModel.reasoning,
    ...(runtimeModel.compat ? { compat: runtimeModel.compat } : {}),
    ...(runtimeModel.thinkingLevelMap ? { thinkingLevelMap: runtimeModel.thinkingLevelMap } : {}),
    cost: runtimeModel.cost,
  };
}

function cloneProviderSpec(spec: CustomProviderSpec): CustomProviderSpec {
  return { ...spec, models: spec.models.map((model) => ({ ...model })) };
}

let registry = new Map<string, CustomRuntimeModel>();
let providers: CustomProviderSpec[] = [];
let version = 0;

function providerSnapshot(specs: readonly CustomProviderSpec[]): string {
  return JSON.stringify(
    specs.map((spec) => ({
      id: spec.id,
      name: spec.name,
      protocol: spec.protocol,
      baseUrl: spec.baseUrl,
      models: spec.models.map((model) => ({
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        ...(model.input !== undefined ? { input: model.input } : {}),
        ...(model.output !== undefined ? { output: model.output } : {}),
      })),
    })),
  );
}

export function runtimeCustomProviderSpecs(specs: readonly CustomProviderSpec[]): CustomProviderSpec[] {
  const runtimeSpecs = specs.filter((spec) => !isCoreManagedProviderId(spec.id));
  const ids = new Map<string, number>();
  for (const spec of runtimeSpecs) {
    for (const model of spec.models) {
      if (!conflictsWithNativeModel(model.id)) ids.set(model.id, (ids.get(model.id) ?? 0) + 1);
    }
  }
  return runtimeSpecs.flatMap((spec) => {
    const models = spec.models.filter((model) => !conflictsWithNativeModel(model.id) && ids.get(model.id) === 1);
    return models.length ? [{ ...spec, models }] : [];
  });
}

export function customProviderSpecs(): CustomProviderSpec[] {
  return providers.map(cloneProviderSpec);
}

export function resolveCustomModelFromProviders(
  specs: readonly CustomProviderSpec[],
  id: string,
): CustomRuntimeModel | undefined {
  for (const spec of specs) {
    const model = spec.models.find((candidate) => candidate.id === id);
    if (model) return toRuntimeModel(spec, model);
  }
  return undefined;
}

export function hasCustomProviderModelKey(
  specs: readonly CustomProviderSpec[],
  keys: Readonly<Record<string, string | undefined>>,
  modelId: string,
): boolean {
  return specs.some((provider) => provider.models.some((model) => model.id === modelId) && Boolean(keys[provider.id]));
}

/**
 * Called by wiring at boot and again after every admin write, with the
 * full current set of enabled providers. Last write wins; built-in model
 * ids shadow custom ones at resolution, so a collision can't hijack a
 * built-in.
 */
export function setCustomProviders(specs: CustomProviderSpec[]): void {
  const runtimeSpecs = runtimeCustomProviderSpecs(specs);
  if (providerSnapshot(runtimeSpecs) === providerSnapshot(providers)) return;
  const next = new Map<string, CustomRuntimeModel>();
  for (const spec of runtimeSpecs) {
    for (const m of spec.models) {
      next.set(m.id, toRuntimeModel(spec, m));
    }
  }
  registry = next;
  providers = runtimeSpecs.map(cloneProviderSpec);
  version += 1;
}

/** Bumps on every registry change — lets callers cache derived artifacts. */
export function customProvidersVersion(): number {
  return version;
}

export function resolveCustomModel(id: string): CustomRuntimeModel | undefined {
  return registry.get(id);
}

export function isCustomModelId(id: string): boolean {
  return registry.has(id);
}

export function customModelCatalog(): Array<{ id: string; name: string; provider: string }> {
  return [...registry.values()].map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
}

/**
 * The models.json fragment pi-coding-agent understands. Materialized to a
 * temp file whenever the pi harness builds a model runtime, so the
 * runtime's own provider registry knows each custom provider natively —
 * a runtime API key alone is not enough (availability checks only cover
 * providers the ModelsStore knows).
 */
export function customModelsJson(specs: readonly CustomProviderSpec[] = providers): { providers: Record<string, unknown> } | undefined {
  if (specs.length === 0) return undefined;
  return {
    providers: Object.fromEntries(
      specs.map((spec) => [
        spec.id,
        {
          name: spec.name,
          baseUrl: spec.baseUrl,
          api: spec.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
          models: spec.models.map((model) => toModelsJsonModel(spec, model)),
        },
      ]),
    ),
  };
}
