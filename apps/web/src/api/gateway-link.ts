import type { GatewayLinkConsentView, GatewayLinkSummary } from "@yoplai/shared";
import { API_BASE, apiFetch } from "./core";

const LINK_BASE = `${API_BASE}/auth/gateway-link`;

/** An error answer of the remote link routes. `code` is the `error` field of the answer. */
export class GatewayLinkApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(describeGatewayLinkError(code));
    this.name = "GatewayLinkApiError";
  }
}

const MESSAGES: Record<string, string> = {
  not_found: "This link request does not exist or has expired. Start again from your gateway.",
  request_not_pending: "This link request was already answered or has expired. Start again from your gateway.",
  invalid_nonce: "Your sign-in changed. Reload this page and try again.",
  replace_not_allowed: "This request replaces a link that belongs to another account. Sign in as that account, or start again.",
  link_busy: "This link is being replaced right now. Wait a moment and try again.",
  rate_limited: "Too many attempts. Wait one minute and try again.",
  origin_not_allowed: "This address cannot approve link requests. Open the gateway at its configured address.",
  forbidden: "Your account cannot approve link requests.",
  impersonation_not_allowed: "Stop the impersonation before you answer a link request.",
  login_required: "Sign in to answer this link request.",
  unavailable: "This gateway cannot link devices right now.",
};

export function describeGatewayLinkError(code: string): string {
  return MESSAGES[code] ?? "The request failed. Try again.";
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${LINK_BASE}${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new GatewayLinkApiError(typeof body.error === "string" ? body.error : "request_failed", response.status);
  }
  return (await response.json()) as T;
}

const post = (body: unknown) =>
  ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) satisfies RequestInit;

export function fetchGatewayLinkConsent(requestId: string): Promise<GatewayLinkConsentView> {
  return call(`/requests/${encodeURIComponent(requestId)}`);
}

/** Approves a request. The answer is the callback address of the local gateway, which the page opens. */
export async function approveGatewayLink(requestId: string, nonce: string): Promise<string> {
  return (await call<{ redirectUrl: string }>("/approve", post({ requestId, nonce }))).redirectUrl;
}

/** Refuses a request. The answer is the callback address that tells the local gateway about the refusal. */
export async function denyGatewayLink(requestId: string, nonce: string): Promise<string> {
  return (await call<{ redirectUrl: string }>("/deny", post({ requestId, nonce }))).redirectUrl;
}

export async function fetchGatewayLinks(): Promise<GatewayLinkSummary[]> {
  return (await call<{ links: GatewayLinkSummary[] }>("/links")).links;
}

export function revokeGatewayLink(linkId: string): Promise<GatewayLinkSummary> {
  return call("/revoke", post({ linkId }));
}

/** Opens the callback address of the local gateway. It is one place so a test can stand in for it. */
export function openLocalCallback(redirectUrl: string): void {
  window.location.assign(redirectUrl);
}
