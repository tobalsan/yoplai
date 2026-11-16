import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

/**
 * Slack pairing management through the real gateway server, the real multi-user middleware, a real Better Auth, and the
 * inner API dispatch, all over real Node sockets. Test accounts, API keys, and pairing records are synthetic. No Slack
 * call is made: the pairing service gets a stand-in Slack client. One module graph serves three sockets. A per-request
 * store says whether a request reaches a multi-user gateway, a single-user gateway, or the local relay gateway.
 */

type Mode = { multiUser: boolean };
const modes = vi.hoisted(() => ({ store: undefined as unknown as AsyncLocalStorage<{ multiUser: boolean }> }));
modes.store = new AsyncLocalStorage();

vi.mock("@yoplai/extension-multi-user", async (original) => {
  const actual = await original<typeof import("@yoplai/extension-multi-user")>();
  return { ...actual, getMultiUserRuntime: () => (modes.store.getStore()?.multiUser ? actual.getMultiUserRuntime() : null) };
});

type Seen = { method: string; url: string; authorization?: string; cookie?: string; origin?: string };
type Account = { id: string; email: string; cookie: string; sessionId: string };

const BASE_PORT = 4999;
const trustedOrigin = "http://127.0.0.1:3000";
let home: string;
let previousHome: string | undefined;
let remoteBase: string;
let singleBase: string;
let localBase: string;
const remoteSeen: Seen[] = [];
const closers: Array<() => Promise<void>> = [];
let auth: import("../../../../packages/extensions/multi-user/src/auth.js").MultiUserAuth;
let db: import("better-sqlite3").Database;
let service: import("../../../../packages/extensions/slack/src/pairing.js").SlackPairingService;
let startImpersonation: typeof import("../../../../packages/extensions/multi-user/src/impersonation.js").startImpersonation;
const accounts: Record<string, Account & { key: string; keyId: string }> = {};

const listen = (target: http.Server) => new Promise<number>((resolve) => target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port)));

async function signUp(name: string): Promise<Account> {
  const email = `${name}@example.test`;
  const response = await auth.handler(new Request(`http://127.0.0.1:${BASE_PORT}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${BASE_PORT}` },
    body: JSON.stringify({ email, name, password: "synthetic-password-for-isolated-test" }),
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) });
  return { id: session!.user.id, email, cookie, sessionId: session!.session.id };
}

async function pair(account: Account, slackUserId: string): Promise<void> {
  const url = await service.issue("T1", slackUserId, { users: { info: async () => ({ ok: true, user: { id: slackUserId, name: "synthetic", profile: { email: account.email } } }) } } as never);
  await service.redeem(new URL(url).pathname.split("/").at(-1)!, { id: account.id, email: account.email });
}

