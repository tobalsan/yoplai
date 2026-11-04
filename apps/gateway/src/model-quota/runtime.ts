import path from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  parseClaudeQuotaHeaders,
  type ContainerRunnerProtocolEvent,
} from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { logError, logInfo, logWarn } from "../logging.js";
import { resolveOAuthToken } from "../sdk/container/oauth-tokens.js";
import { resolveLoginIdentity } from "./identity.js";
import { createQuotaPollers } from "./pollers.js";
import { QuotaStore } from "./store.js";

export function readQuotaCredential(provider: string) {
  return readStoredCredential(provider, path.join(CONFIG_DIR, "auth.json"));
}

export const modelQuotaStore = new QuotaStore({
  now: () => Date.now() / 1000,
  isLoginActive(identity) {
    try {
      return (
        resolveLoginIdentity(
          identity.provider,
          readQuotaCredential(identity.provider)
        )?.accountRef === identity.accountRef
      );
    } catch {
      return false;
    }
  },
});

let pollers: ReturnType<typeof createQuotaPollers> | undefined;

export function startModelQuotaPollers(enabled: boolean): void {
  if (!enabled || pollers) return;
  pollers = createQuotaPollers({
    store: modelQuotaStore,
    readCredential: readQuotaCredential,
    resolveToken: resolveOAuthToken,
    fetch: globalThis.fetch,
    now: () => Date.now() / 1000,
    log: (event) =>
      event.outcome === "stale"
        ? logError("[model-quota] stale", "quota stale", event)
        : event.outcome === "error"
          ? logWarn("[model-quota]", event)
          : logInfo("[model-quota]", event),
  });
  void pollers.start(true);
}

export function stopModelQuotaPollers(): void {
  pollers?.stop();
  pollers = undefined;
}

export function captureClaudeQuota(
  provider: string | undefined,
  headers: Record<string, string>,
  authMode?: string
): void {
  try {
    if (provider !== "anthropic" || authMode === "api_key") return;
    const identity = resolveLoginIdentity(
      provider,
      readQuotaCredential(provider)
    );
    if (!identity) return;
    const parsed = parseClaudeQuotaHeaders(headers);
    if (!parsed.ok)
      modelQuotaStore.markError(identity, "headers", "invalid_payload");
    else if (parsed.windows.length) {
      modelQuotaStore.record(
        identity,
        "headers",
        parsed.windows,
        Date.now() / 1000
      );
    }
  } catch {
    // Quota capture is best effort and must never interrupt provider responses.
  }
}

export function recordContainerQuota(
  frame: Extract<ContainerRunnerProtocolEvent, { type: "quota" }>,
  authorizedProviders: readonly string[]
): void {
  try {
    if (!authorizedProviders.includes(frame.provider)) return;
    const identity = resolveLoginIdentity(
      frame.provider,
      readQuotaCredential(frame.provider)
    );
    if (identity)
      modelQuotaStore.record(
        identity,
        "headers",
        frame.windows,
        frame.observedAt
      );
  } catch {
    // Protocol side-channel failures must not reach chat history or streaming.
  }
}
