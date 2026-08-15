/**
 * Durable, encrypted storage for custom model providers.
 *
 * Mirrors model-credential-store: specs live in a DurableMap, API keys
 * are encrypted at rest with a key derived from the connector secret,
 * and the store never hands the plaintext key to anything but the
 * per-call resolver.
 */

import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import {
  isGrandfatheredCustomProviderId,
  runtimeCustomProviderSpecs,
  validateCustomProviderSpec,
  type CustomProviderSpec,
} from "./custom-providers.ts";

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface CustomProviderRuntimeSnapshot {
  providers: CustomProviderSpec[];
  keys: Record<string, string>;
}

export interface CustomProviderStore {
  /** Enabled specs only — what the runtime registry should serve. */
  enabled(): Promise<CustomProviderSpec[]>;
  /** Everything, for the admin surface (no secrets). */
  statuses(): Promise<CustomProviderStatus[]>;
  /** Plaintext key for one provider, or null when absent/disabled. */
  resolveKey(id: string): Promise<string | null>;
  runtimeSnapshot(): Promise<CustomProviderRuntimeSnapshot>;
  canUpdateGrandfatheredProvider(id: string): Promise<boolean>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models,
  };
}

export function createCustomProviderStore(input: {
  backing: DurableMap<StoredCustomProvider>;
  keyMaterial: string | Buffer;
  advisoryLock?: AdvisoryLock;
}): CustomProviderStore {
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");
  const advisoryLock = input.advisoryLock ?? createNoopAdvisoryLock();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => advisoryLock.withLock("custom-model-providers", fn);

  return {
    async enabled() {
      const all = await input.backing.all();
      return runtimeCustomProviderSpecs(all.filter((p) => !p.disabled).map(strip));
    },

    async statuses() {
      const all = await input.backing.all();
      return all
        .map((p) => ({
          ...strip(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async runtimeSnapshot() {
      return mutate(async () => {
        const all = await input.backing.all();
        const providers = runtimeCustomProviderSpecs(all.filter((provider) => !provider.disabled).map(strip));
        const savedById = new Map(all.map((provider) => [provider.id, provider]));
        const keys: Record<string, string> = {};
        for (const provider of providers) {
          const saved = savedById.get(provider.id);
          if (!saved?.apiKeyEnc) continue;
          try {
            keys[provider.id] = decryptSecret(saved.apiKeyEnc, key);
          } catch {
            continue;
          }
        }
        return { providers, keys };
      });
    },

    async canUpdateGrandfatheredProvider(id) {
      if (!isGrandfatheredCustomProviderId(id)) return false;
      const existing = await input.backing.get(id);
      return Boolean(existing && !existing.disabled);
    },

    async upsert(spec, apiKey, updatedBy) {
      const actor = updatedBy.trim();
      if (!actor) throw new Error("updatedBy is required");
      await mutate(async () => {
        const existing = await input.backing.get(spec.id);
        validateCustomProviderSpec(spec, {
          allowReservedProviderId: Boolean(existing && !existing.disabled && isGrandfatheredCustomProviderId(spec.id)),
        });
        const providers = await input.backing.all();
        const conflict = providers
          .filter((provider) => !provider.disabled && provider.id !== spec.id)
          .find((provider) => provider.models.some((model) => spec.models.some((candidate) => candidate.id === model.id)));
        if (conflict) {
          const model = spec.models.find((candidate) => conflict.models.some((existing) => existing.id === candidate.id));
          throw new Error(`model "${model!.id}" is already registered by provider "${conflict.id}"`);
        }
        const trimmedKey = apiKey?.trim();
        if (
          existing?.apiKeyEnc &&
          !trimmedKey &&
          (existing.protocol !== spec.protocol || existing.baseUrl !== spec.baseUrl)
        ) {
          throw new Error("changing a provider endpoint or protocol requires a new API key");
        }
        const apiKeyEnc = trimmedKey ? encryptSecret(trimmedKey, key) : existing?.apiKeyEnc;
        await input.backing.put(spec.id, {
          ...spec,
          ...(apiKeyEnc ? { apiKeyEnc } : {}),
          disabled: false,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id, updatedBy) {
      return mutate(async () => {
        const existing = await input.backing.get(id);
        if (!existing || existing.disabled) return false;
        await input.backing.put(id, {
          ...existing,
          disabled: true,
          updatedAt: Date.now(),
          updatedBy,
        });
        return true;
      });
    },
  };
}
