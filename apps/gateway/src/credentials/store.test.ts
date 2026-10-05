import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenCipher } from "../oauth/crypto.js";
import { CredentialStore, type CredentialKey } from "./store.js";

describe("generic credential store", () => {
  let dir: string;
  let store: CredentialStore;
  const key: CredentialKey = { agentId: "agent", integration: "api-key", scope: { type: "team" } };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-test-"));
    store = new CredentialStore(dir, new TokenCipher("credential-test-key"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("encrypts arbitrary JSON payloads in full with owner-only permissions", () => {
    const payload = { apiKey: "secret-api-key", password: "secret-password", nested: { values: [1, true] } };
    store.save(key, payload);
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(payload.apiKey);
    expect(raw).not.toContain(payload.password);
    expect(raw).not.toContain("nested");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.get(key)).toEqual(payload);
    fs.chmodSync(file, 0o644);
    store.save(key, payload);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps users, integrations, agents and sanitized-looking identities distinct", () => {
    const keys: CredentialKey[] = [
      key,
      { ...key, scope: { type: "personal", userId: "a/b" } },
      { ...key, scope: { type: "personal", userId: "a_b" } },
      { ...key, scope: { type: "personal", userId: "../../outside" } },
      { ...key, agentId: "agent/other" },
      { ...key, agentId: "agent_other" },
      { ...key, integration: "password" },
    ];
    keys.forEach((entry, index) => store.save(entry, { value: index }));
    expect(fs.readdirSync(dir)).toHaveLength(keys.length);
    keys.forEach((entry, index) => expect(store.get(entry)).toEqual({ value: index }));
    store.delete(keys[1]);
    expect(store.get(keys[1])).toBeUndefined();
    expect(store.get(keys[2])).toEqual({ value: 2 });
    expect(store.get(key)).toEqual({ value: 0 });
    expect(store.get({ ...key, agentId: "missing" })).toBeUndefined();
  });

  it("fails closed without a cipher and refuses an empty personal owner", () => {
    expect(() => new CredentialStore(dir, null).save(key, { secret: "value" })).toThrow(/oauth.encryptionKey/);
    expect(() => store.save({ ...key, scope: { type: "personal", userId: "" } }, {})).toThrow(/userId/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
