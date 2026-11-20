import type { Api, Model } from "@earendil-works/pi-ai";

const preferred: Readonly<Record<string, readonly string[]>> = {
  "openai-codex": ["gpt-6-astra", "gpt-5.6-sol"],
  anthropic: ["claude-haiku-5-5", "claude-haiku-4-5"],
  openai: ["gpt-4.1-mini"],
  google: ["gemini-2.5-flash"],
  openrouter: ["anthropic/claude-haiku-4.5"],
  opencode: ["deepseek-v4.1-flash"],
  "opencode-go": ["deepseek-v4.1-flash"],
  zai: ["glm-5.3-flash"],
  deepseek: ["deepseek-flash"],
};

export function pickerModel(model: Model<Api>): boolean {
  return !/(?:^|[-:])free$/i.test(model.id) && Object.values(model.cost).some((cost) => typeof cost === "number" && cost > 0);
}

export function defaultModel(models: readonly Model<Api>[]) {
  const candidates = models.filter(pickerModel);
  const provider = candidates[0]?.provider;
  const ids = provider && Object.hasOwn(preferred, provider) ? preferred[provider] : [];
  return ids.map((id) => candidates.find((model) => model.id === id)).find(Boolean) ?? candidates[0];
}

export function createModelReadiness() {
  const ready = new Map<string, { source: string; provider: string; model: string }>();
  const key = (source: string, provider: string, model: string) => JSON.stringify([source, provider, model]);
  return {
    isReady(source: string, provider: string, model: string) { return ready.has(key(source, provider, model)); },
    record(source: string, provider: string, model: string, success: boolean) {
      const id = key(source, provider, model);
      if (success) {
        if (ready.size >= 4096 && !ready.has(id)) ready.delete(ready.keys().next().value!);
        ready.set(id, { source, provider, model });
      } else ready.delete(id);
    },
    clear(source: string, provider?: string) {
      for (const [id, record] of ready) {
        if (record.source === source && (provider === undefined || record.provider === provider)) ready.delete(id);
      }
    },
  };
}

export const modelReadiness = createModelReadiness();
