import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import os from "node:os";
import {
  CapabilitiesResponseSchema,
  GATEWAY_LINK_CALLBACK_PATH,
  GatewayLinkTokenResponseSchema,
} from "@yoplai/shared";
import type { DeviceLinkState } from "./device-link-client.js";
import type { RemoteGateway, RemoteGatewayStore } from "./store.js";

/**
 * The local side of the browser link. The local gateway starts an attempt, the user approves it on the remote
 * gateway in a browser, and the browser returns a one-use code to this gateway. This gateway exchanges the code
 * and the PKCE verifier for a key and stores the key. The verifier and the key never reach the browser.
 * See docs/relay-configuration.md, "Browser link".
 */

const GATEWAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_TIMEOUT_MS = 10_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
/** The remote lets a request live five minutes. The local attempt never outlives that by more than a minute. */
const ATTEMPT_MAX_MS = 6 * 60_000;
const FINISHED_RETENTION_MS = 10 * 60_000;
export const MAX_PENDING_ATTEMPTS = 20;
const MAX_FINISHED_ATTEMPTS = 50;
const MAX_UNCERTAIN_ORIGINS = 20;

export const LINK_OWNER_PAGE_PATH = "/account/gateway-links";

export type AttemptStatus = "pending" | "exchanging" | "linked" | "denied" | "cancelled" | "expired" | "failed" | "uncertain";

export type LinkFailure = { ok: false; status: number; error: string; message: string };
export type LinkResult<T> = { ok: true; value: T } | LinkFailure;

const fail = (status: number, error: string, message: string): LinkFailure => ({ ok: false, status, error, message });
const ok = <T>(value: T): LinkResult<T> => ({ ok: true, value });

export type CheckedRemoteOrigin = { origin: string; defaultName: string };

/**
 * Accepts an origin with an optional trailing slash and nothing else. HTTPS is required. HTTP works only for the
 * literal hosts `127.0.0.1` and `[::1]`, which the tests use. A host name that resolves to loopback gets no
 * exception, and neither does `localhost`. Numeric spellings of an address (integer, hexadecimal, shortened) are
 * refused before any URL parser can turn them into another address.
 */
export function checkRemoteOrigin(input: string): LinkResult<CheckedRemoteOrigin> {
  const refuse = (message: string) => fail(400, "invalid_remote", message);
  const match = /^(https?):\/\/([^/?#@\\\s]+)\/?$/i.exec(input.trim());
  if (!match) return refuse("Use the address of the remote gateway only, such as https://gateway.example.com. Paths, queries, and credentials are not allowed.");
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const hostMatch = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!hostMatch) return refuse("The address of the remote gateway is not valid.");
  const host = hostMatch[1].toLowerCase();
  const port = hostMatch[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535 || (port.length > 1 && port.startsWith("0")))) {
    return refuse("The port of the remote gateway is not valid.");
  }
  const looksNumeric = /^[0-9.]+$/.test(host) || /^0x/i.test(host);
  if (looksNumeric && !isIPv4(host)) return refuse("Use a host name or a plain dotted address. Other number forms are not allowed.");
  if (host.includes("..") || host.startsWith(".") || host.endsWith(".") || host.startsWith("-")) return refuse("The host name of the remote gateway is not valid.");
  if (scheme === "http" && host !== "127.0.0.1" && host !== "[::1]") {
    return refuse("The remote gateway must use https://. Plain http:// works only for 127.0.0.1 and [::1] in tests.");
  }
  let url: URL;
  try {
    url = new URL(`${scheme}://${authority.toLowerCase()}`);
  } catch {
    return refuse("The address of the remote gateway is not valid.");
  }
  return ok({ origin: url.origin, defaultName: url.hostname.replace(/^\[|\]$/g, "").replace(/:/g, "-") });
}

export function isValidGatewayName(name: string): boolean {
  return name.length <= 64 && GATEWAY_NAME_RE.test(name);
}

type Attempt = {
  id: string;
  controlToken: string;
  state: string;
  /** Erased when the attempt ends. */
  verifier: string | undefined;
  origin: string;
  name: string;
  callbackUri: string;
  deviceLabel: string;
  /** The generation of the stored link when the attempt began, or null when the name was free. */
  expectedGeneration: string | null;
  expiresAt: number;
  finishedAt?: number;
  status: AttemptStatus;
  message?: string;
  linkId?: string;
};

