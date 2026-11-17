import { afterEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import { createGatewayLinkService } from "./gateway-link.js";
import { startImpersonation, endImpersonation } from "./impersonation.js";
import { createAuthMiddleware, forwardAuthContextToRequest, getRequestAuthContext, isVerifiedBearerRequest } from "./middleware.js";
import { registerMultiUserRoutes } from "./routes.js";
import { setMultiUserRuntime, type MultiUserRuntime } from "./runtime-state.js";
import { CALLBACK_URI, REMOTE_ORIGIN, SESSION_SECRET, createLinkFixture, pkcePair, readRedirect, type LinkFixture } from "./gateway-link.fixture.js";
import { randomBase64Url } from "./gateway-link-codec.js";

/**
 * The real gateway shape: an outer app with the authentication middleware and an inner API that gets the verified
 * identity through its bindings, with a real Better Auth (email and password), a real key plugin, and the real routes.
 * Every account here is synthetic.
 */

type Account = { id: string; email: string; cookie: string; sessionId: string };
type Harness = LinkFixture & {
  request(path: string, init?: RequestInit, peerAddress?: string): Promise<Response>;
  signUp(name: string): Promise<Account>;
  linkDevice(account: Account, options?: { deviceLabel?: string; replaceLinkId?: string }): Promise<{ key: string; linkId: string; keyId: string }>;
};

const harnesses: Harness[] = [];
afterEach(() => {
  setMultiUserRuntime(null);
  while (harnesses.length > 0) harnesses.pop()?.close();
});

type Bindings = { multiUserAuthContext?: ReturnType<typeof getRequestAuthContext>; multiUserBearerVerified?: boolean };

async function harness(options: Parameters<typeof createLinkFixture>[0] = {}): Promise<Harness> {
  const fixture = await createLinkFixture(options);
  setMultiUserRuntime({ auth: fixture.auth, db: fixture.db, gatewayLinks: fixture.service, assignments: { getAssignmentsForUser: () => [] }, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as unknown as MultiUserRuntime);
  const api = new Hono();
  api.use("*", async (c: Context, next) => {
    const bindings = c.env as Bindings | undefined;
    if (bindings?.multiUserAuthContext) c.set("multiUserAuthContext", bindings.multiUserAuthContext);
    if (bindings?.multiUserAuthContext && bindings.multiUserBearerVerified === true) c.set("multiUserBearerVerified", true);
    await next();
  });
  registerMultiUserRoutes(api);
  const app = new Hono();
  app.use("/api/*", createAuthMiddleware());
  app.all("/api/*", (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(4) || "/";
    const request = new Request(url, { method: c.req.method, headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit);
    const authContext = getRequestAuthContext(c);
    forwardAuthContextToRequest(request, authContext);
    const verified = authContext !== null && isVerifiedBearerRequest(c);
    const peerAddress = (c.env as { peerAddress?: string } | undefined)?.peerAddress;
    return api.fetch(request, { multiUserAuthContext: authContext, multiUserBearerVerified: verified, peerAddress });
  });
  const built: Harness = {
    ...fixture,
    request: (path, init, peerAddress = "198.51.100.7") => Promise.resolve(app.request(`${REMOTE_ORIGIN}${path}`, init, { peerAddress })),
    async signUp(name) {
      const email = `${name}@example.test`;
      const response = await fixture.auth.handler(
        new Request(`${REMOTE_ORIGIN}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: REMOTE_ORIGIN },
          body: JSON.stringify({ email, name, password: "synthetic-password-for-isolated-test" }),
        })
      );
      expect(response.status).toBe(200);
      const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const session = await fixture.auth.api.getSession({ headers: new Headers({ Cookie: cookie }) });
      return { id: session!.user.id, email, cookie, sessionId: session!.session.id };
    },
    async linkDevice(account, linkOptions = {}) {
      const start = await startRequest(built, linkOptions);
      const consent = await consentGet(built, account, start.requestId);
      const approved = await consentPost(built, account, "approve", start.requestId, consent.nonce);
      expect(approved.status).toBe(200);
      const redirect = readRedirect(((await approved.json()) as { redirectUrl: string }).redirectUrl);
      const token = await exchange(built, { code: redirect.code!, verifier: start.pkce.verifier });
      expect(token.status).toBe(200);
      const body = (await token.json()) as { key: string; link: { id: string } };
      const keyId = (fixture.db.prepare("SELECT keyId FROM gateway_links WHERE id = ?").get(body.link.id) as { keyId: string }).keyId;
      return { key: body.key, linkId: body.link.id, keyId };
    },
  };
  harnesses.push(built);
  return built;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function startRequest(h: Harness, options: { deviceLabel?: string; replaceLinkId?: string; peerAddress?: string; headers?: Record<string, string> } = {}) {
  const pkce = pkcePair();
  const state = randomBase64Url(32);
  const response = await h.request(
    "/api/auth/gateway-link/requests",
    {
      method: "POST",
      headers: { ...JSON_HEADERS, ...options.headers },
      body: JSON.stringify({
        challenge: pkce.challenge,
        state,
        callbackUri: CALLBACK_URI,
        deviceLabel: options.deviceLabel ?? "Test laptop",
        ...(options.replaceLinkId ? { replaceLinkId: options.replaceLinkId } : {}),
      }),
    },
    options.peerAddress ?? `198.51.100.${Math.floor(Math.random() * 200) + 1}`
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { requestId: string; expiresAt: string };
  return { ...body, pkce, state };
}

async function consentGet(h: Harness, account: Account, requestId: string) {
  const response = await h.request(`/api/auth/gateway-link/requests/${requestId}`, { headers: { cookie: account.cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as { nonce: string; status: string; deviceLabel: string; account: { email: string }; replaces: unknown; replaceConflict: boolean };
}

const consentPost = (h: Harness, account: Account, action: "approve" | "deny", requestId: string, nonce: string, headers: Record<string, string> = {}) =>
  h.request(`/api/auth/gateway-link/${action}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie: account.cookie, origin: REMOTE_ORIGIN, ...headers },
    body: JSON.stringify({ requestId, nonce }),
  });

const exchange = (h: Harness, input: { code: string; verifier: string; callbackUri?: string }, headers: Record<string, string> = {}) =>
  h.request("/api/auth/gateway-link/token", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ callbackUri: CALLBACK_URI, ...input }),
  });

const me = (h: Harness, key: string) => h.request("/api/me", { headers: { authorization: `Bearer ${key}` } });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("gateway link routes: one link end to end", () => {
  it("links a device with a cookie consent and a native exchange, and the key signs in", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const start = await startRequest(h);
    expect(new Date(start.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const consent = await consentGet(h, alice, start.requestId);
    expect(consent).toMatchObject({ status: "pending", deviceLabel: "Test laptop", account: { email: "alice@example.test" }, replaces: null });
    // The consent read exposes no state, code, verifier, key, or callback URL.
    const serialized = JSON.stringify(consent);
    for (const secret of [start.state, start.pkce.verifier, start.pkce.challenge, CALLBACK_URI]) expect(serialized).not.toContain(secret);

    const approved = await consentPost(h, alice, "approve", start.requestId, consent.nonce);
    expect(approved.status).toBe(200);
    expect(approved.headers.get("cache-control")).toBe("no-store");
    const redirect = readRedirect(((await approved.json()) as { redirectUrl: string }).redirectUrl);
    expect(redirect).toMatchObject({ base: CALLBACK_URI, state: start.state });

    const token = await exchange(h, { code: redirect.code!, verifier: start.pkce.verifier });
    expect(token.status).toBe(200);
    expect(token.headers.get("cache-control")).toBe("no-store");
    const body = (await token.json()) as { key: string; link: { id: string; status: string } };
    expect(body.link.status).toBe("active");
    const signedIn = await me(h, body.key);
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).toMatchObject({ user: { id: alice.id, email: "alice@example.test" } });

    // The owner list shows the link. No key or code appears in it.
    const list = await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } });
    expect(list.status).toBe(200);
    const listed = JSON.stringify(await list.json());
    expect(listed).toContain(body.link.id);
    expect(listed).not.toContain(body.key);
    // A repeated exchange fails and never returns the key again.
    const repeat = await exchange(h, { code: redirect.code!, verifier: start.pkce.verifier });
    expect(repeat.status).toBe(400);
    expect(JSON.stringify(await repeat.json())).not.toContain(body.key);
  });

  it("tells the consent page about an older link of the same device name", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const first = await h.linkDevice(alice, { deviceLabel: "Same name" });
    const fresh = await startRequest(h, { deviceLabel: "Same name" });
    const view = (await consentGet(h, alice, fresh.requestId)) as { sameDeviceLinks: Array<{ id: string; status: string }> };
    expect(view.sameDeviceLinks).toEqual([expect.objectContaining({ id: first.linkId, status: "active" })]);
    // Revoke it, as the page tells the user, and the notice goes away.
    const revoked = await h.request("/api/auth/gateway-link/revoke", { method: "POST", headers: { ...JSON_HEADERS, cookie: alice.cookie, origin: REMOTE_ORIGIN }, body: JSON.stringify({ linkId: first.linkId }) });
    expect(revoked.status).toBe(200);
    expect(((await consentGet(h, alice, fresh.requestId)) as { sameDeviceLinks: unknown[] }).sameDeviceLinks).toEqual([]);
  });

  it("answers Refuse with an access_denied callback and issues no key", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const start = await startRequest(h);
    const consent = await consentGet(h, alice, start.requestId);
    const denied = await consentPost(h, alice, "deny", start.requestId, consent.nonce);
    expect(denied.status).toBe(200);
    expect(readRedirect(((await denied.json()) as { redirectUrl: string }).redirectUrl)).toMatchObject({ error: "access_denied", state: start.state });
    expect((await consentPost(h, alice, "approve", start.requestId, consent.nonce)).status).toBe(409);
    expect((await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links).toEqual([]);
  });

  it("rejects a wrong verifier, a wrong callback URI, and a foreign session nonce", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const bob = await h.signUp("bob");
    const start = await startRequest(h);
    const consent = await consentGet(h, alice, start.requestId);
    // Bob cannot use the nonce of alice, and bob has no nonce for alice's session.
    expect((await consentPost(h, bob, "approve", start.requestId, consent.nonce)).status).toBe(403);
    const approved = await consentPost(h, alice, "approve", start.requestId, consent.nonce);
    const redirect = readRedirect(((await approved.json()) as { redirectUrl: string }).redirectUrl);
    expect((await exchange(h, { code: redirect.code!, verifier: pkcePair().verifier })).status).toBe(400);
    expect((await exchange(h, { code: redirect.code!, verifier: start.pkce.verifier })).status).toBe(400);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE prefix LIKE 'gl\\_%' ESCAPE '\\'").get()).toEqual({ count: 0 });
    const other = await startRequest(h);
    const otherConsent = await consentGet(h, alice, other.requestId);
    const otherApproved = readRedirect(((await (await consentPost(h, alice, "approve", other.requestId, otherConsent.nonce)).json()) as { redirectUrl: string }).redirectUrl);
    expect((await exchange(h, { code: otherApproved.code!, verifier: other.pkce.verifier, callbackUri: "http://127.0.0.1:1/api/relay/link/callback" })).status).toBe(400);
  });

  it("refuses an expired request and an expired code", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const stale = await startRequest(h);
    const staleConsent = await consentGet(h, alice, stale.requestId);
    h.clock.now += 5 * 60_000 + 1;
    expect((await consentPost(h, alice, "approve", stale.requestId, staleConsent.nonce)).status).toBe(409);
    expect((await consentGet(h, alice, stale.requestId)).status).toBe("expired");
    const fresh = await startRequest(h);
    const freshConsent = await consentGet(h, alice, fresh.requestId);
    const approved = await consentPost(h, alice, "approve", fresh.requestId, freshConsent.nonce);
    const redirect = readRedirect(((await approved.json()) as { redirectUrl: string }).redirectUrl);
    h.clock.now += 61_000;
    expect((await exchange(h, { code: redirect.code!, verifier: fresh.pkce.verifier })).status).toBe(400);
  });
});

