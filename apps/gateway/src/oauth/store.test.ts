import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, scryptSync, createCipheriv } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthConnection } from "@yoplai/shared";
import { TokenCipher, isEncrypted } from "./crypto.js";
import { OAuthConnectionStore } from "./store.js";

function makeConnection(overrides: Partial<OAuthConnection> = {}): OAuthConnection {
  const now = Date.now();
  return {
    agentId: "main",
    provider: "google",
    accessToken: "ya29.PLAINTEXT-ACCESS-TOKEN",
    refreshToken: "1//PLAINTEXT-REFRESH-TOKEN",
    expiresAt: now + 3600_000,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    account: "e2e-user@example.com",
    connectedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("TokenCipher", () => {
  it("round-trips plaintext and never emits the plaintext", () => {
    const cipher = new TokenCipher("test-secret-passphrase");
    const plaintext = "ya29.super-secret-token";
    const ciphertext = cipher.encrypt(plaintext);

    expect(isEncrypted(ciphertext)).toBe(true);
    expect(ciphertext.startsWith("enc:v2:")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    expect(cipher.decrypt(ciphertext)).toBe(plaintext);
  });

  it("still decrypts legacy v1 (per-ciphertext salt) envelopes", () => {
    // A v1 envelope produced by the previous scheme: salt|iv|tag|ct, key =
    // scrypt(secret, salt). Built here so the backward-compat path is covered
    // without importing the removed v1 encrypt.
    const secret = "legacy-v1-secret";
    const plaintext = "ya29.legacy-v1-token";
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(Buffer.from(secret, "utf8"), salt, 32);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    const v1 =
      "enc:v1:" + Buffer.concat([salt, iv, tag, ct]).toString("base64");

    expect(isEncrypted(v1)).toBe(true);
    expect(new TokenCipher(secret).decrypt(v1)).toBe(plaintext);
  });

  it("decrypts a v2 envelope produced under the frozen KDF salt", () => {
    // The KDF salt in crypto.ts is frozen key material: every `enc:v2:` token
    // already on disk was encrypted under a key derived from these exact bytes.
    // The salt is spelled out here independently of the implementation so that
    // re-branding or reformatting that literal fails loudly instead of silently
    // breaking every connected account on upgrade.
    const frozenSalt = Buffer.from("aihub-oauth-token-at-rest-v2", "utf8");
    const secret = "store-encryption-secret";
    const plaintext = "ya29.token-encrypted-before-the-rename";

    const iv = randomBytes(12);
    const key = scryptSync(Buffer.from(secret, "utf8"), frozenSalt, 32);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const v2 =
      "enc:v2:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");

    expect(new TokenCipher(secret).decrypt(v2)).toBe(plaintext);
  });

  it("produces distinct ciphertexts for the same input (random IV/salt)", () => {
    const cipher = new TokenCipher("test-secret-passphrase");
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("passes legacy plaintext through decrypt unchanged", () => {
    const cipher = new TokenCipher("test-secret-passphrase");
    expect(cipher.decrypt("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("fails to decrypt with the wrong secret", () => {
    const ciphertext = new TokenCipher("secret-a").encrypt("token");
    expect(() => new TokenCipher("secret-b").decrypt(ciphertext)).toThrow();
  });
});

describe("OAuthConnectionStore encryption at rest", () => {
  let tmpDir: string;
  const cipher = new TokenCipher("store-encryption-secret");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists token rows as ciphertext, not plaintext", () => {
    const store = new OAuthConnectionStore(tmpDir, cipher);
    const connection = makeConnection();
    store.save(connection);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const rawOnDisk = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");

    // The persisted row must not contain either plaintext token.
    expect(rawOnDisk).not.toContain(connection.accessToken);
    expect(rawOnDisk).not.toContain(connection.refreshToken);

    // The stored token fields are our AES-GCM envelope.
    const parsed = JSON.parse(rawOnDisk);
    expect(isEncrypted(parsed.accessToken)).toBe(true);
    expect(isEncrypted(parsed.refreshToken)).toBe(true);

    // Non-secret metadata is still readable.
    expect(parsed.account).toBe(connection.account);
    expect(parsed.provider).toBe("google");
  });

  it("decrypts tokens transparently on read", () => {
    const store = new OAuthConnectionStore(tmpDir, cipher);
    const connection = makeConnection();
    store.save(connection);

    const loaded = store.get("main", "google");
    expect(loaded?.accessToken).toBe(connection.accessToken);
    expect(loaded?.refreshToken).toBe(connection.refreshToken);
  });

  it("round-trips a connection with no refresh token", () => {
    const store = new OAuthConnectionStore(tmpDir, cipher);
    const connection = makeConnection({ refreshToken: undefined });
    store.save(connection);

    const rawOnDisk = fs.readFileSync(
      path.join(tmpDir, fs.readdirSync(tmpDir)[0]),
      "utf8"
    );
    expect(rawOnDisk).not.toContain(connection.accessToken);

    const loaded = store.get("main", "google");
    expect(loaded?.accessToken).toBe(connection.accessToken);
    expect(loaded?.refreshToken).toBeUndefined();
  });

  it("reads legacy plaintext rows written before encryption was enabled", () => {
    // Seed a legacy plaintext row on disk directly (as written by a pre-
    // encryption build). The store itself never writes plaintext.
    const connection = makeConnection();
    fs.writeFileSync(
      path.join(tmpDir, "main__google.json"),
      JSON.stringify(connection, null, 2),
      { mode: 0o600 }
    );

    // A cipher-backed store still reads the legacy plaintext row.
    const encStore = new OAuthConnectionStore(tmpDir, cipher);
    const loaded = encStore.get("main", "google");
    expect(loaded?.accessToken).toBe(connection.accessToken);
    expect(loaded?.refreshToken).toBe(connection.refreshToken);
  });

  it("fails closed: refuses to persist tokens when no cipher is configured", () => {
    // `null` forces the no-cipher state (as when oauth.encryptionKey is unset).
    const store = new OAuthConnectionStore(tmpDir, null);

    expect(() => store.save(makeConnection())).toThrow(
      /plaintext[\s\S]*oauth\.encryptionKey|oauth\.encryptionKey/i
    );
    // Nothing was written to disk: no plaintext token row was created.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});
