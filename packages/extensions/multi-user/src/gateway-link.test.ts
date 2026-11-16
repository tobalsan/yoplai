import { afterEach, describe, expect, it } from "vitest";
import {
  consentNonce,
  hasDuplicateTopLevelKey,
  isReservedPrefix,
  isValidCallbackUri,
  keyNameDevice,
  managedKeyName,
  s256Challenge,
  sanitizeDeviceLabel,
  shortLinkId,
} from "./gateway-link-codec.js";
import { GatewayLinkCrash, type GatewayLinkService } from "./gateway-link.js";
import {
  CALLBACK_URI,
  createLinkFixture,
  pkcePair,
  readRedirect,
  requestInput,
  sessionOf,
  type LinkFixture,
} from "./gateway-link.fixture.js";

const fixtures: LinkFixture[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
});

async function fixture(options?: Parameters<typeof createLinkFixture>[0]): Promise<LinkFixture> {
  const created = await createLinkFixture(options);
  fixtures.push(created);
  return created;
}

type Flow = { requestId: string; verifier: string; state: string; code: string; redirectUrl: string };

/** Starts a request, approves it as `userId`, and returns what the local gateway holds. */
function approved(f: LinkFixture, userId: string, overrides: Parameters<typeof requestInput>[0] = {}, service: GatewayLinkService = f.service): Flow {
  const input = requestInput(overrides);
  const created = service.createRequest(input.body, `source-${Math.random()}`);
  if (!created.ok) throw new Error(`createRequest failed: ${created.error}`);
  const session = sessionOf(userId);
  const view = service.describeRequest(created.value.requestId, session);
  if (!view.ok) throw new Error(`describeRequest failed: ${view.error}`);
  const result = service.approve(created.value.requestId, view.value.nonce, session);
  if (!result.ok) throw new Error(`approve failed: ${result.error}`);
  const redirect = readRedirect(result.value.redirectUrl);
  return { requestId: created.value.requestId, verifier: input.pkce.verifier, state: input.state, code: redirect.code!, redirectUrl: result.value.redirectUrl };
}

const exchangeInput = (flow: Flow, overrides: Partial<{ verifier: string; callbackUri: string; code: string }> = {}) => ({
  code: overrides.code ?? flow.code,
  verifier: overrides.verifier ?? flow.verifier,
  callbackUri: overrides.callbackUri ?? CALLBACK_URI,
});

const enabledManagedKeys = (f: LinkFixture) =>
  f.db.prepare("SELECT id, prefix FROM apikey WHERE prefix LIKE 'gl\\_%' ESCAPE '\\' AND enabled = 1").all() as Array<{ id: string; prefix: string }>;

/** Moves the link expiry into the past. The plugin keeps its own clock, so the test edits the link record. */
const expire = (f: LinkFixture, linkId: string) => f.db.prepare("UPDATE gateway_links SET expiresAt = ? WHERE id = ?").run(f.clock.now - 1, linkId);

async function link(f: LinkFixture, userId: string, overrides: Parameters<typeof requestInput>[0] = {}) {
  const flow = approved(f, userId, overrides);
  const result = await f.service.exchange(exchangeInput(flow), "source");
  if (!result.ok) throw new Error(`exchange failed: ${result.error}`);
  return { flow, ...result.value };
}