describe("gateway link routes: origin, session, and body rules", () => {
  it("refuses every supplied Origin on request creation and exchange", async () => {
    const h = await harness();
    for (const origin of [REMOTE_ORIGIN, "null", "https://evil.example.test", "http://127.0.0.1:4555"]) {
      const response = await h.request("/api/auth/gateway-link/requests", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin },
        body: JSON.stringify({ challenge: "A".repeat(43), state: "B".repeat(43), callbackUri: CALLBACK_URI, deviceLabel: "x" }),
      });
      expect(response.status).toBe(403);
      const token = await exchange(h, { code: "c", verifier: "v".repeat(43) }, { origin });
      expect(token.status).toBe(403);
    }
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM gateway_link_requests").get()).toEqual({ count: 0 });
  });

  it("needs the exact web Origin for consent writes and refuses an absent, null, foreign, or duplicate Origin", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const start = await startRequest(h);
    const consent = await consentGet(h, alice, start.requestId);
    const attempts: Array<Record<string, string> | null> = [null, { origin: "null" }, { origin: "https://evil.example.test" }, { origin: `${REMOTE_ORIGIN}, ${REMOTE_ORIGIN}` }, { origin: "http://127.0.0.1:4555" }];
    for (const headers of attempts) {
      const response = await h.request("/api/auth/gateway-link/approve", {
        method: "POST",
        headers: { ...JSON_HEADERS, cookie: alice.cookie, ...(headers ?? {}) },
        body: JSON.stringify({ requestId: start.requestId, nonce: consent.nonce }),
      });
      expect(response.status).toBe(403);
    }
    expect((await consentGet(h, alice, start.requestId)).status).toBe("pending");
    // A foreign Origin on the consent read is refused too.
    const read = await h.request(`/api/auth/gateway-link/requests/${start.requestId}`, { headers: { cookie: alice.cookie, origin: "https://evil.example.test" } });
    expect(read.status).toBe(403);
  });

  it("needs a real cookie session: no cookie, a bearer, and an impersonating session fail", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const start = await startRequest(h);
    expect((await h.request(`/api/auth/gateway-link/requests/${start.requestId}`)).status).toBe(401);
    expect((await h.request("/api/auth/gateway-link/links")).status).toBe(401);
    const consent = await consentGet(h, alice, start.requestId);
    const device = await h.linkDevice(alice);
    // A managed bearer next to a valid cookie still gives no consent authority.
    const withBearer = await consentPost(h, alice, "approve", start.requestId, consent.nonce, { authorization: `Bearer ${device.key}` });
    expect(withBearer.status).toBe(401);
    startImpersonation(alice.sessionId, "someone-else");
    try {
      const impersonating = await consentPost(h, alice, "approve", start.requestId, consent.nonce);
      expect(impersonating.status).toBe(403);
      expect(await json(impersonating)).toEqual({ error: "impersonation_not_allowed" });
    } finally {
      endImpersonation(alice.sessionId);
    }
    expect((await consentGet(h, alice, start.requestId)).status).toBe("pending");
  });

  it("refuses a wrong content type, an oversized body, a repeated key, an unknown key, and a bad callback", async () => {
    const h = await harness();
    const post = (body: string, headers: Record<string, string> = JSON_HEADERS) => h.request("/api/auth/gateway-link/requests", { method: "POST", headers, body });
    const valid = { challenge: "A".repeat(43), state: "B".repeat(43), callbackUri: CALLBACK_URI, deviceLabel: "x" };
    expect((await post(JSON.stringify(valid), { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(JSON.stringify({ ...valid, deviceLabel: "x".repeat(5000) }))).status).toBe(413);
    expect((await post(`{"challenge":"${"A".repeat(43)}","challenge":"${"C".repeat(43)}","state":"${"B".repeat(43)}","callbackUri":"${CALLBACK_URI}","deviceLabel":"x"}`)).status).toBe(400);
    expect((await post(JSON.stringify({ ...valid, extra: 1 }))).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    for (const callbackUri of ["http://localhost:4555/api/relay/link/callback", "http://127.0.0.1:4555/other", "https://127.0.0.1:4555/api/relay/link/callback", "http://[::1]:4555/api/relay/link/callback"]) {
      expect((await post(JSON.stringify({ ...valid, callbackUri }))).status).toBe(400);
    }
    expect((await post(JSON.stringify(valid))).status).toBe(201);
  });

  it("limits request starts for each source and reads X-Forwarded-For only from a trusted proxy", async () => {
    const h = await harness();
    const body = JSON.stringify({ challenge: "A".repeat(43), state: "B".repeat(43), callbackUri: CALLBACK_URI, deviceLabel: "x" });
    const start = (peer: string, forwarded?: string) =>
      h.request("/api/auth/gateway-link/requests", { method: "POST", headers: { ...JSON_HEADERS, ...(forwarded ? { "x-forwarded-for": forwarded } : {}) }, body }, peer).then((response) => response.status);
    // An outside peer cannot choose its bucket with a header.
    const outside = [];
    for (let index = 0; index < 6; index++) outside.push(await start("203.0.113.9", `192.0.2.${index}`));
    expect(outside).toEqual([201, 201, 201, 201, 201, 429]);
    // A trusted proxy names the client with the last entry. A spoofed first entry changes nothing.
    const proxied = [];
    for (let index = 0; index < 6; index++) proxied.push(await start("127.0.0.1", `10.9.9.${index}, 192.0.2.50`));
    expect(proxied).toEqual([201, 201, 201, 201, 201, 429]);
    expect(await start("127.0.0.1", "192.0.2.51")).toBe(201);
  });
});

describe("gateway link routes: revocation and re-link", () => {
  it("lets an owner revoke with a cookie and Origin, and not another account", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const bob = await h.signUp("bob");
    const device = await h.linkDevice(alice);
    const revoke = (account: Account, headers: Record<string, string> = {}, linkId = device.linkId) =>
      h.request("/api/auth/gateway-link/revoke", { method: "POST", headers: { ...JSON_HEADERS, cookie: account.cookie, origin: REMOTE_ORIGIN, ...headers }, body: JSON.stringify({ linkId }) });
    expect((await revoke(bob)).status).toBe(404);
    expect((await me(h, device.key)).status).toBe(200);
    expect((await revoke(alice, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await me(h, device.key)).status).toBe(200);
    const done = await revoke(alice);
    expect(done.status).toBe(200);
    expect(await json(done)).toMatchObject({ id: device.linkId, status: "revoked" });
    expect((await me(h, device.key)).status).toBe(401);
    const listed = (await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links as Array<{ status: string }>;
    expect(listed.map((link) => link.status)).toEqual(["revoked"]);
    expect((await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: bob.cookie } }))).links).toEqual([]);
  });

  it("lets a link revoke itself with its own bearer and refuses a cookie, an Origin, or another link ID next to it", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const first = await h.linkDevice(alice, { deviceLabel: "First" });
    const second = await h.linkDevice(alice, { deviceLabel: "Second" });
    const revoke = (key: string, headers: Record<string, string>, body: unknown = {}) =>
      h.request("/api/auth/gateway-link/revoke", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });
    expect((await revoke(first.key, { cookie: alice.cookie })).status).toBe(403);
    expect((await revoke(first.key, { origin: REMOTE_ORIGIN })).status).toBe(403);
    // The caller names another link of the same owner. That grants nothing.
    expect((await revoke(first.key, {}, { linkId: second.linkId })).status).toBe(403);
    expect((await me(h, second.key)).status).toBe(200);
    expect((await me(h, first.key)).status).toBe(200);
    expect((await revoke("not-a-key", {})).status).toBe(401);
    const done = await revoke(first.key, {}, { linkId: first.linkId });
    expect(done.status).toBe(200);
    expect((await me(h, first.key)).status).toBe(401);
    expect((await me(h, second.key)).status).toBe(200);
  });

  it("re-links the same link: the old key stops, the new key works, and a replaced link of another account is refused", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const bob = await h.signUp("bob");
    const first = await h.linkDevice(alice);
    const second = await h.linkDevice(alice, { replaceLinkId: first.linkId, deviceLabel: "Renamed" });
    expect(second.linkId).toBe(first.linkId);
    expect((await me(h, first.key)).status).toBe(401);
    expect((await me(h, second.key)).status).toBe(200);
    // Bob names alice's link. The view shows a conflict and approval fails.
    const start = await startRequest(h, { replaceLinkId: first.linkId });
    const consent = await consentGet(h, bob, start.requestId);
    expect(consent).toMatchObject({ replaces: null, replaceConflict: true });
    expect((await consentPost(h, bob, "approve", start.requestId, consent.nonce)).status).toBe(409);
    expect((await me(h, second.key)).status).toBe(200);
  });

  it("stops a managed key when its user becomes banned and when the link expires", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const device = await h.linkDevice(alice);
    expect((await me(h, device.key)).status).toBe(200);
    h.db.prepare("UPDATE user SET banned = 1 WHERE id = ?").run(alice.id);
    expect((await me(h, device.key)).status).toBe(401);
    h.db.prepare("UPDATE user SET banned = 0 WHERE id = ?").run(alice.id);
    expect((await me(h, device.key)).status).toBe(200);
    h.db.prepare("UPDATE gateway_links SET expiresAt = ? WHERE id = ?").run(h.clock.now - 1, device.linkId);
    expect((await me(h, device.key)).status).toBe(401);
  });
});

