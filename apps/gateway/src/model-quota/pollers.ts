import type { QuotaSource } from "@yoplai/shared";
import type { OAuthTokenLookup } from "../sdk/container/oauth-tokens.js";
import {
  CLAUDE_HEADER_IDLE_SECONDS,
  QUOTA_MAX_BACKOFF_SECONDS,
  QUOTA_POLL_INTERVAL_SECONDS,
  QUOTA_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import {
  extractCodexAccountId,
  resolveLoginIdentity,
  type QuotaCredential,
} from "./identity.js";
import { parseClaudeUsage, parseWhamUsage } from "./parsers.js";
import type { QuotaStore } from "./store.js";

type Provider = "anthropic" | "openai-codex";
type QuotaLogEvent = {
  provider: Provider;
  source: QuotaSource;
  outcome: "success" | "error";
  errorKind?: string;
};
type PollerDeps = {
  store: QuotaStore;
  readCredential: (provider: string) => QuotaCredential | undefined;
  resolveToken: (
    provider: string,
    allowedProviders: readonly string[]
  ) => Promise<OAuthTokenLookup>;
  fetch: typeof fetch;
  now: () => number;
  log: (event: QuotaLogEvent) => void;
};

export function createQuotaPollers(deps: PollerDeps) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const notBefore = new Map<Provider, number>();
  const backoff = new Map<Provider, number>();
  const controllers = new Map<Provider, AbortController>();
  async function poll(provider: Provider): Promise<void> {
    if (
      controllers.has(provider) ||
      deps.now() < (notBefore.get(provider) ?? 0)
    )
      return;
    const source: QuotaSource =
      provider === "anthropic" ? "usage-endpoint" : "wham-usage";
    let identity;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let errorKind = "network";
    const controller = new AbortController();
    controllers.set(provider, controller);
    try {
      const credential = deps.readCredential(provider);
      if (credential?.type !== "oauth") return;
      identity = resolveLoginIdentity(provider, credential);
      if (provider === "anthropic" && identity) {
        const headerAt = deps.store.latestHeaderAt(identity);
        if (
          headerAt !== undefined &&
          deps.now() - headerAt <= CLAUDE_HEADER_IDLE_SECONDS
        )
          return;
      }
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true }
        );
      });
      timeout = setTimeout(() => controller.abort(), QUOTA_REQUEST_TIMEOUT_MS);
      const work = async () => {
        errorKind = "token_error";
        const token = await deps.resolveToken(provider, [provider]);
        if (controller.signal.aborted) return undefined;
        if (token.status !== "ok") throw new Error("token_error");
        identity = resolveLoginIdentity(provider, {
          type: "oauth",
          access: token.accessToken,
        });
        if (!identity) {
          deps.log({
            provider,
            source,
            outcome: "error",
            errorKind: "no_account",
          });
          return undefined;
        }
        const account = extractCodexAccountId(token.accessToken);
        if (provider === "openai-codex" && !account) return undefined;
        errorKind = "network";
        const observedAt = deps.now();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
        };
        if (provider === "anthropic") {
          headers["anthropic-beta"] = "oauth-2025-04-20";
          headers["User-Agent"] = "claude-cli/2.1.280 (external, cli)";
        } else headers["ChatGPT-Account-Id"] = account!;
        const response = await deps.fetch(
          provider === "anthropic"
            ? "https://api.anthropic.com/api/oauth/usage"
            : "https://chatgpt.com/backend-api/wham/usage",
          {
            headers,
            signal: controller.signal,
          }
        );
        if (controller.signal.aborted) return undefined;
        if (response.status === 429) {
          errorKind = "rate_limited";
          const retry = response.headers.get("Retry-After");
          const seconds =
            retry?.trim() && Number.isFinite(Number(retry))
              ? Number(retry)
              : retry
                ? Date.parse(retry) / 1000 - deps.now()
                : Number.NaN;
          const delay = backoff.get(provider) ?? QUOTA_POLL_INTERVAL_SECONDS;
          backoff.set(provider, Math.min(delay * 2, QUOTA_MAX_BACKOFF_SECONDS));
          notBefore.set(
            provider,
            deps.now() +
              (Number.isFinite(seconds) && seconds >= 0 ? seconds : delay)
          );
          throw new Error("rate_limited");
        }
        if (!response.ok) {
          errorKind = "http_error";
          throw new Error("http_error");
        }
        errorKind = "invalid_payload";
        const payload: unknown = await response.json();
        return {
          parsed:
            provider === "anthropic"
              ? parseClaudeUsage(payload)
              : parseWhamUsage(payload),
          observedAt,
        };
      };
      const result = await Promise.race([work(), aborted]);
      if (!timer || !identity || !result) return;
      if (!result.parsed.ok) throw new Error("invalid_payload");
      if (result.parsed.ok) {
        backoff.delete(provider);
        notBefore.delete(provider);
        deps.store.record(
          identity,
          source,
          result.parsed.windows,
          result.observedAt,
          result.parsed.planLabel
        );
        deps.log({ provider, source, outcome: "success" });
      }
    } catch {
      if (!timer) return;
      if (controller.signal.aborted) errorKind = "timeout";
      if (identity) deps.store.markError(identity, source, errorKind);
      deps.log({ provider, source, outcome: "error", errorKind });
    } finally {
      if (timeout) clearTimeout(timeout);
      controllers.delete(provider);
    }
  }
  return {
    async start(enabled: boolean): Promise<void> {
      if (!enabled || timer) return;
      timer = setInterval(() => {
        void Promise.all([poll("anthropic"), poll("openai-codex")]);
      }, QUOTA_POLL_INTERVAL_SECONDS * 1000);
      timer.unref?.();
      await Promise.all([poll("anthropic"), poll("openai-codex")]);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of controllers.values()) controller.abort();
    },
  };
}
