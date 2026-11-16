import type Database from "better-sqlite3";
import {
  GATEWAY_LINK_KEY_TTL_SECONDS,
  type ExtensionLogger,
  type GatewayLinkConsentView,
  type GatewayLinkRequestCreated,
  type GatewayLinkRequestInput,
  type GatewayLinkStatus,
  type GatewayLinkSummary,
  type GatewayLinkTokenInput,
  type GatewayLinkTokenResponse,
} from "@yoplai/shared";
import type { MultiUserAuth } from "./auth.js";
import {
  constantTimeEqual,
  consentNonce,
  isReservedPrefix,
  isValidCallbackUri,
  managedKeyName,
  newIssuance,
  newLinkId,
  randomBase64Url,
  s256Challenge,
  sanitizeDeviceLabel,
  sha256Hex,
} from "./gateway-link-codec.js";
import { getEligibleAccount } from "./users.js";

export const REQUEST_TTL_MS = 5 * 60_000;
export const CODE_TTL_MS = 60_000;
const RETAIN_REQUEST_MS = 60 * 60_000;
const MAX_LIST = 100;

export type GatewayLinkLimits = {
  /** Request starts for each source in one minute. */
  startsPerSource: number;
  /** Pending requests on the whole remote. */
  pendingRequests: number;
  /** Consent writes for each user in one minute. */
  consentWritesPerUser: number;
  /** Exchange attempts for each code in one minute. */
  exchangesPerCode: number;
  /** Exchange attempts for each source in one minute. */
  exchangesPerSource: number;
};

export const DEFAULT_GATEWAY_LINK_LIMITS: GatewayLinkLimits = {
  startsPerSource: 5,
  pendingRequests: 1000,
  consentWritesPerUser: 10,
  exchangesPerCode: 10,
  exchangesPerSource: 30,
};

/** The process-death points that a test can ask the service to simulate. The service skips its cleanup there. */
export type IssuanceBoundary = "claimed" | "key-created";

/** Thrown at a simulated process death. Nothing in the service catches it. */
export class GatewayLinkCrash extends Error {
  constructor(readonly boundary: IssuanceBoundary) {
    super(`simulated crash at ${boundary}`);
  }
}

export type GatewayLinkFailure = { ok: false; status: number; error: string };
export type GatewayLinkResult<T> = { ok: true; value: T } | GatewayLinkFailure;

const fail = (status: number, error: string): GatewayLinkFailure => ({ ok: false, status, error });
const ok = <T>(value: T): GatewayLinkResult<T> => ({ ok: true, value });

export type ManagedKeyCheck = "unmanaged" | "active" | "inactive";

export type GatewayLinkServiceOptions = {
  db: Database.Database;
  auth: Pick<MultiUserAuth["api"], "createApiKey">;
  /** The session secret. The consent nonce derives its key from it. */
  secret: string;
  /** Exact web origins that may send a consent write. */
  getAllowedOrigins: () => string[];
  logger?: Pick<ExtensionLogger, "info" | "warn" | "error">;
  now?: () => number;
  limits?: Partial<GatewayLinkLimits>;
  /** Test seam. Return true to simulate a process death at the boundary. */
  crashAfter?: (boundary: IssuanceBoundary) => boolean;
};

type LinkRow = {
  id: string;
  ownerId: string;
  deviceLabel: string;
  keyId: string | null;
  generation: number;
  state: "issuing" | "active" | "blocked" | "revoked";
  createdAt: number;
  updatedAt: number;
  activatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
};

type RequestRow = {
  id: string;
  challenge: string;
  state: string;
  callbackUri: string;
  deviceLabel: string;
  replaceLinkId: string | null;
  status: "pending" | "approved" | "denied" | "exchanging" | "exchanged" | "failed";
  ownerId: string | null;
  approvedGeneration: number | null;
  codeHash: string | null;
  codeExpiresAt: number | null;
  createdAt: number;
  expiresAt: number;
};

type IssuanceRow = {
  id: string;
  requestId: string;
  linkId: string;
  ownerId: string;
  expectedGeneration: number;
  candidatePrefix: string;
  candidateKeyId: string | null;
  state: "claimed" | "created" | "committed" | "failed";
};

