import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackPairingService, setSlackPairingService } from "./pairing.js";
import { registerSlackPairingRoutes } from "./pairing-routes.js";

const state = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock("@yoplai/extension-multi-user", () => ({ getMultiUserRuntime: () => state.runtime }));

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
    state.runtime = null;
    service.close();
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("renders escaped Slack identity and login returnTo without redeeming", async () => {
    const response = await app.request(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;slack&gt;");
    expect(html).toContain("person@example.com");
    expect(html).toContain("https://yoplai.test/login?returnTo=%2Fapi%2Fslack%2Fpair%2F");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
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
