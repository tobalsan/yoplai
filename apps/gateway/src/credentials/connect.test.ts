import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCredentialOAuthConnector, type CredentialOAuthConnectorOptions } from "@yoplai/shared";
import { credentialConnectHost } from "./connect.js";

const state = vi.hoisted(() => ({
  agent: { id: "sales", extensions: { fixture: { enabled: true } } },
  extension: {
    id: "fixture", requiredSecrets: ["apiToken"],
    configJsonSchema: { properties: { apiToken: { title: "API token", writeOnly: true }, optional: { writeOnly: true } } },
  },
  start: vi.fn(async () => ({ authorizeUrl: "https://provider.test/authorize" })),
  save: vi.fn(),
  audit: vi.fn(),
  before: {} as Record<string, string>,
}));
vi.mock("../config/index.js", () => ({ getAgent: (id: string) => id === "sales" ? state.agent : undefined, loadConfig: () => ({ extensions: {} }) }));
vi.mock("../extensions/registry.js", () => ({ getLoadedExtensions: () => [state.extension], isExtensionLoaded: () => false }));
vi.mock("../oauth/service.js", () => ({ getOAuthService: () => ({ startAuthorization: state.start }) }));
vi.mock("./extension-tokens.js", () => ({ extensionSecretFields: () => ["apiToken", "optional"], getPersonalExtensionTokens: () => state.before, resolveExtensionTokenConfig: () => ({ missing: ["apiToken", "username"] }), savePersonalExtensionTokens: state.save }));
vi.mock("./store.js", () => ({ CredentialStore: class { get() { return state.before; } } }));
vi.mock("../audit/store.js", () => ({ recordSettingsChange: state.audit }));
afterEach(() => { vi.clearAllMocks(); state.before = {}; });

describe("host single-pass credential connector", () => {
  it("starts host OAuth for the verified personal user with the completion callback", async () => {
    const options = { agentId: "sales", userId: "alice", onComplete: vi.fn(async () => {}) };
    await expect(credentialConnectHost.start({ kind: "oauth", provider: "google", scopes: ["gmail"] }, options)).resolves.toBe("https://provider.test/authorize");
    expect(state.start).toHaveBeenCalledWith({ ...options, provider: "google", scopes: ["gmail"], scope: "personal", onComplete: expect.any(Function) });
    const start = state.start.mock.calls[0] as unknown as [{ onComplete: () => Promise<void> }];
    await start[0].onComplete();
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "alice", action: "oauth.connect", scope: "personal" }));
    expect(options.onComplete).toHaveBeenCalledOnce();
  });
  it("uses declared form fields and the validated personal writer", async () => {
    expect(await credentialConnectHost.fields("sales", "fixture")).toEqual([
      { name: "username", label: "username", required: false, secret: false },
      { name: "apiToken", label: "API token", required: true, secret: true },
      { name: "optional", label: "optional", required: false, secret: true },
    ]);
    await credentialConnectHost.save("sales", "fixture", "alice", { apiToken: "fixture-value" });
    expect(state.save).toHaveBeenCalledWith(state.extension, state.agent, { extensions: {} }, "alice", { apiToken: "fixture-value" }, expect.any(Object));
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "extension.personal_update", changes: [{ field: "apiToken", secret: "set" }] }));
    await expect(credentialConnectHost.save("sales", "unavailable", "alice", {})).rejects.toThrow("unavailable");
    await expect(credentialConnectHost.fields("missing", "fixture")).rejects.toThrow("unavailable");
  });
  it("lets an extension-owned OAuth connector join the same flow", async () => {
    const start = vi.fn(async (_options: CredentialOAuthConnectorOptions) => "https://extension.test/authorize");
    const unregister = registerCredentialOAuthConnector("fixture", start);
    const options = { agentId: "sales", userId: "alice", onComplete: vi.fn(async () => {}) };
    try {
      await expect(credentialConnectHost.start({ kind: "extension-oauth", extensionId: "fixture", targetId: "server-a" }, options)).resolves.toBe("https://extension.test/authorize");
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ agentId: "sales", userId: "alice", targetId: "server-a" }));
      const complete = start.mock.calls[0][0].onComplete;
      await expect(complete("server-b")).rejects.toThrow("target ID does not match");
      expect(options.onComplete).not.toHaveBeenCalled();
      await complete("server-a");
      expect(options.onComplete).toHaveBeenCalledOnce();
      await expect(credentialConnectHost.start({ kind: "extension-oauth", extensionId: "fixture", targetId: " " }, options)).rejects.toThrow("target ID is required");
    } finally { unregister(); }
    await expect(credentialConnectHost.start({ kind: "extension-oauth", extensionId: "fixture", targetId: "server-a" }, options)).rejects.toThrow("does not support");
  });
  it("does not audit an unchanged personal token", async () => {
    state.before = { apiToken: "unchanged" };
    await credentialConnectHost.save("sales", "fixture", "alice", { apiToken: "unchanged" });
    expect(state.audit).not.toHaveBeenCalled();
  });
});