function serveWithMode(multiUser: boolean, app: { fetch: (request: Request, env?: unknown) => Response | Promise<Response> }, record?: Seen[]): Promise<{ server: http.Server; base: string }> {
  return (async () => {
    const { serve } = await import("@hono/node-server");
    const server = serve({
      fetch: (request: Request, env: unknown) => {
        if (record) record.push({ method: request.method, url: new URL(request.url).pathname, authorization: request.headers.get("authorization") ?? undefined, cookie: request.headers.get("cookie") ?? undefined, origin: request.headers.get("origin") ?? undefined });
        return modes.store.run({ multiUser } satisfies Mode, () => app.fetch(request, env));
      },
      port: 0, hostname: "127.0.0.1",
    }) as http.Server;
    if (!server.listening) await listen(server).catch(() => undefined);
    closers.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  })();
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-pairing-relay-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  const secret = "synthetic-session-secret-with-32-chars!";
  await writeTestV3Config(home, { agents: [], extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: secret } } });
  vi.resetModules();
  vi.doMock("../extensions/registry.js", async () => {
    const actual = await vi.importActual<typeof import("../extensions/registry.js")>("../extensions/registry.js");
    const enabled = (id: string) => id === "multiUser" && modes.store.getStore()?.multiUser === true;
    return { ...actual, getLoadedExtensions: () => (modes.store.getStore()?.multiUser ? [{ id: "multiUser" }] : []), isMultiUserLoaded: () => modes.store.getStore()?.multiUser === true, isExtensionLoaded: enabled, getExtensionRuntime: () => ({ isEnabled: enabled, getRouteMatchers: () => [] }) };
  });
  const { GatewayConfigSchema } = await import("@yoplai/shared");
  const { createMultiUserAuth } = await import("../../../../packages/extensions/multi-user/src/auth.js");
  const { initializeMultiUserDatabase } = await import("../../../../packages/extensions/multi-user/src/db.js");
  const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
  ({ startImpersonation } = await import("../../../../packages/extensions/multi-user/src/impersonation.js"));
  db = initializeMultiUserDatabase(home);
  const config = GatewayConfigSchema.parse({ version: 2, agents: [], gateway: { port: BASE_PORT }, extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: secret } } });
  const multiUser = config.extensions?.multiUser;
  if (!multiUser?.enabled) throw new Error("Expected multi-user fixture");
  auth = await createMultiUserAuth(config, multiUser, db);
  setMultiUserRuntime({ auth, db } as never);
  closers.push(async () => { setMultiUserRuntime(null); db.close(); });

  const { SlackPairingService, setSlackPairingService } = await import("../../../../packages/extensions/slack/src/pairing.js");
  const { registerSlackPairingRoutes } = await import("../../../../packages/extensions/slack/src/pairing-routes.js");
  service = new SlackPairingService(path.join(home, "slack"), "https://yoplai.test");
  setSlackPairingService(service);
  closers.push(async () => { setSlackPairingService(undefined); service.close(); });
  const { clearConfigCacheForTests } = await import("../config/index.js");
  clearConfigCacheForTests();
  const { api } = await import("./api.core.js");
  registerSlackPairingRoutes(api);

  // The first account is the bootstrap superadmin. The others are ordinary approved users.
  const created: Record<string, Account> = {};
  for (const name of ["root", "alice", "bob", "carol", "dave"]) created[name] = await signUp(name);
  db.prepare("UPDATE user SET approved = 1").run();
  db.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(created.root.id);
  for (const [name, account] of Object.entries(created)) {
    const key = (await auth.api.createApiKey({ body: { userId: account.id, name: `synthetic-${name}` } })) as { key: string; id: string };
    accounts[name] = { ...account, key: key.key, keyId: key.id };
  }

  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  const { app } = await import("./index.js");
  remoteBase = (await serveWithMode(true, app, remoteSeen)).base;
  singleBase = (await serveWithMode(false, app)).base;
  localBase = (await serveWithMode(false, app)).base;
  const links = state.getRemoteGatewayStore();
  links.save({ name: "east", url: remoteBase, token: accounts.alice.key });
  links.save({ name: "bob", url: remoteBase, token: accounts.bob.key });
  links.save({ name: "forged", url: remoteBase, token: `${accounts.alice.key}x` });
  links.save({ name: "single", url: singleBase, token: accounts.alice.key });
  closers.push(async () => { for (const name of ["east", "bob", "forged", "single"]) links.remove(name); state.configureRelay("127.0.0.1", true); });
});

afterAll(async () => {
  for (const closer of closers.reverse()) await closer();
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  remoteSeen.length = 0;
  for (const name of ["alice", "bob", "carol", "dave", "root"]) for (const p of service.list(accounts[name].id)) service.unpair(accounts[name].id, p.workspaceId, p.slackUserId);
  db.prepare("UPDATE user SET banned = 0, approved = 1").run();
  db.prepare("UPDATE user SET role = 'user' WHERE id != ?").run(accounts.root.id);
  await pair(accounts.alice, "UALICE");
});

const call = (base: string, method: string, pathname: string, headers: Record<string, string> = {}) => fetch(`${base}${pathname}`, { method, headers });
const bearer = (name: string) => ({ authorization: `Bearer ${accounts[name].key}` });
const json = async (response: Response) => response.json() as Promise<Record<string, unknown>>;
const owned = (name: string) => service.list(accounts[name].id).map((entry) => `${entry.workspaceId}:${entry.slackUserId}`);