describe("gateway link routes: managed keys and the generic key routes", () => {
  const keyCall = (h: Harness, account: Account, action: string, body: unknown) =>
    h.request(`/api/auth/api-key/${action}`, { method: "POST", headers: { ...JSON_HEADERS, cookie: account.cookie, origin: REMOTE_ORIGIN }, body: JSON.stringify(body) });

  it("refuses generic creation with the reserved prefix and keeps ordinary creation", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    for (const prefix of ["gl_forged", "GL_forged", "gl_"]) {
      const response = await keyCall(h, alice, "create", { name: "forged", prefix });
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ error: "reserved_prefix" });
    }
    expect((await keyCall(h, alice, "create", { name: "plain" })).status).toBe(200);
    expect((await keyCall(h, alice, "create", { name: "plain", prefix: "ci" })).status).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE prefix LIKE 'gl\\_%' ESCAPE '\\'").get()).toEqual({ count: 0 });
  });

  it("refuses a generic update of a managed key, so no update revives a retired key", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const first = await h.linkDevice(alice);
    const second = await h.linkDevice(alice, { replaceLinkId: first.linkId });
    expect((await me(h, first.key)).status).toBe(401);
    const revive = await keyCall(h, alice, "update", { keyId: first.keyId, enabled: true });
    expect(revive.status).toBe(403);
    expect(await json(revive)).toEqual({ error: "managed_key" });
    expect((await keyCall(h, alice, "update", { keyId: second.keyId, expiresIn: 86_400 })).status).toBe(403);
    // The trailing-slash spelling gets the same answer or none at all, and it never changes the key.
    const slash = await h.request("/api/auth/api-key/update/", { method: "POST", headers: { ...JSON_HEADERS, cookie: alice.cookie, origin: REMOTE_ORIGIN }, body: JSON.stringify({ keyId: first.keyId, enabled: true }) });
    expect(slash.status).not.toBe(200);
    expect(h.db.prepare("SELECT enabled FROM apikey WHERE id = ?").get(first.keyId)).toEqual({ enabled: 0 });
    expect((await me(h, first.key)).status).toBe(401);
    // An update of an ordinary key still works.
    const plain = (await json(await keyCall(h, alice, "create", { name: "plain" }))) as { id: string };
    expect((await keyCall(h, alice, "update", { keyId: plain.id, name: "renamed" })).status).toBe(200);
  });

  it("detects deletion through the key plugin endpoint and through the token route", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const viaPlugin = await h.linkDevice(alice, { deviceLabel: "Plugin" });
    const viaToken = await h.linkDevice(alice, { deviceLabel: "Token" });
    expect((await keyCall(h, alice, "delete", { keyId: viaPlugin.keyId })).status).toBe(200);
    const deleted = await h.request(`/api/user/token/${viaToken.keyId}`, { method: "DELETE", headers: { cookie: alice.cookie } });
    expect(deleted.status).toBe(200);
    expect((await me(h, viaPlugin.key)).status).toBe(401);
    expect((await me(h, viaToken.key)).status).toBe(401);
    const listed = (await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links as Array<{ status: string }>;
    expect(listed.map((link) => link.status)).toEqual(["revoked", "revoked"]);
    // A missing key is not an opening to issue another one without consent: the exchange has no code to use.
    expect((await exchange(h, { code: "none", verifier: "v".repeat(43) })).status).toBe(400);
  });

  describe("a replacement that the owner approved before the old link ended", () => {
    const approveReplacement = async (h: Harness, account: Account, replaceLinkId: string) => {
      const start = await startRequest(h, { replaceLinkId });
      const consent = await consentGet(h, account, start.requestId);
      const approved = await consentPost(h, account, "approve", start.requestId, consent.nonce);
      expect(approved.status).toBe(200);
      const code = readRedirect(((await approved.json()) as { redirectUrl: string }).redirectUrl).code!;
      return { code, verifier: start.pkce.verifier };
    };
    const ends: Array<[string, (h: Harness, account: Account, device: { linkId: string; keyId: string; key: string }) => Promise<unknown>]> = [
      ["the owner revokes the link", (h, account, device) =>
        h.request("/api/auth/gateway-link/revoke", { method: "POST", headers: { ...JSON_HEADERS, cookie: account.cookie, origin: REMOTE_ORIGIN }, body: JSON.stringify({ linkId: device.linkId }) })],
      ["the link revokes itself with its key", (h, _account, device) =>
        h.request("/api/auth/gateway-link/revoke", { method: "POST", headers: { ...JSON_HEADERS, authorization: `Bearer ${device.key}` }, body: "{}" })],
      ["the key is deleted through the key plugin", (h, account, device) => keyCall(h, account, "delete", { keyId: device.keyId })],
      ["the key is deleted through the token route", (h, account, device) =>
        h.request(`/api/user/token/${device.keyId}`, { method: "DELETE", headers: { cookie: account.cookie } })],
    ];

    it.each(ends)("issues no key when %s before the exchange", async (_name, end) => {
      const h = await harness();
      const alice = await h.signUp("alice");
      const device = await h.linkDevice(alice);
      const grant = await approveReplacement(h, alice, device.linkId);
      expect(((await end(h, alice, device)) as Response).status).toBe(200);
      const response = await exchange(h, grant);
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({ error: "link_conflict" });
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE enabled = 1").get()).toEqual({ count: 0 });
      expect(((await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links as Array<{ status: string }>).map((link) => link.status)).toEqual(["revoked"]);
      expect((await me(h, device.key)).status).toBe(401);
    });

    describe("while the replacement key is being issued", () => {
      const deletions: Array<[string, (h: Harness, account: Account, keyId: string) => Promise<Response>]> = [
        ["the key plugin", (h, account, keyId) => keyCall(h, account, "delete", { keyId })],
        ["the token route", (h, account, keyId) => h.request(`/api/user/token/${keyId}`, { method: "DELETE", headers: { cookie: account.cookie } })],
      ];

      it.each(deletions)("revokes the link when the old key is deleted through %s", async (_name, remove) => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered: () => void = () => undefined;
        const started = new Promise<void>((resolve) => (entered = resolve));
        let delaying = false;
        const ref: { h?: Harness } = {};
        const h = await harness({
          auth: {
            createApiKey: async (args) => {
              if (delaying) {
                entered();
                await gate;
              }
              return ref.h!.auth.api.createApiKey(args);
            },
          },
        });
        ref.h = h;
        const alice = await h.signUp("alice");
        const device = await h.linkDevice(alice);
        const grant = await approveReplacement(h, alice, device.linkId);
        delaying = true;
        const pending = exchange(h, grant);
        await started;
        expect((await remove(h, alice, device.keyId)).status).toBe(200);
        release();
        const response = await pending;
        expect(response.status).toBe(409);
        expect(await json(response)).toEqual({ error: "link_conflict" });
        expect(h.db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE enabled = 1").get()).toEqual({ count: 0 });
        expect(((await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links as Array<{ status: string }>).map((link) => link.status)).toEqual(["revoked"]);
        expect((await me(h, device.key)).status).toBe(401);
      });
    });

    it("revokes the replacement when it activates between the key deletion and the end of the plugin call", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (entered = resolve));
      let delaying = false;
      const ref: { h?: Harness } = {};
      const h = await harness({
        auth: {
          createApiKey: async (args) => {
            const created = await ref.h!.auth.api.createApiKey(args);
            if (delaying) {
              entered();
              await gate;
            }
            return created;
          },
        },
      });
      ref.h = h;
      const alice = await h.signUp("alice");
      const device = await h.linkDevice(alice);
      const grant = await approveReplacement(h, alice, device.linkId);
      delaying = true;
      const pending = exchange(h, grant);
      await started;
      // The candidate exists. The exchange resumes as soon as the plugin's own SQLite delete of the old key returns.
      const prepare = h.db.prepare.bind(h.db);
      h.db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!/^\s*delete\s+from\s+["`]?apikey/i.test(sql)) return statement;
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => {
          const result = run(...args);
          release();
          return result;
        }) as typeof statement.run;
        return statement;
      }) as typeof h.db.prepare;
      expect((await keyCall(h, alice, "delete", { keyId: device.keyId })).status).toBe(200);
      const response = await pending;
      const replacement = response.status === 200 ? ((await json(response)) as { key: string }).key : null;
      if (replacement) expect((await me(h, replacement)).status).toBe(401);
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE enabled = 1").get()).toEqual({ count: 0 });
      expect(((await json(await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } }))).links as Array<{ status: string }>).map((link) => link.status)).toEqual(["revoked"]);
    });

    it("lets the owner approve a new replacement after the link ended", async () => {
      const h = await harness();
      const alice = await h.signUp("alice");
      const device = await h.linkDevice(alice);
      expect((await keyCall(h, alice, "delete", { keyId: device.keyId })).status).toBe(200);
      const grant = await approveReplacement(h, alice, device.linkId);
      const response = await exchange(h, grant);
      expect(response.status).toBe(200);
      expect((await me(h, ((await json(response)) as { key: string }).key)).status).toBe(200);
    });
  });

  it("fails closed for a reserved-prefix key that no link names", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const stray = (await h.auth.api.createApiKey({ body: { userId: alice.id, name: "stray", prefix: "gl_straykeyprefix" } })) as { key: string };
    expect((await me(h, stray.key)).status).toBe(401);
    const plain = (await h.auth.api.createApiKey({ body: { userId: alice.id, name: "plain" } })) as { key: string };
    expect((await me(h, plain.key)).status).toBe(200);
  });
});

describe("gateway link routes: readiness", () => {
  it("answers 503 and accepts no managed key until recovery finished", async () => {
    const h = await harness();
    const alice = await h.signUp("alice");
    const device = await h.linkDevice(alice);
    const cold = createGatewayLinkService({ db: h.db, auth: h.auth.api, secret: SESSION_SECRET, getAllowedOrigins: () => [REMOTE_ORIGIN], now: () => h.clock.now });
    setMultiUserRuntime({ auth: h.auth, db: h.db, gatewayLinks: cold, assignments: { getAssignmentsForUser: () => [] }, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as unknown as MultiUserRuntime);
    expect(cold.isReady()).toBe(false);
    expect((await me(h, device.key)).status).toBe(401);
    const response = await h.request("/api/auth/gateway-link/requests", { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(response.status).toBe(503);
    cold.recover();
    expect((await me(h, device.key)).status).toBe(200);
    expect((await h.request("/api/auth/gateway-link/links", { headers: { cookie: alice.cookie } })).status).toBe(200);
  });
});
