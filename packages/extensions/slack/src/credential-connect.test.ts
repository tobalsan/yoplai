import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCredentialOAuthConnector, startExtensionCredentialOAuth } from "@yoplai/shared";
import { clearSlackContext, setSlackContext } from "./context.js";
import { SlackPairingService, setSlackPairingService } from "./pairing.js";
import { trackSlackSender, SLACK_PAIR_LINK_PLACEHOLDER, type ActiveSlackSender } from "./requester.js";
import { clearCredentialConnectRequests, createCredentialConnectLink, inspectCredentialConnect } from "./credential-connect.js";
import { registerCredentialConnectRoutes } from "./credential-connect-routes.js";

const state = vi.hoisted(() => ({ runtime: null as unknown, access: true, impersonating: false }));
vi.mock("@yoplai/extension-multi-user", () => ({
  getMultiUserRuntime: () => state.runtime,
  getRequestAuthContext: async () => ({ user: { id: "owner" } }),
  hasAgentAccess: async () => state.access,
  getForwardedAuthContext: () => null,
  hasActiveImpersonation: () => state.impersonating,
}));

describe("single-pass Slack credential connection", () => {
  let dataDir: string;
  let pairing: SlackPairingService;
  let db: Database.Database;
  let sender: ActiveSlackSender;
  let untrack: () => void;
  let app: Hono;
  const info = vi.fn();
  const start = vi.fn();
  const save = vi.fn();
  const postMessage = vi.fn();
  const session = vi.fn();

  beforeEach(async () => {
    vi.useRealTimers();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-connect-"));
    db = new Database(":memory:");
    db.exec("CREATE TABLE user (id TEXT, email TEXT, approved INTEGER, role TEXT, banned INTEGER); INSERT INTO user VALUES ('owner', 'person@example.com', 1, 'user', 0), ('other', 'other@example.com', 1, 'user', 0)");
    session.mockReset().mockResolvedValue({ user: { id: "owner" }, session: { id: "web-session" } });
    state.runtime = { db, auth: { api: { getSession: session } } };
    state.access = true;
    state.impersonating = false;
    pairing = new SlackPairingService(dataDir, "https://yoplai.test");
    setSlackPairingService(pairing);
    info.mockReset().mockResolvedValue({ ok: true, user: { id: "U1", profile: { email: "person@example.com" } } });
    start.mockReset().mockResolvedValue("https://accounts.google.com/authorize");
    save.mockReset().mockResolvedValue(undefined);
    postMessage.mockReset().mockResolvedValue({ ok: true });
    sender = { agentId: "connie", sessionKey: "thread", sessionId: "session", user: "U1", channel: "C1", threadTs: "123", client: { auth: { test: async () => ({ team_id: "T1" }) }, users: { info }, chat: { postMessage } } as never };
    untrack = trackSlackSender(sender);
    setSlackContext({ getConfig: () => ({}), resolveSessionId: async () => undefined, credentialConnect: { start, save, fields: async () => [{ name: "token", label: "API token", required: true }] } } as never);
    app = new Hono();
    const api = new Hono();
    registerCredentialConnectRoutes(api);
    app.route("/api", api);
  });
  afterEach(async () => {
    vi.useRealTimers();
    untrack();
    clearCredentialConnectRequests();
    clearSlackContext();
    setSlackPairingService(undefined);
    state.runtime = null;
    pairing.close(); db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function link(kind: "oauth" | "token" = "oauth") {
    expect(await createCredentialConnectLink({ agent: { id: "connie" }, sessionId: "session" } as never, kind === "oauth" ? { kind, provider: "google", scopes: ["gmail.send"] } : { kind, extensionId: "probe" })).toBe(SLACK_PAIR_LINK_PLACEHOLDER);
    return sender.pairingLink!;
  }
  const submit = { method: "POST", headers: { origin: "https://yoplai.test" } };
  it("refuses an ambiguous shared-thread caller even after the queued sender exits", async () => {
    const untrackSecond = trackSlackSender({ ...sender, user: "U2" });
    untrackSecond();
    expect(await createCredentialConnectLink({ agent: { id: "connie" }, sessionId: "session" } as never, { kind: "oauth", provider: "google" })).toBeUndefined();
    expect(sender.pairingLink).toBeUndefined();
  });
  it("expires links and cannot start duplicate OAuth authorizations", async () => {
    const url = await link();
    expect((await app.request(url, submit)).status).toBe(302);
    expect((await app.request(url, submit)).status).toBe(409);
    expect(start).toHaveBeenCalledOnce();
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect((await app.request(url)).status).toBe(400);
  });
  it("redirects a signed-out sender directly to sign-in with the original flow return path", async () => {
    const url = await link(); session.mockResolvedValue(null);
    const response = await app.request(url);
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("returnTo")).toBe(new URL(url).pathname);
    expect(pairing.resolve("T1", "U1")).toBeUndefined(); expect(start).not.toHaveBeenCalled();
  });
  it("pairs with the existing ownership check then starts personal OAuth without UI navigation", async () => {
    const url = await link();
    const response = await app.request(url, submit);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://accounts.google.com/authorize");
    expect(pairing.resolve("T1", "U1")).toBe("owner");
    expect(start).toHaveBeenCalledWith({ kind: "oauth", provider: "google", scopes: ["gmail.send"] }, expect.objectContaining({ agentId: "connie", userId: "owner" }));
    await start.mock.calls[0][1].onComplete();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", thread_ts: "123", text: "You're connected, try again" }));
    expect((await app.request(url)).status).toBe(400);
  });
  it("keeps an extension OAuth resource fixed through link, start, and completion", async () => {
    const target = { kind: "extension-oauth" as const, extensionId: "mcp", targetId: "server-a" };
    let complete: (targetId: string) => Promise<void> = async () => {};
    const unregister = registerCredentialOAuthConnector("mcp", async (options) => {
      expect(options).toEqual(expect.objectContaining({ agentId: "connie", userId: "owner", targetId: "server-a" }));
      complete = options.onComplete;
      return "https://provider.test/authorize";
    });
    start.mockImplementation((selected, options) => startExtensionCredentialOAuth(selected.extensionId, selected.targetId, options));
    try {
      expect(await createCredentialConnectLink({ agent: { id: "connie" }, sessionId: "session" } as never, target)).toBe(SLACK_PAIR_LINK_PLACEHOLDER);
      const url = sender.pairingLink!;
      const token = new URL(url).pathname.split("/").pop()!;
      target.targetId = "server-b";
      target.extensionId = "other";
      const response = await app.request(`${url}?targetId=server-b&extensionId=other`, {
        ...submit,
        body: new URLSearchParams({ targetId: "server-b", extensionId: "other" }),
      });
      expect(response.status).toBe(302);
      expect(start).toHaveBeenCalledWith({ kind: "extension-oauth", extensionId: "mcp", targetId: "server-a" }, expect.objectContaining({ agentId: "connie", userId: "owner" }));
      await expect(complete("server-b")).rejects.toThrow("target ID does not match");
      expect(inspectCredentialConnect(token).completed).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
      await complete("server-a");
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", thread_ts: "123", text: "You're connected, try again" }));
      expect(() => inspectCredentialConnect(token)).toThrow("already been used");
    } finally { unregister(); }
  });
  it("rejects extension OAuth links without a resource ID", async () => {
    await expect(createCredentialConnectLink({ agent: { id: "connie" }, sessionId: "session" } as never, { kind: "extension-oauth", extensionId: "mcp", targetId: " " })).rejects.toThrow("target ID is required");
    expect(sender.pairingLink).toBeUndefined();
  });
  it.each(["mismatch", "unreadable"])("refuses %s before any credential or pairing write", async (reason) => {
    const url = await link();
    info.mockResolvedValue({ ok: true, user: { id: "U1", profile: reason === "mismatch" ? { email: "other@example.com" } : {} } });
    const response = await app.request(url, submit);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(reason === "mismatch" ? "another Slack account" : "Slack email is unavailable");
    expect(pairing.resolve("T1", "U1")).toBeUndefined();
    expect(start).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("refuses a forwarded link opened by another user", async () => {
    const url = await link(); session.mockResolvedValue({ user: { id: "other" }, session: { id: "web-session" } });
    expect((await app.request(url, submit)).status).toBe(400);
    expect(start).not.toHaveBeenCalled(); expect(pairing.resolve("T1", "U1")).toBeUndefined();
  });
  it("finds the sender of a paired requester's user-scoped session", async () => {
    untrack();
    const keyed = { ...sender, sessionId: undefined };
    untrack = trackSlackSender(keyed);
    const resolveSessionId = vi.fn(async (_agentId: string, _key: string, userId?: string) => (userId === "owner" ? { sessionId: "user-session" } : { sessionId: "shared-session" }));
    setSlackContext({ getConfig: () => ({}), resolveSessionId, credentialConnect: { start, save, fields: async () => [] } } as never);
    expect(await createCredentialConnectLink({ agent: { id: "connie" }, sessionId: "user-session", userId: "owner" } as never, { kind: "token", extensionId: "probe" })).toBe(SLACK_PAIR_LINK_PLACEHOLDER);
    expect(resolveSessionId).toHaveBeenCalledWith("connie", "thread", "owner");
  });
  it.each(["GET", "POST"])("refuses read-only impersonation before credential mutations on %s", async (method) => {
    const url = await link(); state.impersonating = true;
    expect((await app.request(url, { ...submit, method })).status).toBe(403);
    expect(pairing.resolve("T1", "U1")).toBeUndefined();
    expect(start).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("checks agent access before pairing", async () => {
    const url = await link(); state.access = false;
    expect((await app.request(url, submit)).status).toBe(403);
    expect(pairing.resolve("T1", "U1")).toBeUndefined(); expect(start).not.toHaveBeenCalled();
  });
  it("already-paired owner skips Slack email checks and blocks another owner", async () => {
    const pairUrl = await pairing.issue("T1", "U1", sender.client);
    await pairing.redeem(pairUrl.split("/").pop()!, { id: "owner", email: "person@example.com" });
    const url = await link(); info.mockClear();
    expect((await app.request(url)).status).toBe(302); expect(info).not.toHaveBeenCalled();
    session.mockResolvedValue({ user: { id: "other" }, session: { id: "web-session" } });
    expect((await app.request(url, submit)).status).toBe(400);
  });
  it("starts only one authorization for concurrent paired GETs", async () => {
    const pairUrl = await pairing.issue("T1", "U1", sender.client);
    await pairing.redeem(pairUrl.split("/").pop()!, { id: "owner", email: "person@example.com" });
    const url = await link();
    const responses = await Promise.all([app.request(url), app.request(url)]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 409]);
    expect(start).toHaveBeenCalledOnce();
  });
  it("saves form tokens only for the authenticated personal owner", async () => {
    const url = await link("token");
    expect(await (await app.request(url)).text()).toContain('type="password"');
    const response = await app.request(url, { ...submit, body: new URLSearchParams({ token: "test-token", userId: "other", credentialScope: "team" }) });
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith("connie", "probe", "owner", { token: "test-token" });
    expect(start).not.toHaveBeenCalled(); expect(postMessage).toHaveBeenCalledOnce();
  });
  it.each(["failure", "hang"])("credential completion survives Slack confirmation %s", async (mode) => {
    const url = await link(); await app.request(url, submit);
    if (mode === "failure") postMessage.mockRejectedValue(new Error("offline"));
    else postMessage.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const completion = start.mock.calls[0][1].onComplete();
    await vi.advanceTimersByTimeAsync(5000); await completion;
    expect((await app.request(url)).status).toBe(400);
  });
});