describe("gateway link codec", () => {
  it("computes the S256 challenge of the RFC 7636 example", () => {
    expect(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it.each([
    ["http://127.0.0.1:4000/api/relay/link/callback", true],
    ["http://127.0.0.1:65535/api/relay/link/callback", true],
    ["https://127.0.0.1:4000/api/relay/link/callback", false],
    ["http://localhost:4000/api/relay/link/callback", false],
    ["http://127.0.0.2:4000/api/relay/link/callback", false],
    ["http://[::1]:4000/api/relay/link/callback", false],
    ["http://127.1:4000/api/relay/link/callback", false],
    ["http://2130706433:4000/api/relay/link/callback", false],
    ["http://127.0.0.1/api/relay/link/callback", false],
    ["http://127.0.0.1:0/api/relay/link/callback", false],
    ["http://127.0.0.1:65536/api/relay/link/callback", false],
    ["http://127.0.0.1:04000/api/relay/link/callback", false],
    ["http://user@127.0.0.1:4000/api/relay/link/callback", false],
    ["http://127.0.0.1:4000/api/relay/link/callback?x=1", false],
    ["http://127.0.0.1:4000/api/relay/link/callback#x", false],
    ["http://127.0.0.1:4000/api/relay/link/callback/", false],
    ["http://127.0.0.1:4000/api/relay/link/other", false],
    ["http://127.0.0.1:4000/api/relay/link/%63allback", false],
  ])("checks the callback URI %s", (uri, valid) => {
    expect(isValidCallbackUri(uri)).toBe(valid);
  });

  it("names a key with at most 32 characters for every label", () => {
    const labels = ["Test laptop", "", "   ", "日本語のラップトップ", "a".repeat(200), "../../etc/passwd", "name\nwith\tcontrol\u202e", "-._-._-._-._-._"];
    for (const raw of labels) {
      const label = sanitizeDeviceLabel(raw) ?? "x";
      const name = managedKeyName(label, "0123abcd-4567-89ab-cdef-0123456789ab");
      expect(name.length).toBeLessThanOrEqual(32);
      expect(name).toMatch(/^Desktop: [A-Za-z0-9._-]{1,12} \([0-9a-f]{8}\)$/);
    }
    expect(keyNameDevice("日本語")).toBe("device");
    expect(managedKeyName("Test laptop", "0123abcd-4567-89ab-cdef-0123456789ab")).toBe("Desktop: Testlaptop (0123abcd)");
    expect(shortLinkId("0123abcd-4567-89ab-cdef-0123456789ab")).toBe("0123abcd");
  });

  it("strips control and format characters from a consent label", () => {
    expect(sanitizeDeviceLabel("  My\u0000 Mac\u202e\nbook  ")).toBe("My Mac book");
    expect(sanitizeDeviceLabel("\u0000\u202e ")).toBeNull();
    expect(Array.from(sanitizeDeviceLabel("x".repeat(500))!)).toHaveLength(64);
  });

  it("detects a repeated top-level JSON key and ignores nested keys and string content", () => {
    expect(hasDuplicateTopLevelKey('{"a":1,"a":2}')).toBe(true);
    expect(hasDuplicateTopLevelKey('{"a":1,"b":2}')).toBe(false);
    expect(hasDuplicateTopLevelKey('{"a":{"x":1,"x":2},"b":"\\"a\\":1"}')).toBe(false);
    expect(hasDuplicateTopLevelKey('{"a":"v","\\u0061":"w"}')).toBe(true);
  });

  it("binds the consent nonce to the request, the session, and the expiry", () => {
    const base = consentNonce("secret", "request-1", "session-1", 100);
    expect(consentNonce("secret", "request-1", "session-1", 100)).toBe(base);
    expect(consentNonce("secret", "request-2", "session-1", 100)).not.toBe(base);
    expect(consentNonce("secret", "request-1", "session-2", 100)).not.toBe(base);
    expect(consentNonce("secret", "request-1", "session-1", 101)).not.toBe(base);
    expect(consentNonce("other", "request-1", "session-1", 100)).not.toBe(base);
  });

  it("reserves the gl_ prefix in any letter case", () => {
    expect(isReservedPrefix("gl_abc")).toBe(true);
    expect(isReservedPrefix("GL_abc")).toBe(true);
    expect(isReservedPrefix("glx")).toBe(false);
    expect(isReservedPrefix(null)).toBe(false);
  });
});

describe("gateway link request, consent, and exchange", () => {
  it("links a device: one key, 32-character name, 90-day expiry, active link", async () => {
    const f = await fixture();
    f.addUser("alice");
    const { key, link: summary } = await link(f, "alice");
    expect(key.startsWith("gl_")).toBe(true);
    expect(summary).toMatchObject({ deviceLabel: "Test laptop", status: "active", account: { email: "alice@example.test" } });
    const row = f.db.prepare("SELECT name, prefix, referenceId, enabled, expiresAt FROM apikey WHERE prefix LIKE 'gl\\_%' ESCAPE '\\'").get() as Record<string, unknown>;
    expect(row.name).toMatch(/^Desktop: Testlaptop \([0-9a-f]{8}\)$/);
    expect((row.name as string).length).toBeLessThanOrEqual(32);
    expect(row.referenceId).toBe("alice");
    expect(String(row.prefix)).toHaveLength(25);
    const days = (new Date(row.expiresAt as string | number).getTime() - f.clock.now) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const verified = await f.auth.api.verifyApiKey({ body: { key } });
    expect(verified.valid).toBe(true);
    expect(f.service.checkManagedKey({ id: verified.key!.id as string, prefix: verified.key!.prefix, referenceId: "alice" })).toBe("active");
    expect(f.service.listLinks("alice")).toEqual([expect.objectContaining({ id: summary.id, status: "active" })]);
  });

  it("returns the plaintext key once and stores no plaintext key, code, verifier, or state", async () => {
    const f = await fixture();
    f.addUser("alice");
    const { key, flow } = await link(f, "alice");
    const dump = JSON.stringify(
      ["gateway_links", "gateway_link_requests", "gateway_link_issuances"].flatMap((table) => f.db.prepare(`SELECT * FROM ${table}`).all())
    );
    for (const secret of [key, flow.code, flow.verifier]) expect(dump).not.toContain(secret);
    expect(f.db.prepare("SELECT 1 FROM apikey WHERE key = ?").get(key)).toBeUndefined();
    const again = await f.service.exchange(exchangeInput(flow), "source");
    expect(again).toEqual({ ok: false, status: 400, error: "invalid_grant" });
  });

  it("never logs a key, a verifier, a code, or a state", async () => {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => lines.push(JSON.stringify(args));
    const f = await fixture({ logger: { info: sink, warn: sink, error: sink } });
    f.addUser("alice");
    const { key, flow } = await link(f, "alice");
    await f.service.exchange(exchangeInput(flow), "source");
    const output = lines.join("\n");
    expect(output).toContain("gateway_link.issued");
    for (const secret of [key, flow.code, flow.verifier, flow.state]) expect(output).not.toContain(secret);
  });

  it("burns the code on a wrong verifier, so the right verifier fails afterwards", async () => {
    const f = await fixture();
    f.addUser("alice");
    const flow = approved(f, "alice");
    expect(await f.service.exchange(exchangeInput(flow, { verifier: pkcePair().verifier }), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await f.service.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.service.listLinks("alice")).toEqual([]);
    expect(enabledManagedKeys(f)).toHaveLength(0);
  });

  it("rejects another callback URI and an unknown code", async () => {
    const f = await fixture();
    f.addUser("alice");
    const flow = approved(f, "alice");
    expect(await f.service.exchange(exchangeInput(flow, { callbackUri: "http://127.0.0.1:4556/api/relay/link/callback" }), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await f.service.exchange(exchangeInput(flow, { code: "not-a-code" }), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("expires a request after five minutes and a code after sixty seconds", async () => {
    const f = await fixture();
    f.addUser("alice");
    const input = requestInput();
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    const session = sessionOf("alice");
    const view = f.service.describeRequest(created.value.requestId, session);
    if (!view.ok) throw new Error("describe failed");
    f.clock.now += 5 * 60_000;
    expect(f.service.approve(created.value.requestId, view.value.nonce, session)).toMatchObject({ ok: false, error: "request_not_pending" });
    expect(f.service.describeRequest(created.value.requestId, session)).toMatchObject({ ok: true, value: { status: "expired" } });

    const flow = approved(f, "alice");
    f.clock.now += 61_000;
    expect(await f.service.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(enabledManagedKeys(f)).toHaveLength(0);
  });

  it("binds the consent nonce to the session and refuses a replay or a second action", async () => {
    const f = await fixture();
    f.addUser("alice");
    f.addUser("bob");
    const input = requestInput();
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    const alice = sessionOf("alice");
    const view = f.service.describeRequest(created.value.requestId, alice);
    if (!view.ok) throw new Error("describe failed");
    expect(f.service.approve(created.value.requestId, view.value.nonce, sessionOf("bob"))).toMatchObject({ ok: false, error: "invalid_nonce" });
    expect(f.service.approve(created.value.requestId, "x".repeat(43), alice)).toMatchObject({ ok: false, error: "invalid_nonce" });
    expect(f.service.approve(created.value.requestId, view.value.nonce, alice)).toMatchObject({ ok: true });
    expect(f.service.approve(created.value.requestId, view.value.nonce, alice)).toMatchObject({ ok: false, error: "request_not_pending" });
    expect(f.service.deny(created.value.requestId, view.value.nonce, alice)).toMatchObject({ ok: false, error: "request_not_pending" });
  });

  it("denies with an access_denied callback, no code, and no key", async () => {
    const f = await fixture();
    f.addUser("alice");
    const input = requestInput();
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    const alice = sessionOf("alice");
    const view = f.service.describeRequest(created.value.requestId, alice);
    if (!view.ok) throw new Error("describe failed");
    const denied = f.service.deny(created.value.requestId, view.value.nonce, alice);
    if (!denied.ok) throw new Error("deny failed");
    expect(readRedirect(denied.value.redirectUrl)).toEqual({ base: CALLBACK_URI, error: "access_denied", state: input.state, code: undefined });
    expect(f.service.approve(created.value.requestId, view.value.nonce, alice)).toMatchObject({ ok: false, error: "request_not_pending" });
    expect(f.service.describeRequest(created.value.requestId, alice)).toMatchObject({ ok: true, value: { status: "denied" } });
    expect(f.service.listLinks("alice")).toEqual([]);
  });

  it("refuses a deleted, banned, or unapproved user at consent and at exchange", async () => {
    const f = await fixture();
    f.addUser("banned", { banned: true });
    f.addUser("pending", { approved: false });
    const input = requestInput();
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    for (const userId of ["banned", "pending", "ghost"]) {
      expect(f.service.describeRequest(created.value.requestId, sessionOf(userId))).toMatchObject({ ok: false, error: "forbidden" });
      expect(f.service.approve(created.value.requestId, "n", sessionOf(userId))).toMatchObject({ ok: false, error: "forbidden" });
    }
    f.addUser("alice");
    const flow = approved(f, "alice");
    f.db.prepare("UPDATE user SET banned = 1 WHERE id = 'alice'").run();
    expect(await f.service.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, error: "forbidden" });
    expect(enabledManagedKeys(f)).toHaveLength(0);
  });

  it("rejects an invalid callback or label at request creation", async () => {
    const f = await fixture();
    const base = requestInput().body;
    expect(f.service.createRequest({ ...base, callbackUri: "http://localhost:4000/api/relay/link/callback" }, "s")).toMatchObject({ ok: false, error: "invalid_callback" });
    expect(f.service.createRequest({ ...base, deviceLabel: "\u0000\u202e" }, "s")).toMatchObject({ ok: false, error: "invalid_device_label" });
  });

  it("limits request starts for each source, pending requests, consent writes, and exchanges", async () => {
    const f = await fixture({ limits: { startsPerSource: 2, pendingRequests: 3, consentWritesPerUser: 2, exchangesPerCode: 2, exchangesPerSource: 100 } });
    f.addUser("alice");
    const body = requestInput().body;
    expect(f.service.createRequest(body, "a")).toMatchObject({ ok: true });
    expect(f.service.createRequest(body, "a")).toMatchObject({ ok: true });
    expect(f.service.createRequest(body, "a")).toMatchObject({ ok: false, status: 429 });
    expect(f.service.createRequest(body, "b")).toMatchObject({ ok: true });
    expect(f.service.createRequest(body, "c")).toMatchObject({ ok: false, status: 503, error: "too_many_requests" });
    f.clock.now += 60_000;
    // Three requests are still pending. The window reset does not clear the cap.
    expect(f.service.createRequest(body, "d")).toMatchObject({ ok: false, status: 503 });

    const session = sessionOf("alice");
    expect(f.service.approve("missing", "n", session)).toMatchObject({ ok: false, status: 404 });
    expect(f.service.approve("missing", "n", session)).toMatchObject({ ok: false, status: 404 });
    expect(f.service.approve("missing", "n", session)).toMatchObject({ ok: false, status: 429 });

    expect(await f.service.exchange({ code: "c", verifier: "v".repeat(43), callbackUri: CALLBACK_URI }, "s")).toMatchObject({ status: 400 });
    expect(await f.service.exchange({ code: "c", verifier: "v".repeat(43), callbackUri: CALLBACK_URI }, "s")).toMatchObject({ status: 400 });
    expect(await f.service.exchange({ code: "c", verifier: "v".repeat(43), callbackUri: CALLBACK_URI }, "s")).toMatchObject({ status: 429 });
  });
});

describe("gateway link re-link, revocation, and key checks", () => {
  it("re-links with the same link ID: the old key stops, the new key works, the generation rises", async () => {
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    const second = await link(f, "alice", { replaceLinkId: first.link.id, deviceLabel: "Renamed" });
    expect(second.link.id).toBe(first.link.id);
    expect(second.link).toMatchObject({ deviceLabel: "Renamed", status: "active" });
    expect((await f.auth.api.verifyApiKey({ body: { key: first.key } })).valid).toBe(false);
    expect((await f.auth.api.verifyApiKey({ body: { key: second.key } })).valid).toBe(true);
    expect(f.db.prepare("SELECT generation FROM gateway_links WHERE id = ?").get(first.link.id)).toEqual({ generation: 2 });
    expect(enabledManagedKeys(f)).toHaveLength(1);
    expect(f.service.listLinks("alice")).toHaveLength(1);
  });

  it("re-links after the key expired and after a revocation", async () => {
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    expire(f, first.link.id);
    expect(f.service.listLinks("alice")[0]).toMatchObject({ status: "expired" });
    const second = await link(f, "alice", { replaceLinkId: first.link.id });
    expect(second.link.status).toBe("active");
    expect(f.service.revokeOwnedLink("alice", first.link.id)).toMatchObject({ ok: true, value: { status: "revoked" } });
    const third = await link(f, "alice", { replaceLinkId: first.link.id });
    expect(third.link.status).toBe("active");
    expect(enabledManagedKeys(f)).toHaveLength(1);
  });

  it("does not let another account replace a link, at view, approval, or exchange", async () => {
    const f = await fixture();
    f.addUser("alice");
    f.addUser("bob");
    const first = await link(f, "alice");
    const input = requestInput({ replaceLinkId: first.link.id });
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    const bob = sessionOf("bob");
    const view = f.service.describeRequest(created.value.requestId, bob);
    expect(view).toMatchObject({ ok: true, value: { replaces: null, replaceConflict: true } });
    if (!view.ok) throw new Error("describe failed");
    expect(f.service.approve(created.value.requestId, view.value.nonce, bob)).toMatchObject({ ok: false, error: "replace_not_allowed" });
    // The request is still pending, and alice's key still works.
    expect((await f.auth.api.verifyApiKey({ body: { key: first.key } })).valid).toBe(true);
    const aliceView = f.service.describeRequest(created.value.requestId, sessionOf("alice"));
    expect(aliceView).toMatchObject({ ok: true, value: { replaces: { id: first.link.id }, replaceConflict: false } });
  });

  it("lists the older links of the same device name so a lost first exchange has a visible recovery", async () => {
    const f = await fixture();
    f.addUser("alice");
    f.addUser("bob");
    const first = await link(f, "alice", { deviceLabel: "Same name" });
    const input = requestInput({ deviceLabel: "Same name" });
    const created = f.service.createRequest(input.body, "source");
    if (!created.ok) throw new Error("create failed");
    const seen = (userId: string) => {
      const view = f.service.describeRequest(created.value.requestId, sessionOf(userId));
      if (!view.ok) throw new Error("describe failed");
      return view.value.sameDeviceLinks.map((entry) => entry.id);
    };
    expect(seen("alice")).toEqual([first.link.id]);
    // Another account sees nothing, and a different name matches nothing.
    expect(seen("bob")).toEqual([]);
    const other = f.service.createRequest(requestInput({ deviceLabel: "Other name" }).body, "source2");
    if (!other.ok) throw new Error("create failed");
    const otherView = f.service.describeRequest(other.value.requestId, sessionOf("alice"));
    expect(otherView).toMatchObject({ ok: true, value: { sameDeviceLinks: [] } });
    // A revoked link needs no warning, and the link that this request replaces is not listed twice.
    f.service.revokeOwnedLink("alice", first.link.id);
    expect(seen("alice")).toEqual([]);
  });

  it("fails an exchange whose approved generation changed", async () => {
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    const stale = approved(f, "alice", { replaceLinkId: first.link.id });
    const winner = await link(f, "alice", { replaceLinkId: first.link.id });
    expect(await f.service.exchange(exchangeInput(stale), "source")).toMatchObject({ ok: false, error: "link_conflict" });
    expect((await f.auth.api.verifyApiKey({ body: { key: winner.key } })).valid).toBe(true);
    expect(enabledManagedKeys(f)).toHaveLength(1);
  });

  it("revokes for the owner only and by verified key", async () => {
    const f = await fixture();
    f.addUser("alice");
    f.addUser("bob");
    const first = await link(f, "alice");
    expect(f.service.revokeOwnedLink("bob", first.link.id)).toMatchObject({ ok: false, status: 404 });
    expect((await f.auth.api.verifyApiKey({ body: { key: first.key } })).valid).toBe(true);
    const verified = await f.auth.api.verifyApiKey({ body: { key: first.key } });
    expect(f.service.revokeByKey(verified.key!.id as string)).toMatchObject({ ok: true, value: { status: "revoked" } });
    expect((await f.auth.api.verifyApiKey({ body: { key: first.key } })).valid).toBe(false);
    expect(f.service.revokeByKey("unknown")).toMatchObject({ ok: false, status: 404 });
    // Revoking again is not an error.
    expect(f.service.revokeOwnedLink("alice", first.link.id)).toMatchObject({ ok: true, value: { status: "revoked" } });
  });

  it("derives revoked from a deleted key row and checks managed keys fail closed", async () => {
    const f = await fixture();
    f.addUser("alice");
    f.addUser("bob");
    const first = await link(f, "alice");
    const verified = await f.auth.api.verifyApiKey({ body: { key: first.key } });
    const keyId = verified.key!.id as string;
    expect(f.service.checkManagedKey({ id: keyId, prefix: verified.key!.prefix, referenceId: "bob" })).toBe("inactive");
    f.db.prepare("UPDATE user SET banned = 1 WHERE id = 'alice'").run();
    expect(f.service.checkManagedKey({ id: keyId, prefix: verified.key!.prefix, referenceId: "alice" })).toBe("inactive");
    f.db.prepare("UPDATE user SET banned = 0 WHERE id = 'alice'").run();
    const expiresAt = (f.db.prepare("SELECT expiresAt FROM gateway_links WHERE id = ?").get(first.link.id) as { expiresAt: number }).expiresAt;
    expire(f, first.link.id);
    expect(f.service.checkManagedKey({ id: keyId, prefix: verified.key!.prefix, referenceId: "alice" })).toBe("inactive");
    f.db.prepare("UPDATE gateway_links SET expiresAt = ? WHERE id = ?").run(expiresAt, first.link.id);
    f.db.prepare("DELETE FROM apikey WHERE id = ?").run(keyId);
    expect(f.service.listLinks("alice")[0]).toMatchObject({ status: "revoked" });
    // A reserved-prefix key that no link names is never active. A plain key is not managed.
    expect(f.service.checkManagedKey({ id: "stray", prefix: "gl_stray", referenceId: "alice" })).toBe("inactive");
    expect(f.service.checkManagedKey({ id: "plain", prefix: null, referenceId: "alice" })).toBe("unmanaged");
    expect(f.service.isManagedKeyId(keyId)).toBe(true);
  });

  it("holds the database invariants: one open issuance for each link and one key row for each prefix", async () => {
    const f = await fixture();
    f.addUser("alice");
    const insert = (id: string, prefix: string, state: string) =>
      f.db
        .prepare(
          "INSERT INTO gateway_link_issuances (id, requestId, linkId, ownerId, expectedGeneration, candidatePrefix, state, createdAt, updatedAt) VALUES (?, 'r', 'link-1', 'alice', 1, ?, ?, 0, 0)"
        )
        .run(id, prefix, state);
    insert("i1", "gl_one", "claimed");
    expect(() => insert("i2", "gl_two", "created")).toThrow(/UNIQUE/);
    expect(() => insert("i3", "gl_one", "failed")).toThrow(/UNIQUE/);
    insert("i4", "gl_four", "failed");
    await f.auth.api.createApiKey({ body: { userId: "alice", name: "one", prefix: "gl_same" } });
    await expect(f.auth.api.createApiKey({ body: { userId: "alice", name: "two", prefix: "gl_same" } })).rejects.toThrow();
  });
});

describe("gateway link issuance faults", () => {
  it("leaves no usable key when key creation fails for a new link, and the code stays used", async () => {
    const f = await fixture({ auth: { createApiKey: async () => { throw new Error("boom"); } } });
    f.addUser("alice");
    const flow = approved(f, "alice");
    expect(await f.service.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, status: 502, error: "issuance_failed" });
    expect(f.service.listLinks("alice")).toEqual([]);
    expect(enabledManagedKeys(f)).toHaveLength(0);
    expect(f.db.prepare("SELECT state FROM gateway_link_issuances").all()).toEqual([{ state: "failed" }]);
    expect(await f.service.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("blocks a re-linked link when key creation fails, and the old key stays disabled", async () => {
    let fail = false;
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    const original = f.auth.api.createApiKey.bind(f.auth.api);
    const failing = f.restart({
      auth: {
        createApiKey: (args) => {
          if (fail) throw new Error("boom");
          return original(args);
        },
      },
    });
    fail = true;
    const flow = approved(f, "alice", { replaceLinkId: first.link.id }, failing);
    expect(await failing.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, status: 502 });
    expect(failing.listLinks("alice")[0]).toMatchObject({ id: first.link.id, status: "blocked" });
    expect((await f.auth.api.verifyApiKey({ body: { key: first.key } })).valid).toBe(false);
    expect(enabledManagedKeys(f)).toHaveLength(0);
    // New consent unblocks the link.
    fail = false;
    const retry = approved(f, "alice", { replaceLinkId: first.link.id }, failing);
    expect(await failing.exchange(exchangeInput(retry), "source")).toMatchObject({ ok: true, value: { link: { id: first.link.id, status: "active" } } });
    expect(enabledManagedKeys(f)).toHaveLength(1);
  });

  it("recovers a crash after the issuance claim: the old key stays disabled and no candidate exists", async () => {
    const f = await fixture();
    f.addUser("alice");
    const initial = await link(f, "alice");
    const crashing = f.restart({ crashAfter: (boundary) => boundary === "claimed" });
    const flow = approved(f, "alice", { replaceLinkId: initial.link.id }, crashing);
    await expect(crashing.exchange(exchangeInput(flow), "source")).rejects.toBeInstanceOf(GatewayLinkCrash);
    // The old key is already disabled and the link is in flight. A restart resolves it.
    expect((await f.auth.api.verifyApiKey({ body: { key: initial.key } })).valid).toBe(false);
    expect(f.db.prepare("SELECT state FROM gateway_links WHERE id = ?").get(initial.link.id)).toEqual({ state: "issuing" });
    const restarted = f.restart();
    expect(restarted.listLinks("alice")[0]).toMatchObject({ status: "blocked" });
    expect(enabledManagedKeys(f)).toHaveLength(0);
    expect(f.db.prepare("SELECT state FROM gateway_link_issuances ORDER BY createdAt DESC, rowid DESC").all()[0]).toEqual({ state: "failed" });
    expect(await restarted.exchange(exchangeInput(flow), "source")).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("finds a candidate that a crash left behind by its stored prefix and disables it", async () => {
    const f = await fixture({ crashAfter: (boundary) => boundary === "key-created" });
    f.addUser("alice");
    const flow = approved(f, "alice");
    await expect(f.service.exchange(exchangeInput(flow), "source")).rejects.toBeInstanceOf(GatewayLinkCrash);
    // The plugin inserted an enabled key. The service never received its ID or committed it.
    expect(enabledManagedKeys(f)).toHaveLength(1);
    const issuance = f.db.prepare("SELECT candidatePrefix, candidateKeyId, state FROM gateway_link_issuances").get() as { candidatePrefix: string; candidateKeyId: string | null; state: string };
    expect(issuance).toMatchObject({ candidateKeyId: null, state: "claimed" });
    expect(enabledManagedKeys(f)[0]!.prefix).toBe(issuance.candidatePrefix);
    const restarted = f.restart({ crashAfter: undefined });
    expect(enabledManagedKeys(f)).toHaveLength(0);
    expect(restarted.listLinks("alice")).toEqual([]);
    expect(f.db.prepare("SELECT state FROM gateway_link_issuances").get()).toEqual({ state: "failed" });
  });

  it("does not become ready while a recovery step fails", async () => {
    const f = await fixture({ crashAfter: (boundary) => boundary === "key-created" });
    f.addUser("alice");
    const flow = approved(f, "alice");
    await expect(f.service.exchange(exchangeInput(flow), "source")).rejects.toBeInstanceOf(GatewayLinkCrash);
    f.db.exec("ALTER TABLE apikey RENAME TO apikey_gone");
    expect(() => f.restart()).toThrow();
    f.db.exec("ALTER TABLE apikey_gone RENAME TO apikey");
    const healed = f.restart();
    expect(healed.isReady()).toBe(true);
    expect(enabledManagedKeys(f)).toHaveLength(0);
  });

  it("disables the candidate when a revocation lands while the key is created", async () => {
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const original = f.auth.api.createApiKey.bind(f.auth.api);
    const slow = f.restart({
      auth: {
        createApiKey: async (args) => {
          entered();
          await gate;
          return original(args);
        },
      },
    });
    const flow = approved(f, "alice", { replaceLinkId: first.link.id }, slow);
    const pending = slow.exchange(exchangeInput(flow), "source");
    await inside;
    expect(slow.revokeOwnedLink("alice", first.link.id)).toMatchObject({ ok: true, value: { status: "revoked" } });
    release();
    expect(await pending).toMatchObject({ ok: false, error: "link_conflict" });
    expect(enabledManagedKeys(f)).toHaveLength(0);
    expect(slow.listLinks("alice")[0]).toMatchObject({ status: "revoked" });
  });

  it("allows one usable key for each link after parallel exchanges of two requests", async () => {
    const f = await fixture();
    f.addUser("alice");
    const first = await link(f, "alice");
    const a = approved(f, "alice", { replaceLinkId: first.link.id });
    const b = approved(f, "alice", { replaceLinkId: first.link.id });
    const results = await Promise.all([f.service.exchange(exchangeInput(a), "source"), f.service.exchange(exchangeInput(b), "source")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ error: "link_conflict" })]);
    expect(enabledManagedKeys(f)).toHaveLength(1);
  });
});