export type StartedAttempt = {
  attemptId: string;
  controlToken: string;
  expiresAt: string;
  consentUrl: string;
  /** Set when an earlier attempt to this remote ended with an unconfirmed key. */
  recoveryNote?: string;
};

export type StartOutcome = { kind: "pending"; attempt: StartedAttempt } | { kind: "linked"; name: string };

export type AttemptView = {
  status: AttemptStatus;
  name: string;
  remote: string;
  expiresAt: string;
  message?: string;
  /** The page where the owner revokes a key. Set when the outcome needs a revoke. */
  ownerPageUrl?: string;
  linkId?: string;
};

export type KeyState = "active" | "expired" | "rejected" | "none" | "unknown";
export type ConnectionState = "connected" | "connecting" | "replaced" | "unauthorized" | "offline";

export type LinkRow = {
  name: string;
  remote: string;
  kind: "browser" | "token" | "open";
  account: string | null;
  deviceLabel: string | null;
  linkId: string | null;
  expiresAt: string | null;
  keyState: KeyState;
  connection: ConnectionState;
};

export type LinkDeps = {
  store: () => RemoteGatewayStore;
  fetch: typeof fetch;
  now: () => number;
  /** The port of the callback listener, or undefined while the browser link cannot receive a callback. */
  callbackPort: () => number | undefined;
  deviceLabel: () => string;
  connections: () => DeviceLinkState[];
};

function sanitizeLabel(raw: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, 64).join("") || "This computer";
}

const randomValue = () => randomBytes(32).toString("base64url");

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readLimitedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type RemoteAnswer = { kind: "answer"; status: number; body: unknown } | { kind: "lost" };

const ERROR_TEXT: Record<string, string> = {
  not_found: "The remote gateway does not know this request. Start a new link.",
  request_not_pending: "The remote gateway already used or closed this request. Start a new link.",
  invalid_grant: "The remote gateway refused the code. Start a new link.",
  invalid_code: "The remote gateway refused the code. Start a new link.",
  rate_limited: "The remote gateway limits link requests. Wait one minute and start again.",
  link_busy: "The remote gateway is changing this link right now. Wait a moment and start again.",
};

