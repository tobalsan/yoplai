import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackPairingService, setSlackPairingService } from "./pairing.js";
import { registerSlackPairingRoutes } from "./pairing-routes.js";
import { clearSlackContext, setSlackContext } from "./context.js";

const state = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock("@yoplai/extension-multi-user", async () => ({ ...(await vi.importActual<object>("../../multi-user/src/users.js")), ...(await vi.importActual<object>("../../multi-user/src/middleware.js")), getMultiUserRuntime: () => state.runtime }));

describe("Slack pairing web routes", () => {
  let dataDir: string;
  let service: SlackPairingService;
  let db: Database.Database;
  let app: Hono;
  let url: string;
  const getSession = vi.fn();
  const info = vi.fn();

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-routes-"));
    db = new Database(":memory:");
    db.exec("CREATE TABLE user (id TEXT, email TEXT, approved INTEGER, role TEXT, banned INTEGER); INSERT INTO user VALUES ('existing', 'person@example.com', 1, 'user', 0)");
    getSession.mockReset().mockResolvedValue(null);
    state.runtime = { db, auth: { api: { getSession } } };
    service = new SlackPairingService(dataDir, "https://yoplai.test");
    setSlackPairingService(service);
    info.mockReset().mockResolvedValue({ ok: true, user: { id: "U1", name: "<slack>", profile: { email: "person@example.com" } } });
    url = await service.issue("T1", "U1", { users: { info } });
    app = new Hono();
    const api = new Hono();
    registerSlackPairingRoutes(api);
    app.route("/api", api);
  });

  afterEach(async () => {
    setSlackPairingService(undefined);
    clearSlackContext();
    state.runtime = null;
    service.close();
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("uses the platform theme and defaults the brand to Yoplai", async () => {
    const html = await (await app.request(url)).text();
    expect(html).toContain("<title>Connect Slack to Yoplai</title>");
    expect(html).toContain('href="/api/theme.css"');
    expect(html).not.toContain("/api/branding/logo");
  });

  it("lists only caller pairings and unpairs before the next sender resolution", async () => {
    await service.redeem(new URL(url).pathname.split("/").at(-1)!, { id: "existing", email: "person@example.com" });
    getSession.mockResolvedValue({ user: { id: "other" } });
    db.prepare("INSERT INTO user VALUES ('other', 'other@example.com', 1, 'user', 0)").run();
    expect(await (await app.request("https://yoplai.test/api/slack/pairings")).json()).toEqual({ pairings: [] });
    const request = { method: "DELETE", headers: { origin: "https://yoplai.test" } };
    expect((await app.request("https://yoplai.test/api/slack/pairings/T1/U1", request)).status).toBe(200);
    expect(service.resolve("T1", "U1")).toBe("existing");
    getSession.mockResolvedValue({ user: { id: "existing" } });
    const response = await app.request("https://yoplai.test/api/slack/pairings");
    expect(await response.json()).toEqual({ pairings: [{ workspaceId: "T1", slackUserId: "U1", pairedAt: expect.any(Number) }] });
    expect((await app.request("https://yoplai.test/api/slack/pairings/T1/U1", request)).status).toBe(200);
    expect(service.resolve("T1", "U1")).toBeUndefined();
  });

  it("requires login, an approved account and same-origin unpair requests", async () => {
    expect((await app.request("https://yoplai.test/api/slack/pairings")).status).toBe(401);
    getSession.mockResolvedValue({ user: { id: "existing" } });
    expect((await app.request("https://yoplai.test/api/slack/pairings/T1/U1", { method: "DELETE", headers: { origin: "https://evil.test" } })).status).toBe(403);
    db.prepare("UPDATE user SET banned = 1").run();
    expect((await app.request("https://yoplai.test/api/slack/pairings")).status).toBe(403);
  });

  it("serves a verified bearer identity from the binding, with no cookie and no Origin, and checks fresh eligibility", async () => {
    await service.redeem(new URL(url).pathname.split("/").at(-1)!, { id: "existing", email: "person@example.com" });
    const bound = new Hono();
    const bind = (c: unknown, key: string, value: unknown) => (c as { set: (key: string, value: unknown) => void }).set(key, value);
    let userId = "existing";
    bound.use("*", async (c, next) => {
      bind(c, "multiUserAuthContext", { user: { id: userId }, session: { id: "apikey:k1", userId } });
      bind(c, "multiUserBearerVerified", true);
      await next();
    });
    registerSlackPairingRoutes(bound);
    expect(await (await bound.request("https://yoplai.test/slack/pairings")).json()).toEqual({ pairings: [{ workspaceId: "T1", slackUserId: "U1", pairedAt: expect.any(Number) }] });
    expect(getSession).not.toHaveBeenCalled();
    // The owner filter holds: another bound owner cannot unpair it.
    db.prepare("INSERT INTO user VALUES ('other', 'other@example.com', 1, 'user', 0)").run();
    userId = "other";
    expect((await bound.request("https://yoplai.test/slack/pairings/T1/U1", { method: "DELETE" })).status).toBe(200);
    expect(service.resolve("T1", "U1")).toBe("existing");
    userId = "existing";
    // A banned owner is refused with a fresh check.
    db.prepare("UPDATE user SET banned = 1 WHERE id = 'existing'").run();
    expect((await bound.request("https://yoplai.test/slack/pairings")).status).toBe(403);
    db.prepare("UPDATE user SET banned = 0 WHERE id = 'existing'").run();
    expect((await bound.request("https://yoplai.test/slack/pairings/T1/U1", { method: "DELETE" })).status).toBe(200);
    expect(service.resolve("T1", "U1")).toBeUndefined();
  });

  it("does not treat a bound identity without the verified marker as a bearer, and keeps the cookie Origin check", async () => {
    const bound = new Hono();
    const bind = (c: unknown, key: string, value: unknown) => (c as { set: (key: string, value: unknown) => void }).set(key, value);
    bound.use("*", async (c, next) => { bind(c, "multiUserAuthContext", { user: { id: "existing" }, session: { id: "apikey:k1", userId: "existing" } }); await next(); });
    registerSlackPairingRoutes(bound);
    // No marker and no cookie session: login is required.
    expect((await bound.request("https://yoplai.test/slack/pairings")).status).toBe(401);
    expect((await bound.request("https://yoplai.test/slack/pairings/T1/U1", { method: "DELETE" })).status).toBe(401);
    getSession.mockResolvedValue({ user: { id: "existing" } });
    expect((await bound.request("https://yoplai.test/slack/pairings/T1/U1", { method: "DELETE" })).status).toBe(403);
  });

  it("answers an explicit error when the gateway has no multi-user identity", async () => {
    state.runtime = null;
    const response = await app.request("https://yoplai.test/api/slack/pairings");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "multi_user_required" });
    expect((await app.request("https://yoplai.test/api/slack/pairings/T1/U1", { method: "DELETE", headers: { origin: "https://yoplai.test" } })).status).toBe(409);
  });

  it("uses configured branding name and logo", async () => {
    setSlackContext({ getConfig: () => ({ branding: { name: "Acme <Hub>", logo: "logo.png" } }) } as never);
    const html = await (await app.request(url)).text();
    expect(html).toContain("<h1>Connect Slack to Acme &lt;Hub&gt;</h1>");
    expect(html).toContain("existing Acme &lt;Hub&gt; account");
    expect(html).toContain('src="/api/branding/logo"');
    expect(html).not.toContain("Yoplai");
  });

  it("renders escaped Slack identity and login returnTo without redeeming", async () => {
    const response = await app.request(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;slack&gt;");
    expect(html).toContain("person@example.com");
    expect(html).toContain("https://yoplai.test/login?returnTo=%2Fapi%2Fslack%2Fpair%2F");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.resolve("T1", "U1")).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM user").get() as { count: number }).count).toBe(1);
  });

  it("requires login and a trusted POST origin", async () => {
    expect((await app.request(url, { method: "POST" })).status).toBe(401);
    getSession.mockResolvedValue({ user: { id: "existing" } });
    expect((await app.request(url, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect(service.resolve("T1", "U1")).toBeUndefined();
  });

  it("connects an existing logged-in account and rejects reuse", async () => {
    getSession.mockResolvedValue({ user: { id: "existing", email: "cached-wrong@example.com" } });
    const init = { method: "POST", headers: { origin: "https://yoplai.test" } };
    const response = await app.request(url, init);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Slack connected");
    expect(service.resolve("T1", "U1")).toBe("existing");
    expect((db.prepare("SELECT COUNT(*) AS count FROM user").get() as { count: number }).count).toBe(1);
    expect((await app.request(url, init)).status).toBe(400);
  });

  it("renders the exact mismatch refusal and leaves mapping absent", async () => {
    getSession.mockResolvedValue({ user: { id: "existing" } });
    info.mockResolvedValue({ ok: true, user: { id: "U1", profile: { email: "different@example.com" } } });
    const response = await app.request(url, { method: "POST", headers: { origin: "https://yoplai.test" } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This link was created for another Slack account");
    expect(service.resolve("T1", "U1")).toBeUndefined();
  });

  it("refuses a session whose existing user is deleted or unapproved", async () => {
    getSession.mockResolvedValue({ user: { id: "missing" } });
    expect((await app.request(url)).status).toBe(403);
    getSession.mockResolvedValue({ user: { id: "existing" } });
    db.prepare("UPDATE user SET approved = 0").run();
    expect((await app.request(url)).status).toBe(403);
  });
});
