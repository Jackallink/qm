export interface ModelEntry {
  id: string;
  name: string;
  fastMode: boolean;
  webui: boolean;
  base: boolean;
  auxiliary?: boolean;
  clone?: {
    template: string;
    input: number;
    output: number;
    cacheWrite?: number;
    contextWindow: number;
    maxTokens: number;
  };
}

const GPT_56_CLONE = { template: "gpt-5.5", contextWindow: 1_050_000, maxTokens: 128_000 } as const;

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "claude-fable-5", name: "Claude Fable 5", fastMode: false, webui: true, base: true },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      template: "claude-opus-4-8",
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", fastMode: true, webui: true, base: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", fastMode: false, webui: true, base: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", fastMode: false, webui: true, base: true, auxiliary: true },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    fastMode: false,
    webui: true,
    base: true,
    clone: { ...GPT_56_CLONE, input: 5, output: 30 },
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    fastMode: false,
    webui: true,
    base: true,
    clone: { ...GPT_56_CLONE, input: 2.5, output: 15 },
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    fastMode: false,
    webui: true,
    base: true,
    auxiliary: true,
    clone: { ...GPT_56_CLONE, input: 1, output: 6 },
  },
  { id: "openrouter/auto", name: "OpenRouter Auto", fastMode: false, webui: true, base: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", fastMode: true, webui: false, base: false },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", fastMode: true, webui: false, base: false },
];
