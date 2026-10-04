import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayConfig, OAuthConnection } from "@yoplai/shared";
import { CredentialStore } from "./store.js";
import { createConnectionRoutes } from "./routes.js";
import { OAuthService } from "../oauth/service.js";
import { OAuthConnectionStore } from "../oauth/store.js";
import { TokenCipher } from "../oauth/crypto.js";

let dir: string;
let store: CredentialStore;
let oauthStore: OAuthConnectionStore;
let userId: string | undefined;
let allowed: boolean;
const config = { agents: [{ id: "agent", extensions: { token: { enabled: true, apiToken: "shared-secret" } } }], extensions: {} } as unknown as GatewayConfig;
const entry = { id: "token", displayName: "Token", requiredSecrets: ["apiToken"], configValues: { apiToken: "********" } };
const grant = (owner?: string): OAuthConnection => ({ agentId: "agent", provider: "google", scope: owner ? "personal" : "team", userId: owner, accessToken: owner ?? "team-secret", scopes: [], connectedAt: 1, updatedAt: 1 });
beforeEach(() => {
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
  store.save({ agentId: "agent", integration: "extension-config:token", scope: { type: "personal", userId: "bob" } }, { apiToken: "bob-secret" });
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
  for (const owner of ["alice", "bob"]) store.save({ agentId: "agent", integration: "extension-config:token", scope: { type: "personal", userId: owner } }, { apiToken: owner });
  expect((await router.request("/agents/agent/connections/extension/token", { method: "DELETE" })).status).toBe(200);
  expect(store.get({ agentId: "agent", integration: "extension-config:token", scope: { type: "personal", userId: "alice" } })).toBeUndefined();
  expect(store.get({ agentId: "agent", integration: "extension-config:token", scope: { type: "personal", userId: "bob" } })).toEqual({ apiToken: "bob" });
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
