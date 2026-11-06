/** Capture quota metadata that Pi's successful-response hook cannot see. */
export function captureAnthropicRateLimits<
  Model extends { provider: string }, Context,
  Options extends { fetch?: typeof globalThis.fetch }, Result,
>(
  agent: { streamFunction?: (model: Model, context: Context, options?: Options) => Result },
  onRateLimitHeaders: (headers: Record<string, string>) => void,
): void {
  const streamFunction = agent.streamFunction;
  if (typeof streamFunction !== "function") {
    console.warn("[model-quota] Pi streamFunction unavailable; 429 capture disabled");
    return;
  }
  agent.streamFunction = function (model, context, options) {
    if (model.provider !== "anthropic") return streamFunction.call(this, model, context, options);
    const fetch = options?.fetch ?? globalThis.fetch;
    return streamFunction.call(this, model, context, {
      ...options,
      fetch: async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args);
        if (response.status === 429) {
          try {
            const headers: Record<string, string> = {};
            response.headers.forEach((value, name) => {
              if (name.startsWith("anthropic-ratelimit-unified-")) headers[name] = value;
            });
            onRateLimitHeaders(headers);
          } catch {
            // Quota capture must never affect provider failures or retries.
          }
        }
        return response;
      },
    } as Options);
  };
}
