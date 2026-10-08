import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayConfig, OAuthConnection } from "@yoplai/shared";
import { CredentialStore } from "./store.js";
import { createConnectionRoutes } from "./routes.js";
import { getPersonalExtensionTokens, storePersonalExtensionTokens } from "./extension-tokens.js";
import { OAuthService } from "../oauth/service.js";
import { OAuthConnectionStore } from "../oauth/store.js";
import { TokenCipher } from "../oauth/crypto.js";
const audit = vi.hoisted(() => vi.fn());
vi.mock("../audit/store.js", () => ({ recordSettingsChange: audit, getAuditActor: async () => ({ actorUserId: "alice", actorEmail: "alice@example.com" }) }));

let dir: string;
let store: CredentialStore;
let oauthStore: OAuthConnectionStore;
let userId: string | undefined;
let allowed: boolean;
const config = { agents: [{ id: "agent", extensions: { token: { enabled: true, apiToken: "shared-secret" } } }, { id: "cira", extensions: { token: { enabled: true } } }], extensions: {} } as unknown as GatewayConfig;
const entry = { id: "token", displayName: "Token", requiredSecrets: ["apiToken"], configValues: { apiToken: "********" } };
const grant = (owner?: string): OAuthConnection => ({ agentId: "agent", provider: "google", scope: owner ? "personal" : "team", userId: owner, accessToken: owner ?? "team-secret", scopes: [], connectedAt: 1, updatedAt: 1 });
beforeEach(() => {
  audit.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "connections-"));
  store = new CredentialStore(path.join(dir, "tokens"), new TokenCipher("test"));
  oauthStore = new OAuthConnectionStore(path.join(dir, "oauth"), new TokenCipher("test"));
  userId = "alice";
  allowed = true;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function app(fetchImpl = vi.fn().mockResolvedValue({ ok: true })) {
  const oauth = new OAuthService({ store: oauthStore, loadConfig: () => config, fetchImpl });
  return { oauth, router: createConnectionRoutes({ config: () => config, store, oauth, catalog: vi.fn().mockResolvedValue([entry]), getUserId: async () => userId, canAccessAgent: async () => allowed }) };
}
it("lists only caller presence and team presence without secret or owner metadata", async () => {
  oauthStore.save(grant("bob"));
  oauthStore.save(grant());
  storePersonalExtensionTokens(store, "bob", "token", { apiToken: "bob-secret" });
  const response = await app().router.request("/agents/agent/connections?userId=bob");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connections: [
    { kind: "oauth", id: "google", name: "google", personal: false, team: true },
    { kind: "extension", id: "token", name: "Token", personal: false, team: true },
  ] });
});
it("deletes caller tokens only and immediately falls back while OAuth revocation hangs", async () => {
  oauthStore.save(grant("alice"));
  oauthStore.save(grant("bob"));
  oauthStore.save(grant());
  const { router, oauth } = app(vi.fn().mockReturnValue(new Promise(() => {})));
  const response = await router.request("/agents/agent/connections/oauth/google?userId=bob", { method: "DELETE" });
  expect(response.status).toBe(200);
  expect(oauth.getConnection("agent", "google", "alice")?.accessToken).toBe("team-secret");
  expect(oauth.getConnection("agent", "google", "bob")?.accessToken).toBe("bob");
  for (const owner of ["alice", "bob"]) storePersonalExtensionTokens(store, owner, "token", { apiToken: owner });
  expect((await router.request("/agents/agent/connections/extension/token", { method: "DELETE" })).status).toBe(200);
  expect(getPersonalExtensionTokens(store, "agent", "alice", "token")).toBeUndefined();
  expect(getPersonalExtensionTokens(store, "agent", "bob", "token")).toEqual({ apiToken: "bob" });
  expect(audit).toHaveBeenCalledTimes(2);
  expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: "alice", action: "connection.personal_remove", targetType: "extension", targetId: "token", scope: "personal", changes: [{ field: "apiToken", secret: "removed" }] }));
  await router.request("/agents/agent/connections/extension/token", { method: "DELETE" });
  expect(audit).toHaveBeenCalledTimes(2);
});
it("requires login and agent access for listing and deletion", async () => {
  const { router } = app();
  for (const [path, method] of [["/agents/agent/connections", "GET"], ["/agents/agent/connections/extension/token", "DELETE"]]) {
    userId = undefined;
    expect((await router.request(path, { method })).status).toBe(401);
    userId = "alice";
    allowed = false;
    expect((await router.request(path, { method })).status).toBe(403);
  }
});
it("lists a personal token saved via another agent and reports disconnected after removal", async () => {
  storePersonalExtensionTokens(store, "alice", "token", { apiToken: "alice-secret" });
  const { router } = app();
  const list = async (agentId: string) => (await (await router.request(`/agents/${agentId}/connections`)).json() as { connections: Array<{ kind: string; personal: boolean }> }).connections.find((item) => item.kind === "extension");
  expect(await list("cira")).toMatchObject({ personal: true });
  expect((await router.request("/agents/cira/connections/extension/token", { method: "DELETE" })).status).toBe(200);
  expect(await list("agent")).toMatchObject({ personal: false });
  expect(await list("cira")).toBeUndefined();
});
