import { apiFetch } from "./core";

/** The browser link routes of the local gateway. No answer holds a key, a code, or a state. */
const BASE = "/api/relay/link";
const CONTROL_HEADER = "x-link-control";

export type LinkAttemptStatus = "pending" | "exchanging" | "linked" | "denied" | "cancelled" | "expired" | "failed" | "uncertain";
export type LinkKeyState = "active" | "expired" | "rejected" | "none" | "unknown";
export type LinkConnectionState = "connected" | "connecting" | "replaced" | "unauthorized" | "offline";

export type LinkRow = {
  name: string;
  remote: string;
  kind: "browser" | "token" | "open";
  account: string | null;
  deviceLabel: string | null;
  linkId: string | null;
  expiresAt: string | null;
  keyState: LinkKeyState;
  connection: LinkConnectionState;
};

export type StartedLink =
  | { kind: "linked"; name: string }
  | { kind: "pending"; attemptId: string; controlToken: string; expiresAt: string; consentUrl: string; recoveryNote?: string };

export type LinkAttemptView = {
  status: LinkAttemptStatus;
  name: string;
  remote: string;
  message?: string;
  ownerPageUrl?: string;
};

export class RelayLinkApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RelayLinkApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${BASE}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  if (!response.ok) {
    throw new RelayLinkApiError(
      typeof body.error === "string" ? body.error : "request_failed",
      response.status,
      typeof body.message === "string" ? body.message : "The request failed. Try again."
    );
  }
  return body as T;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) satisfies RequestInit;

export async function startLink(remote: string, name?: string): Promise<StartedLink> {
  const answer = await call<{ status?: string; name?: string; attemptId?: string; controlToken?: string; expiresAt?: string; consentUrl?: string; recoveryNote?: string }>(
    "/start",
    post({ remote, ...(name ? { name } : {}) })
  );
  if (answer.status === "linked" && answer.name) return { kind: "linked", name: answer.name };
  if (!answer.attemptId || !answer.controlToken || !answer.consentUrl || !answer.expiresAt) {
    throw new RelayLinkApiError("invalid_answer", 502, "The gateway gave an unexpected answer.");
  }
  return { kind: "pending", attemptId: answer.attemptId, controlToken: answer.controlToken, expiresAt: answer.expiresAt, consentUrl: answer.consentUrl, recoveryNote: answer.recoveryNote };
}

export const fetchLinkStatus = (attemptId: string, controlToken: string): Promise<LinkAttemptView> =>
  call(`/status/${encodeURIComponent(attemptId)}`, { headers: { [CONTROL_HEADER]: controlToken } });

export const cancelLink = (attemptId: string, controlToken: string): Promise<LinkAttemptView> =>
  call("/cancel", post({ attemptId }, { [CONTROL_HEADER]: controlToken }));

const METADATA_DEADLINE_MS = 10_000;

/**
 * Reads the saved links from the gateway. It uses POST, so the gateway applies its normal write policy.
 * A read that does not answer within the deadline is aborted, so the caller sees a failure and can read again.
 */
export async function fetchLinkRows(): Promise<LinkRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_DEADLINE_MS);
  try {
    const body = await call<{ gateways: LinkRow[] }>("/metadata", { ...post({}), signal: controller.signal });
    // `call` reads a failed body as empty, so an abort during the body must still fail the read.
    controller.signal.throwIfAborted();
    return body.gateways;
  } finally {
    clearTimeout(timer);
  }
}

export const disconnectLink = (name: string, localOnly = false): Promise<{ name: string; revoked: string }> =>
  call("/disconnect", post({ name, localOnly }));

/** Opens the consent page in a new tab. It is one place so a test can stand in for it. */
export function openConsentPage(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