/** A fixed-window counter map with a size bound. Expired windows leave the map when it grows. */
class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly windowMs = 60_000, private readonly maxKeys = 10_000) {}

  /** Counts one hit. Returns false when the key is over its limit for the current window. */
  hit(key: string, limit: number, now: number): boolean {
    if (this.windows.size >= this.maxKeys) {
      for (const [name, entry] of this.windows) if (now - entry.start >= this.windowMs) this.windows.delete(name);
      if (this.windows.size >= this.maxKeys) this.windows.clear();
    }
    const entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return limit >= 1;
    }
    entry.count++;
    return entry.count <= limit;
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class GatewayLinkService {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly limits: GatewayLinkLimits;
  private readonly starts = new RateLimiter();
  private readonly writes = new RateLimiter();
  private readonly exchangesByCode = new RateLimiter();
  private readonly exchangesBySource = new RateLimiter();
  private ready = false;

  constructor(private readonly options: GatewayLinkServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_GATEWAY_LINK_LIMITS, ...options.limits };
  }

  /** True after crash recovery finished. The remote advertises link support and accepts managed keys only then. */
  isReady(): boolean {
    return this.ready;
  }

  getAllowedOrigins(): string[] {
    return this.options.getAllowedOrigins();
  }

  /**
   * Resolves each unfinished issuance before the service becomes ready. A candidate key that a dead process created is
   * found by its stored prefix and owner, then disabled. The link needs new consent, and the old key stays disabled.
   */
  recover(): number {
    this.ready = false;
    const open = this.db.prepare("SELECT * FROM gateway_link_issuances WHERE state IN ('claimed', 'created')").all() as IssuanceRow[];
    for (const issuance of open) this.db.transaction(() => this.failIssuanceInTransaction(issuance))();
    this.ready = true;
    return open.length;
  }

  // ------------------------------------------------------------------ requests

  createRequest(input: GatewayLinkRequestInput, source: string): GatewayLinkResult<GatewayLinkRequestCreated> {
    const now = this.now();
    if (!isValidCallbackUri(input.callbackUri)) return fail(400, "invalid_callback");
    const label = sanitizeDeviceLabel(input.deviceLabel);
    if (!label) return fail(400, "invalid_device_label");
    if (!this.starts.hit(source, this.limits.startsPerSource, now)) return fail(429, "rate_limited");
    this.db.prepare("DELETE FROM gateway_link_requests WHERE expiresAt < ? AND status != 'exchanging'").run(now - RETAIN_REQUEST_MS);
    const pending = this.db
      .prepare("SELECT COUNT(*) AS count FROM gateway_link_requests WHERE status = 'pending' AND expiresAt > ?")
      .get(now) as { count: number };
    if (pending.count >= this.limits.pendingRequests) return fail(503, "too_many_requests");
    const id = randomBase64Url(32);
    const expiresAt = now + REQUEST_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO gateway_link_requests (id, challenge, state, callbackUri, deviceLabel, replaceLinkId, status, createdAt, expiresAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(id, input.challenge, input.state, input.callbackUri, label, input.replaceLinkId ?? null, now, expiresAt, now);
    return ok({ requestId: id, expiresAt: new Date(expiresAt).toISOString() });
  }

  describeRequest(requestId: string, session: { userId: string; sessionId: string }): GatewayLinkResult<GatewayLinkConsentView> {
    const account = getEligibleAccount(this.db, session.userId);
    if (!account) return fail(403, "forbidden");
    const request = this.getRequest(requestId);
    if (!request) return fail(404, "not_found");
    const now = this.now();
    const user = this.db.prepare("SELECT name FROM user WHERE id = ?").get(session.userId) as { name: string | null } | undefined;
    let replaces: GatewayLinkConsentView["replaces"] = null;
    let replaceConflict = false;
    if (request.replaceLinkId) {
      const link = this.getLink(request.replaceLinkId);
      if (link && link.ownerId === session.userId) replaces = { id: link.id, deviceLabel: link.deviceLabel };
      else replaceConflict = true;
    }
    const status: GatewayLinkConsentView["status"] =
      request.status === "denied"
        ? "denied"
        : request.status === "pending"
          ? request.expiresAt <= now
            ? "expired"
            : "pending"
          : request.status === "approved"
            ? "approved"
            : "used";
    return ok({
      requestId: request.id,
      status,
      deviceLabel: request.deviceLabel,
      expiresAt: new Date(request.expiresAt).toISOString(),
      account: { email: account.email, name: user?.name ?? null },
      replaces,
      replaceConflict,
      nonce: consentNonce(this.options.secret, request.id, session.sessionId, request.expiresAt),
    });
  }

  approve(requestId: string, nonce: string, session: { userId: string; sessionId: string }): GatewayLinkResult<{ redirectUrl: string }> {
    const guard = this.guardConsentWrite(requestId, nonce, session);
    if (!guard.ok) return guard;
    const request = guard.value;
    const now = this.now();
    const code = randomBase64Url(32);
    const outcome = this.db.transaction((): GatewayLinkFailure | null => {
      let approvedGeneration: number | null = null;
      if (request.replaceLinkId) {
        const link = this.getLink(request.replaceLinkId);
        if (!link || link.ownerId !== session.userId) return fail(409, "replace_not_allowed");
        if (link.state === "issuing") return fail(409, "link_busy");
        approvedGeneration = link.generation;
      }
      const result = this.db
        .prepare(
          `UPDATE gateway_link_requests
           SET status = 'approved', ownerId = ?, approvedGeneration = ?, codeHash = ?, codeExpiresAt = ?, updatedAt = ?
           WHERE id = ? AND status = 'pending' AND expiresAt > ?`
        )
        .run(session.userId, approvedGeneration, sha256Hex(code), now + CODE_TTL_MS, now, request.id, now);
      return result.changes === 1 ? null : fail(409, "request_not_pending");
    })();
    if (outcome) return outcome;
    this.options.logger?.info({ event: "gateway_link.approved", userId: session.userId, requestId: request.id });
    return ok({ redirectUrl: `${request.callbackUri}#code=${code}&state=${request.state}` });
  }

  deny(requestId: string, nonce: string, session: { userId: string; sessionId: string }): GatewayLinkResult<{ redirectUrl: string }> {
    const guard = this.guardConsentWrite(requestId, nonce, session);
    if (!guard.ok) return guard;
    const request = guard.value;
    const now = this.now();
    const result = this.db
      .prepare("UPDATE gateway_link_requests SET status = 'denied', ownerId = ?, updatedAt = ? WHERE id = ? AND status = 'pending' AND expiresAt > ?")
      .run(session.userId, now, request.id, now);
    if (result.changes !== 1) return fail(409, "request_not_pending");
    this.options.logger?.info({ event: "gateway_link.denied", userId: session.userId, requestId: request.id });
    return ok({ redirectUrl: `${request.callbackUri}#error=access_denied&state=${request.state}` });
  }

  private guardConsentWrite(requestId: string, nonce: string, session: { userId: string; sessionId: string }): GatewayLinkResult<RequestRow> {
    const now = this.now();
    if (!this.writes.hit(session.userId, this.limits.consentWritesPerUser, now)) return fail(429, "rate_limited");
    if (!getEligibleAccount(this.db, session.userId)) return fail(403, "forbidden");
    const request = this.getRequest(requestId);
    if (!request) return fail(404, "not_found");
    const expected = consentNonce(this.options.secret, request.id, session.sessionId, request.expiresAt);
    if (!constantTimeEqual(expected, nonce)) return fail(403, "invalid_nonce");
    if (request.status !== "pending" || request.expiresAt <= now) return fail(409, "request_not_pending");
    return ok(request);
  }

  // ------------------------------------------------------------------ exchange

  /**
   * Exchanges a one-use code for the key. The code is consumed before any check of the verifier, so a wrong guess
   * burns it. The key is created once, and the plaintext leaves this function once.
   */
  async exchange(input: GatewayLinkTokenInput, source: string): Promise<GatewayLinkResult<GatewayLinkTokenResponse>> {
    const now = this.now();
    if (!this.exchangesBySource.hit(source, this.limits.exchangesPerSource, now)) return fail(429, "rate_limited");
    const codeHash = sha256Hex(input.code);
    if (!this.exchangesByCode.hit(codeHash, this.limits.exchangesPerCode, now)) return fail(429, "rate_limited");

    const claimed = this.db.transaction((): GatewayLinkResult<{ issuance: IssuanceRow; link: LinkRow; request: RequestRow; prefix: string }> => {
      const request = this.db.prepare("SELECT * FROM gateway_link_requests WHERE codeHash = ?").get(codeHash) as RequestRow | undefined;
      if (!request || request.status !== "approved") return fail(400, "invalid_grant");
      // Consume the code first. Every later failure leaves the request used.
      const consumed = this.db
        .prepare("UPDATE gateway_link_requests SET status = 'exchanging', updatedAt = ? WHERE id = ? AND status = 'approved'")
        .run(now, request.id);
      if (consumed.changes !== 1) return fail(400, "invalid_grant");
      const failRequest = (error: GatewayLinkFailure): GatewayLinkFailure => {
        this.db.prepare("UPDATE gateway_link_requests SET status = 'failed', updatedAt = ? WHERE id = ?").run(now, request.id);
        return error;
      };
      if (request.codeExpiresAt === null || request.codeExpiresAt <= now) return failRequest(fail(400, "invalid_grant"));
      if (!constantTimeEqual(request.callbackUri, input.callbackUri)) return failRequest(fail(400, "invalid_grant"));
      if (!constantTimeEqual(request.challenge, s256Challenge(input.verifier))) return failRequest(fail(400, "invalid_grant"));
      const ownerId = request.ownerId;
      if (!ownerId || !getEligibleAccount(this.db, ownerId)) return failRequest(fail(403, "forbidden"));

      let link: LinkRow;
      if (request.replaceLinkId) {
        const existing = this.getLink(request.replaceLinkId);
        if (!existing || existing.ownerId !== ownerId) return failRequest(fail(409, "replace_not_allowed"));
        if (existing.state === "issuing" || existing.generation !== request.approvedGeneration) return failRequest(fail(409, "link_conflict"));
        const claim = this.db
          .prepare("UPDATE gateway_links SET state = 'issuing', generation = generation + 1, keyId = NULL, updatedAt = ? WHERE id = ? AND generation = ? AND state != 'issuing'")
          .run(now, existing.id, existing.generation);
        if (claim.changes !== 1) return failRequest(fail(409, "link_conflict"));
        // The old key stops working before a candidate exists.
        if (existing.keyId) this.db.prepare("UPDATE apikey SET enabled = 0 WHERE id = ?").run(existing.keyId);
        link = { ...existing, state: "issuing", generation: existing.generation + 1, keyId: null };
      } else {
        link = {
          id: newLinkId(),
          ownerId,
          deviceLabel: request.deviceLabel,
          keyId: null,
          generation: 1,
          state: "issuing",
          createdAt: now,
          updatedAt: now,
          activatedAt: null,
          expiresAt: null,
          revokedAt: null,
        };
        this.db
          .prepare("INSERT INTO gateway_links (id, ownerId, deviceLabel, keyId, generation, state, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, 'issuing', ?, ?)")
          .run(link.id, link.ownerId, link.deviceLabel, link.generation, now, now);
      }
      const candidate = newIssuance();
      const issuance: IssuanceRow = {
        id: candidate.id,
        requestId: request.id,
        linkId: link.id,
        ownerId,
        expectedGeneration: link.generation,
        candidatePrefix: candidate.prefix,
        candidateKeyId: null,
        state: "claimed",
      };
      this.db
        .prepare(
          `INSERT INTO gateway_link_issuances (id, requestId, linkId, ownerId, expectedGeneration, candidatePrefix, state, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`
        )
        .run(issuance.id, issuance.requestId, issuance.linkId, issuance.ownerId, issuance.expectedGeneration, issuance.candidatePrefix, now, now);
      return ok({ issuance, link, request, prefix: candidate.prefix });
    })();
    if (!claimed.ok) return claimed;
    const { issuance, link, request } = claimed.value;
    if (this.options.crashAfter?.("claimed")) throw new GatewayLinkCrash("claimed");

    let created: Record<string, unknown>;
    try {
      created = await this.options.auth.createApiKey({
        body: {
          userId: issuance.ownerId,
          name: managedKeyName(request.deviceLabel, link.id),
          prefix: issuance.candidatePrefix,
          expiresIn: GATEWAY_LINK_KEY_TTL_SECONDS,
        },
      });
    } catch (error) {
      this.abandonIssuance(issuance, error);
      return fail(502, "issuance_failed");
    }
    if (this.options.crashAfter?.("key-created")) throw new GatewayLinkCrash("key-created");

    const key = typeof created.key === "string" ? created.key : null;
    const keyId = typeof created.id === "string" ? created.id : null;
    if (!key || !keyId) {
      this.abandonIssuance(issuance, new Error("key creation returned no key"));
      return fail(502, "issuance_failed");
    }
    const expiresAtValue = created.expiresAt ? new Date(created.expiresAt as string | number | Date).getTime() : NaN;
    const expiresAt = Number.isFinite(expiresAtValue) ? expiresAtValue : this.now() + GATEWAY_LINK_KEY_TTL_SECONDS * 1000;

    try {
      const committed = this.db.transaction((): boolean => {
        const recorded = this.db
          .prepare("UPDATE gateway_link_issuances SET candidateKeyId = ?, state = 'created', updatedAt = ? WHERE id = ? AND state = 'claimed'")
          .run(keyId, this.now(), issuance.id);
        if (recorded.changes !== 1) return false;
        const activated = this.db
          .prepare(
            `UPDATE gateway_links
             SET keyId = ?, state = 'active', deviceLabel = ?, expiresAt = ?, activatedAt = COALESCE(activatedAt, ?), updatedAt = ?
             WHERE id = ? AND state = 'issuing' AND generation = ?`
          )
          .run(keyId, request.deviceLabel, expiresAt, this.now(), this.now(), link.id, issuance.expectedGeneration);
        if (activated.changes !== 1) return false;
        this.db.prepare("UPDATE gateway_link_issuances SET state = 'committed', updatedAt = ? WHERE id = ?").run(this.now(), issuance.id);
        this.db.prepare("UPDATE gateway_link_requests SET status = 'exchanged', updatedAt = ? WHERE id = ?").run(this.now(), request.id);
        return true;
      })();
      if (!committed) {
        // Another transition, such as a revocation, took the link while the key was created.
        this.disableCandidate(issuance, keyId);
        this.db.prepare("UPDATE gateway_link_issuances SET state = 'failed', updatedAt = ? WHERE id = ?").run(this.now(), issuance.id);
        this.db.prepare("UPDATE gateway_link_requests SET status = 'failed', updatedAt = ? WHERE id = ?").run(this.now(), request.id);
        return fail(409, "link_conflict");
      }
    } catch (error) {
      this.disableCandidate(issuance, keyId);
      this.abandonIssuance(issuance, error);
      return fail(502, "issuance_failed");
    }

    const account = this.db.prepare("SELECT email, name FROM user WHERE id = ?").get(issuance.ownerId) as { email: string | null; name: string | null } | undefined;
    this.options.logger?.info({ event: "gateway_link.issued", userId: issuance.ownerId, linkId: link.id });
    const summary = this.summarize(this.getLink(link.id) as LinkRow);
    return ok({ key, link: { ...summary, account: { email: account?.email ?? null, name: account?.name ?? null } } });
  }

  /** Cleanup after an error that did not kill the process. */
  private abandonIssuance(issuance: IssuanceRow, cause: unknown): void {
    this.options.logger?.warn({
      event: "gateway_link.issuance_failed",
      linkId: issuance.linkId,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    try {
      this.db.transaction(() => this.failIssuanceInTransaction(issuance))();
    } catch (cleanupError) {
      // The issuance stays open. The link stays unusable, and the next start resolves it.
      this.options.logger?.error({
        event: "gateway_link.cleanup_failed",
        linkId: issuance.linkId,
        error: cleanupError instanceof Error ? cleanupError.message : "unknown",
      });
    }
  }

  private failIssuanceInTransaction(issuance: IssuanceRow): void {
    const now = this.now();
    this.disableCandidate(issuance, issuance.candidateKeyId);
    this.db.prepare("UPDATE gateway_link_issuances SET state = 'failed', updatedAt = ? WHERE id = ?").run(now, issuance.id);
    const link = this.getLink(issuance.linkId);
    if (link && link.state === "issuing" && link.generation === issuance.expectedGeneration) {
      // A link that never held a key leaves no trace. A link that held one needs new consent.
      this.db
        .prepare("UPDATE gateway_links SET state = ?, keyId = NULL, updatedAt = ?, revokedAt = COALESCE(revokedAt, ?) WHERE id = ?")
        .run(link.activatedAt === null ? "revoked" : "blocked", now, link.activatedAt === null ? now : null, link.id);
    }
    this.db.prepare("UPDATE gateway_link_requests SET status = 'failed', updatedAt = ? WHERE id = ? AND status = 'exchanging'").run(now, issuance.requestId);
  }

  /** Disables the candidate by its stored prefix and owner, and by its ID when the service knows it. */
  private disableCandidate(issuance: IssuanceRow, keyId: string | null): void {
    this.db.prepare("UPDATE apikey SET enabled = 0 WHERE prefix = ? AND referenceId = ?").run(issuance.candidatePrefix, issuance.ownerId);
    if (keyId) this.db.prepare("UPDATE apikey SET enabled = 0 WHERE id = ?").run(keyId);
  }

  // ------------------------------------------------------------------ links

  listLinks(userId: string): GatewayLinkSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM gateway_links WHERE ownerId = ? AND activatedAt IS NOT NULL ORDER BY createdAt DESC LIMIT ?")
      .all(userId, MAX_LIST) as LinkRow[];
    return rows.map((row) => this.summarize(row));
  }

  /** Revokes a link that the user owns. A link of another user answers as missing. */
  revokeOwnedLink(userId: string, linkId: string): GatewayLinkResult<GatewayLinkSummary> {
    if (!this.writes.hit(userId, this.limits.consentWritesPerUser, this.now())) return fail(429, "rate_limited");
    const link = this.getLink(linkId);
    if (!link || link.ownerId !== userId) return fail(404, "not_found");
    return ok(this.revoke(link));
  }

  /** Revokes the link that owns a verified key. The caller names no link. */
  revokeByKey(keyId: string): GatewayLinkResult<GatewayLinkSummary> {
    const link = this.db.prepare("SELECT * FROM gateway_links WHERE keyId = ?").get(keyId) as LinkRow | undefined;
    if (!link) return fail(404, "not_found");
    return ok(this.revoke(link));
  }

  private revoke(link: LinkRow): GatewayLinkSummary {
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE gateway_links SET state = 'revoked', revokedAt = COALESCE(revokedAt, ?), updatedAt = ? WHERE id = ?")
        .run(now, now, link.id);
      if (link.keyId) this.db.prepare("UPDATE apikey SET enabled = 0 WHERE id = ?").run(link.keyId);
      // A key in flight is disabled by its stored prefix. The commit of that issuance then fails and disables it again.
      const open = this.db.prepare("SELECT * FROM gateway_link_issuances WHERE linkId = ? AND state IN ('claimed', 'created')").all(link.id) as IssuanceRow[];
      for (const issuance of open) this.disableCandidate(issuance, issuance.candidateKeyId);
    })();
    this.options.logger?.info({ event: "gateway_link.revoked", userId: link.ownerId, linkId: link.id });
    return this.summarize(this.getLink(link.id) as LinkRow);
  }

  /**
   * The rule for a key that the plugin already accepted. A key is managed when it has the reserved prefix or when a
   * link names it. A managed key works only while the link is active, has the same owner, and has not expired. A
   * candidate and a retired key have no active link that names them, so they fail here.
   */
  checkManagedKey(key: { id: string; prefix?: unknown; referenceId: string }): ManagedKeyCheck {
    const link = this.db.prepare("SELECT * FROM gateway_links WHERE keyId = ?").get(key.id) as LinkRow | undefined;
    if (!link) return isReservedPrefix(key.prefix) ? "inactive" : "unmanaged";
    if (link.state !== "active" || link.ownerId !== key.referenceId) return "inactive";
    if (link.expiresAt !== null && link.expiresAt <= this.now()) return "inactive";
    if (!getEligibleAccount(this.db, link.ownerId)) return "inactive";
    return "active";
  }

  /** True when the key belongs to the service: it has the reserved prefix, or a link or an issuance names it. */
  isManagedKeyId(keyId: string): boolean {
    const row = this.db.prepare("SELECT prefix FROM apikey WHERE id = ?").get(keyId) as { prefix: string | null } | undefined;
    if (row && isReservedPrefix(row.prefix)) return true;
    return Boolean(this.db.prepare("SELECT 1 FROM gateway_links WHERE keyId = ?").get(keyId));
  }

  private summarize(link: LinkRow): GatewayLinkSummary {
    return {
      id: link.id,
      deviceLabel: link.deviceLabel,
      status: this.statusOf(link),
      createdAt: new Date(link.createdAt).toISOString(),
      expiresAt: iso(link.expiresAt),
      revokedAt: iso(link.revokedAt),
    };
  }

  /** Derives the status from the link and from the current key row. A missing or disabled key means revoked. */
  private statusOf(link: LinkRow): GatewayLinkStatus {
    if (link.state === "revoked") return "revoked";
    if (link.state === "blocked") return "blocked";
    if (link.state === "issuing") return "issuing";
    if (link.expiresAt !== null && link.expiresAt <= this.now()) return "expired";
    const key = link.keyId
      ? (this.db.prepare("SELECT enabled FROM apikey WHERE id = ?").get(link.keyId) as { enabled: number | boolean } | undefined)
      : undefined;
    return key && Boolean(key.enabled) ? "active" : "revoked";
  }

  private getLink(id: string): LinkRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_links WHERE id = ?").get(id) as LinkRow | undefined;
  }

  private getRequest(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_link_requests WHERE id = ?").get(id) as RequestRow | undefined;
  }
}

export function createGatewayLinkService(options: GatewayLinkServiceOptions): GatewayLinkService {
  return new GatewayLinkService(options);
}