describe("the remote: outer Better Auth and inner dispatch", () => {
  it("lists and deletes with a verified bearer and no cookie and no Origin, for the owner only", async () => {
    const list = await call(remoteBase, "GET", "/api/slack/pairings", bearer("alice"));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await json(list)).toEqual({ pairings: [{ workspaceId: "T1", slackUserId: "UALICE", pairedAt: expect.any(Number) }] });
    expect(await json(await call(remoteBase, "GET", "/api/slack/pairings", bearer("bob")))).toEqual({ pairings: [] });
    // Owner isolation: another account cannot unpair a record that it does not own.
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", bearer("bob"))).status).toBe(200);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", bearer("alice"))).status).toBe(200);
    expect(owned("alice")).toEqual([]);
  });

  it("refuses an invalid, forged, truncated, and revoked bearer, also next to a valid cookie", async () => {
    const forged = [`${accounts.alice.key}x`, accounts.alice.key.slice(0, -3), "not-a-real-key", accounts.bob.key.replace(/.$/, "0")];
    for (const token of forged) {
      const headers = { authorization: `Bearer ${token}`, cookie: accounts.alice.cookie };
      expect([401, 403]).toContain((await call(remoteBase, "GET", "/api/slack/pairings", headers)).status);
      expect([401, 403]).toContain((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { ...headers, origin: remoteBase })).status);
    }
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    // A revoked key stops working.
    const extra = (await auth.api.createApiKey({ body: { userId: accounts.alice.id, name: "synthetic-revoked" } })) as { key: string; id: string };
    expect((await call(remoteBase, "GET", "/api/slack/pairings", { authorization: `Bearer ${extra.key}` })).status).toBe(200);
    await auth.api.deleteApiKey({ headers: new Headers({ cookie: accounts.alice.cookie }), body: { keyId: extra.id } });
    expect((await call(remoteBase, "GET", "/api/slack/pairings", { authorization: `Bearer ${extra.key}`, cookie: accounts.alice.cookie })).status).toBe(401);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
  });

  it("sets no authority from a caller header, a session string, or a forged context", async () => {
    const claim = Buffer.from(JSON.stringify({ user: { id: accounts.alice.id, role: "superadmin" }, session: { id: `apikey:${accounts.alice.keyId}`, userId: accounts.alice.id } })).toString("base64url");
    const headers = { "x-yoplai-auth-context": claim, "x-aihub-auth-context": claim, "x-multi-user-bearer-verified": "true", multiUserBearerVerified: "true" };
    expect((await call(remoteBase, "GET", "/api/slack/pairings", headers)).status).toBe(401);
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", headers)).status).toBe(401);
    // A real cookie of another account with the forged claim still acts as that cookie account.
    expect(await json(await call(remoteBase, "GET", "/api/slack/pairings", { ...headers, cookie: accounts.bob.cookie }))).toEqual({ pairings: [] });
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { ...headers, cookie: accounts.alice.cookie }))).toMatchObject({ status: 403 });
    expect(owned("alice")).toEqual(["T1:UALICE"]);
  });

  it("keeps the cookie branch and its Origin check", async () => {
    expect((await call(remoteBase, "GET", "/api/slack/pairings", { cookie: accounts.alice.cookie })).status).toBe(200);
    const noOrigin = await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { cookie: accounts.alice.cookie });
    expect(noOrigin.status).toBe(403);
    expect((await json(noOrigin)).error).toBe("invalid_origin");
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { cookie: accounts.alice.cookie, origin: "https://evil.test" })).status).toBe(403);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    expect((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { cookie: accounts.alice.cookie, origin: remoteBase })).status).toBe(200);
    expect(owned("alice")).toEqual([]);
    expect((await call(remoteBase, "GET", "/api/slack/pairings")).status).toBe(401);
  });

  it("checks fresh eligibility for a bearer owner and a cookie owner", async () => {
    db.prepare("UPDATE user SET banned = 1 WHERE id = ?").run(accounts.alice.id);
    expect([401, 403]).toContain((await call(remoteBase, "GET", "/api/slack/pairings", bearer("alice"))).status);
    expect([401, 403]).toContain((await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", bearer("alice"))).status);
    expect([401, 403]).toContain((await call(remoteBase, "GET", "/api/slack/pairings", { cookie: accounts.alice.cookie })).status);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    db.prepare("UPDATE user SET banned = 0, approved = 0, role = 'user' WHERE id = ?").run(accounts.alice.id);
    expect((await call(remoteBase, "GET", "/api/slack/pairings", bearer("alice"))).status).toBe(403);
    db.prepare("UPDATE user SET approved = 1 WHERE id = ?").run(accounts.alice.id);
    expect((await call(remoteBase, "GET", "/api/slack/pairings", bearer("alice"))).status).toBe(200);
  });

  it("keeps the impersonation write guard and the cookie identity during impersonation", async () => {
    await pair(accounts.root, "UROOT");
    startImpersonation(accounts.root.sessionId, accounts.alice.id);
    try {
      // A write during impersonation is refused before the handler. The list still belongs to the cookie account.
      const refused = await call(remoteBase, "DELETE", "/api/slack/pairings/T1/UALICE", { cookie: accounts.root.cookie, origin: remoteBase });
      expect(refused.status).toBe(403);
      expect((await json(refused)).error).toBe("read_only_impersonation");
      expect(owned("alice")).toEqual(["T1:UALICE"]);
      expect(owned("root")).toEqual(["T1:UROOT"]);
      const list = await json(await call(remoteBase, "GET", "/api/slack/pairings", { cookie: accounts.root.cookie }));
      expect(list).toEqual({ pairings: [{ workspaceId: "T1", slackUserId: "UROOT", pairedAt: expect.any(Number) }] });
    } finally {
      (await import("../../../../packages/extensions/multi-user/src/impersonation.js")).endImpersonation(accounts.root.sessionId);
    }
  });

  it("keeps the redemption page and its identity rules unchanged", async () => {
    const url = await service.issue("T1", "UNEW", { users: { info: async () => ({ ok: true, user: { id: "UNEW", name: "synthetic", profile: { email: accounts.bob.email } } }) } } as never);
    const token = new URL(url).pathname.split("/").at(-1)!;
    // The page is public for GET and shows a sign-in link. A bearer alone does not redeem.
    const page = await call(remoteBase, "GET", `/api/slack/pair/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in");
    expect((await call(remoteBase, "POST", `/api/slack/pair/${token}`, bearer("bob"))).status).toBe(401);
    expect(owned("bob")).toEqual([]);
  });
});

describe("through the local relay gateway", () => {
  const prefix = (name: string) => `/api/relay/gateways/${name}`;

  it("lists and unpairs with the linked bearer, and sends no cookie and no Origin to the remote", async () => {
    const list = await call(localBase, "GET", `${prefix("east")}/api/slack/pairings`, { origin: trustedOrigin, cookie: "local=cookie", authorization: "Bearer caller-secret" });
    expect(list.status).toBe(200);
    expect(await json(list)).toEqual({ pairings: [{ workspaceId: "T1", slackUserId: "UALICE", pairedAt: expect.any(Number) }] });
    const removed = await call(localBase, "DELETE", `${prefix("east")}/api/slack/pairings/T1/UALICE`, { origin: trustedOrigin, cookie: "local=cookie" });
    expect(removed.status).toBe(200);
    expect(owned("alice")).toEqual([]);
    const toRemote = remoteSeen.filter((seen) => seen.url.startsWith("/api/slack/pairings"));
    expect(toRemote.map((seen) => `${seen.method} ${seen.url}`)).toEqual(["GET /api/slack/pairings", "DELETE /api/slack/pairings/T1/UALICE"]);
    for (const seen of toRemote) {
      expect(seen.authorization).toBe(`Bearer ${accounts.alice.key}`);
      expect(seen.cookie).toBeUndefined();
      expect(seen.origin).toBeUndefined();
    }
  });

  it("isolates owners by the linked bearer, and shows a remote refusal for a forged link", async () => {
    expect(await json(await call(localBase, "GET", `${prefix("bob")}/api/slack/pairings`, { origin: trustedOrigin }))).toEqual({ pairings: [] });
    expect((await call(localBase, "DELETE", `${prefix("bob")}/api/slack/pairings/T1/UALICE`, { origin: trustedOrigin })).status).toBe(200);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    const forged = await call(localBase, "GET", `${prefix("forged")}/api/slack/pairings`, { origin: trustedOrigin });
    expect([401, 403]).toContain(forged.status);
  });

  it("refuses a remote that has no multi-user identity, with an explicit error", async () => {
    const response = await call(localBase, "GET", `${prefix("single")}/api/slack/pairings`, { origin: trustedOrigin });
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ error: "multi_user_required" });
    expect((await call(localBase, "DELETE", `${prefix("single")}/api/slack/pairings/T1/UALICE`, { origin: trustedOrigin })).status).toBe(409);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
  });

  it("allows only the two exact pairing routes, and no redemption or connection route", async () => {
    const blocked: Array<[string, string]> = [
      ["POST", "/api/slack/pairings"], ["PUT", "/api/slack/pairings"], ["DELETE", "/api/slack/pairings"], ["GET", "/api/slack/pairings/T1/UALICE"],
      ["POST", "/api/slack/pairings/T1/UALICE"], ["DELETE", "/api/slack/pairings/T1"], ["DELETE", "/api/slack/pairings/T1/UALICE/extra"],
      ["GET", `/api/slack/pair/${"a".repeat(43)}`], ["POST", `/api/slack/pair/${"a".repeat(43)}`], ["GET", `/api/slack/connect/${"a".repeat(43)}`], ["POST", `/api/slack/connect/${"a".repeat(43)}`],
      ["GET", "/api/slack/pairings/"],
    ];
    for (const [method, url] of blocked) {
      const response = await call(localBase, method, `${prefix("east")}${url}`, { origin: trustedOrigin });
      expect({ method, url, ok: [400, 404, 405].includes(response.status) }).toEqual({ method, url, ok: true });
    }
    expect(remoteSeen.filter((seen) => seen.url.startsWith("/api/slack"))).toEqual([]);
    // A body on the bodyless delete is refused before the remote sees it.
    const withBody = await fetch(`${localBase}${prefix("east")}/api/slack/pairings/T1/UALICE`, { method: "DELETE", headers: { origin: trustedOrigin, "content-type": "application/json" }, body: "{}" });
    expect(withBody.status).toBe(400);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
  });

  it("keeps opaque identifiers unchanged and refuses an identifier with an encoded separator", async () => {
    await pair(accounts.alice, "U:odd@id");
    const odd = encodeURIComponent("U:odd@id");
    expect((await call(localBase, "DELETE", `${prefix("east")}/api/slack/pairings/T1/${odd}`, { origin: trustedOrigin })).status).toBe(200);
    expect(owned("alice")).toEqual(["T1:UALICE"]);
    expect((await call(localBase, "DELETE", `${prefix("east")}/api/slack/pairings/T1/${encodeURIComponent("a/b")}`, { origin: trustedOrigin })).status).toBe(400);
  });

  it("refuses an untrusted browser Origin for the relay request", async () => {
    const response = await call(localBase, "GET", `${prefix("east")}/api/slack/pairings`, { origin: "https://evil.test" });
    expect(response.status).toBe(403);
    expect(remoteSeen.filter((seen) => seen.url.startsWith("/api/slack"))).toEqual([]);
  });
});

describe("a local multi-user gateway keeps its relay off", () => {
  it("answers the relay route with an explicit refusal and makes no remote call", async () => {
    // The multi-user mode answers for this socket. The relay mount stays off, so no relay request goes out.
    const { server, base } = await (async () => {
      const { app } = await import("./index.js");
      return serveWithMode(true, app);
    })();
    try {
      const response = await call(base, "GET", "/api/relay/gateways/east/api/slack/pairings", { origin: trustedOrigin, ...bearer("alice") });
      expect(response.status).toBe(404);
      expect(remoteSeen.filter((seen) => seen.url.startsWith("/api/slack"))).toEqual([]);
    } finally {
      server.closeAllConnections();
    }
  });
});