export class RelayLinkService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly byState = new Map<string, Attempt>();
  private readonly uncertainOrigins = new Map<string, string>();

  constructor(private readonly deps: LinkDeps) {}

  // ---- Remote calls: HTTPS only (checked at start), no redirect, a bounded answer, no cookie, no Origin. ----

  private async remote(
    origin: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; bearer?: string; timeoutMs?: number }
  ): Promise<RemoteAnswer> {
    try {
      const response = await this.deps.fetch(`${origin}${path}`, {
        method: init.method,
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const text = await readLimitedText(response);
      if (text === null) return { kind: "lost" };
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      return { kind: "answer", status: response.status, body };
    } catch {
      return { kind: "lost" };
    }
  }

  private errorCode(body: unknown): string {
    const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "request_failed";
  }

  /** Revokes a key with the key itself. `already` means the remote no longer accepts it. */
  private async revokeKey(origin: string, key: string, linkId?: string): Promise<"revoked" | "already" | "failed"> {
    const answer = await this.remote(origin, "/api/auth/gateway-link/revoke", {
      method: "POST",
      bearer: key,
      body: linkId ? { linkId } : {},
    });
    if (answer.kind === "lost") return "failed";
    if (answer.status === 200) return "revoked";
    return answer.status === 401 ? "already" : "failed";
  }

  // ---- Start ----

  async start(input: { remote: string; name?: string }): Promise<LinkResult<StartOutcome>> {
    const port = this.deps.callbackPort();
    if (port === undefined) {
      return fail(409, "link_callback_unavailable", "The browser link needs this gateway to listen on 127.0.0.1. Saved links keep working.");
    }
    const checked = checkRemoteOrigin(input.remote);
    if (!checked.ok) return checked;
    const { origin } = checked.value;
    const name = input.name ?? checked.value.defaultName;
    if (!isValidGatewayName(name)) {
      return fail(400, "invalid_name", `Invalid gateway name "${name}". Use letters, digits, ".", "_" or "-".`);
    }
    this.purge();
    if ([...this.attempts.values()].filter((attempt) => attempt.status === "pending" || attempt.status === "exchanging").length >= MAX_PENDING_ATTEMPTS) {
      return fail(429, "too_many_attempts", "Too many link attempts are open. Cancel one or wait.");
    }
    const existing = this.deps.store().list().find((gateway) => gateway.name === name);
    let replaceLinkId: string | undefined;
    if (existing) {
      if (!existing.managed || existing.url !== origin) {
        return fail(409, "name_in_use", `A gateway named "${name}" is already linked. Disconnect it first, or choose another name.`);
      }
      replaceLinkId = existing.managed.linkId;
    }
    const expectedGeneration = existing ? (existing.generation ?? null) : null;
    if (existing && expectedGeneration === null) {
      return fail(409, "name_in_use", `The link "${name}" has no generation. Disconnect it first.`);
    }

    const capabilities = await this.remote(origin, "/api/capabilities", { method: "GET" });
    if (capabilities.kind === "lost" || capabilities.status !== 200) {
      return fail(502, "remote_unreachable", `Cannot reach ${origin}. Check the address and that the gateway runs.`);
    }
    const parsed = CapabilitiesResponseSchema.safeParse(capabilities.body);
    if (!parsed.success) return fail(502, "remote_invalid", `${origin} did not answer like a Yoplai gateway.`);

    if (parsed.data.multiUser === false) return this.linkOpenGateway(origin, name, expectedGeneration);
    if (!parsed.data.gatewayLink) {
      return fail(409, "remote_not_supported", "This remote gateway has no browser sign-in. Link it with a user token: yoplai connect <url> --token <token>.");
    }

    const verifier = randomValue();
    const state = randomValue();
    const deviceLabel = sanitizeLabel(this.deps.deviceLabel());
    const callbackUri = `http://127.0.0.1:${port}${GATEWAY_LINK_CALLBACK_PATH}`;
    const created = await this.remote(origin, "/api/auth/gateway-link/requests", {
      method: "POST",
      body: {
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        state,
        callbackUri,
        deviceLabel,
        ...(replaceLinkId ? { replaceLinkId } : {}),
      },
    });
    if (created.kind === "lost") return fail(502, "remote_unreachable", `Cannot reach ${origin}. Check the address and that the gateway runs.`);
    const createdBody = created.body as { requestId?: unknown; expiresAt?: unknown } | null;
    if (created.status !== 201 || typeof createdBody?.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(createdBody.requestId)) {
      const code = this.errorCode(created.body);
      return fail(created.status === 429 ? 429 : 502, "remote_refused", ERROR_TEXT[code] ?? "The remote gateway did not accept the link request.");
    }
    const now = this.deps.now();
    const remoteExpiry = typeof createdBody.expiresAt === "string" ? Date.parse(createdBody.expiresAt) : NaN;
    const expiresAt = Number.isFinite(remoteExpiry) ? Math.min(remoteExpiry, now + ATTEMPT_MAX_MS) : now + ATTEMPT_MAX_MS;
    const attempt: Attempt = {
      id: randomValue(),
      controlToken: randomValue(),
      state,
      verifier,
      origin,
      name,
      callbackUri,
      deviceLabel,
      expectedGeneration,
      expiresAt,
      status: "pending",
    };
    this.attempts.set(attempt.id, attempt);
    this.byState.set(state, attempt);
    const uncertain = this.uncertainOrigins.has(origin);
    return ok({
      kind: "pending",
      attempt: {
        attemptId: attempt.id,
        controlToken: attempt.controlToken,
        expiresAt: new Date(expiresAt).toISOString(),
        consentUrl: `${origin}/gateway-link?request=${encodeURIComponent(createdBody.requestId)}`,
        ...(uncertain ? { recoveryNote: this.uncertainText(origin) } : {}),
      },
    });
  }

  /** The unauthenticated path for a remote that reports `multiUser === false`. It stores no key and opens no consent page. */
  private async linkOpenGateway(origin: string, name: string, expectedGeneration: string | null): Promise<LinkResult<StartOutcome>> {
    const agents = await this.remote(origin, "/api/agents", { method: "GET" });
    if (agents.kind === "lost" || agents.status !== 200 || !Array.isArray(agents.body)) {
      return fail(502, "remote_invalid", `${origin} did not answer like an open Yoplai gateway.`);
    }
    const gateway: RemoteGateway = { name, url: origin };
    if (!this.deps.store().saveIfGeneration(gateway, expectedGeneration)) {
      return fail(409, "link_changed", `The link "${name}" changed while it was checked. Try again.`);
    }
    return ok({ kind: "linked", name });
  }

  private uncertainText(origin: string): string {
    return `An earlier link attempt to this gateway ended with a key that this computer never received. Revoke that key at ${origin}${LINK_OWNER_PAGE_PATH} before you link again.`;
  }

  // ---- Attempt state ----

  private purge(): void {
    const now = this.deps.now();
    for (const attempt of this.attempts.values()) {
      if (attempt.status === "pending" && attempt.expiresAt <= now) this.finish(attempt, "expired", "The link request expired. Start again.");
    }
    const finished = [...this.attempts.values()].filter((attempt) => attempt.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let excess = finished.length - MAX_FINISHED_ATTEMPTS;
    for (const attempt of finished) {
      if (now - attempt.finishedAt! > FINISHED_RETENTION_MS || excess-- > 0) this.attempts.delete(attempt.id);
    }
  }

  private finish(attempt: Attempt, status: AttemptStatus, message?: string): void {
    attempt.status = status;
    attempt.message = message;
    attempt.verifier = undefined;
    attempt.finishedAt = this.deps.now();
    this.byState.delete(attempt.state);
  }

  private find(attemptId: string, controlToken: string): Attempt | undefined {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || !constantTimeEqual(attempt.controlToken, controlToken)) return undefined;
    if (attempt.status === "pending" && attempt.expiresAt <= this.deps.now()) {
      this.finish(attempt, "expired", "The link request expired. Start again.");
    }
    return attempt;
  }

  private view(attempt: Attempt): AttemptView {
    const needsOwnerPage = attempt.status === "uncertain";
    return {
      status: attempt.status,
      name: attempt.name,
      remote: attempt.origin,
      expiresAt: new Date(attempt.expiresAt).toISOString(),
      ...(attempt.message ? { message: attempt.message } : {}),
      ...(needsOwnerPage ? { ownerPageUrl: `${attempt.origin}${LINK_OWNER_PAGE_PATH}` } : {}),
      ...(attempt.linkId ? { linkId: attempt.linkId } : {}),
    };
  }

  status(attemptId: string, controlToken: string): LinkResult<AttemptView> {
    const attempt = this.find(attemptId, controlToken);
    return attempt ? ok(this.view(attempt)) : fail(404, "unknown_attempt", "This link attempt is not known.");
  }

  cancel(attemptId: string, controlToken: string): LinkResult<AttemptView> {
    const attempt = this.find(attemptId, controlToken);
    if (!attempt) return fail(404, "unknown_attempt", "This link attempt is not known.");
    if (attempt.status === "exchanging") return fail(409, "attempt_exchanging", "The link is being finished. Wait for the result.");
    if (attempt.status === "pending") this.finish(attempt, "cancelled", "The link request was cancelled.");
    return ok(this.view(attempt));
  }

  // ---- Completion ----

  /** The callback page sends the outcome. The state is the only authority here, and it works once. */
  async complete(input: { state: string; code: string } | { state: string; error: "access_denied" }): Promise<LinkResult<{ status: AttemptStatus; message?: string }>> {
    const attempt = this.byState.get(input.state);
    if (!attempt || attempt.status !== "pending") return fail(404, "unknown_attempt", "This link attempt is not known or is already finished.");
    if (attempt.expiresAt <= this.deps.now()) {
      this.finish(attempt, "expired", "The link request expired. Start again.");
      return fail(410, "attempt_expired", "The link request expired. Start again.");
    }
    if ("error" in input) {
      this.finish(attempt, "denied", "The sign-in was refused on the remote gateway.");
      return ok({ status: attempt.status, message: attempt.message });
    }
    // The state moves out of `pending` before the first await, so a second callback cannot start another exchange.
    attempt.status = "exchanging";
    const verifier = attempt.verifier!;
    const answer = await this.remote(attempt.origin, "/api/auth/gateway-link/token", {
      method: "POST",
      body: { code: input.code, verifier, callbackUri: attempt.callbackUri },
      timeoutMs: EXCHANGE_TIMEOUT_MS,
    });
    if (answer.kind === "answer" && answer.status >= 400 && answer.status < 500) {
      const code = this.errorCode(answer.body);
      this.finish(attempt, "failed", ERROR_TEXT[code] ?? "The remote gateway did not give a key. Start a new link.");
      return ok({ status: attempt.status, message: attempt.message });
    }
    const parsed = answer.kind === "answer" && answer.status === 200 ? GatewayLinkTokenResponseSchema.safeParse(answer.body) : undefined;
    if (!parsed?.success || parsed.data.key.length === 0) {
      // The remote may have made a key that nobody holds. Nothing here can find it, so the owner revokes it.
      this.markUncertain(attempt);
      return ok({ status: attempt.status, message: attempt.message });
    }
    const { key, link } = parsed.data;
    const now = this.deps.now();
    const gateway: RemoteGateway = {
      name: attempt.name,
      url: attempt.origin,
      token: key,
      managed: { linkId: link.id, account: link.account, deviceLabel: link.deviceLabel, expiresAt: link.expiresAt, linkedAt: new Date(now).toISOString() },
    };
    let saved = false;
    let saveFailed = false;
    try {
      saved = this.deps.store().saveIfGeneration(gateway, attempt.expectedGeneration);
    } catch {
      saveFailed = true;
    }
    if (saved) {
      attempt.linkId = link.id;
      this.uncertainOrigins.delete(attempt.origin);
      this.finish(attempt, "linked");
      return ok({ status: attempt.status });
    }
    // The key exists on the remote but cannot be kept here. Revoke it, so no key is left that nobody holds.
    const revoked = await this.revokeKey(attempt.origin, key, link.id);
    if (revoked === "failed") {
      attempt.linkId = link.id;
      this.markUncertain(attempt);
    } else {
      this.finish(
        attempt,
        "failed",
        saveFailed ? "This computer could not save the key. Start a new link." : "The local link changed while you signed in. Start a new link."
      );
    }
    return ok({ status: attempt.status, message: attempt.message });
  }

  private markUncertain(attempt: Attempt): void {
    if (!this.uncertainOrigins.has(attempt.origin) && this.uncertainOrigins.size >= MAX_UNCERTAIN_ORIGINS) {
      const oldest = this.uncertainOrigins.keys().next().value;
      if (oldest !== undefined) this.uncertainOrigins.delete(oldest);
    }
    this.uncertainOrigins.set(attempt.origin, attempt.deviceLabel);
    this.finish(attempt, "uncertain", this.uncertainText(attempt.origin));
  }

  // ---- Saved links ----

  list(): LinkRow[] {
    const connections = new Map(this.deps.connections().map((state) => [state.name, state]));
    const now = this.deps.now();
    return this.deps
      .store()
      .list()
      .map((gateway): LinkRow => {
        const connection = connections.get(gateway.name);
        const connectionState: ConnectionState = connection?.status ?? (connection?.connected ? "connected" : "offline");
        const managed = gateway.managed;
        let keyState: KeyState;
        if (managed) {
          const expiry = managed.expiresAt ? Date.parse(managed.expiresAt) : NaN;
          keyState = Number.isFinite(expiry) && expiry <= now ? "expired" : connectionState === "unauthorized" ? "rejected" : "active";
        } else if (gateway.token) {
          keyState = connectionState === "unauthorized" ? "rejected" : "unknown";
        } else {
          keyState = "none";
        }
        return {
          name: gateway.name,
          remote: gateway.url,
          kind: managed ? "browser" : gateway.token ? "token" : "open",
          account: managed ? (managed.account.email ?? managed.account.name) : null,
          deviceLabel: managed?.deviceLabel ?? null,
          linkId: managed?.linkId ?? null,
          expiresAt: managed?.expiresAt ?? null,
          keyState,
          connection: connectionState,
        };
      });
  }

  /**
   * Removes a link. A browser link revokes its key on the remote first, and it stays when the remote does not
   * answer. `localOnly` removes the entry and leaves the remote key valid until it is revoked or it expires.
   */
  async disconnect(name: string, options: { localOnly?: boolean } = {}): Promise<LinkResult<{ name: string; revoked: "remote" | "already" | "not_needed" | "skipped" }>> {
    const store = this.deps.store();
    const gateway = store.list().find((item) => item.name === name);
    if (!gateway) return fail(404, "unknown_gateway", `No linked gateway named "${name}".`);
    let revoked: "remote" | "already" | "not_needed" | "skipped" = "not_needed";
    if (gateway.managed && gateway.token) {
      if (options.localOnly) {
        revoked = "skipped";
      } else {
        const outcome = await this.revokeKey(gateway.url, gateway.token, gateway.managed.linkId);
        if (outcome === "failed") {
          return fail(502, "revoke_failed", "The remote gateway did not confirm the revoke. The link stays. Try again, or remove it from this computer only.");
        }
        revoked = outcome === "revoked" ? "remote" : "already";
      }
    }
    if (!store.removeIfGeneration(name, gateway.generation)) {
      return fail(409, "link_changed", `The link "${name}" changed while it was removed. Check the list and try again.`);
    }
    return ok({ name, revoked });
  }
}

export function defaultDeviceLabel(): string {
  return os.hostname();
}
