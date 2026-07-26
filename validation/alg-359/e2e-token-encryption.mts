/**
 * ALG-359 e2e: prove OAuth tokens are encrypted at rest against the REAL
 * gateway runtime and an isolated YOPLAI_HOME.
 *
 * We drive the actual OAuth service (real config load, real file-backed store,
 * real config-sourced encryption key). The only fake is Google's HTTP endpoints
 * (token exchange + userinfo) at the network boundary — everything else is the
 * production code path: startAuthorization -> handleCallback -> store.save ->
 * on-disk file. We then read the persisted row from disk and assert the token
 * fields are AES-GCM ciphertext, not plaintext.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const home = process.env.YOPLAI_HOME;
assert.ok(home, "YOPLAI_HOME must be set");

const { OAuthService } = await import("../../apps/gateway/src/oauth/service.ts");
const { loadConfig } = await import("../../apps/gateway/src/config/index.ts");

const ACCESS = "ya29.E2E-PLAINTEXT-ACCESS-TOKEN";
const REFRESH = "1//E2E-PLAINTEXT-REFRESH-TOKEN";

// Fake ONLY Google's HTTP endpoints. Token store + encryption are the real path.
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("oauth2.googleapis.com/token")) {
    return new Response(
      JSON.stringify({
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (url.includes("googleapis.com/oauth2/v3/userinfo") || url.includes("userinfo")) {
    return new Response(JSON.stringify({ email: "e2e-user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch in e2e: ${url}`);
}) as typeof fetch;

// Real service: default store (writes under $YOPLAI_HOME/oauth, cipher resolved
// from oauth.encryptionKey in the seeded config), real config loader.
const service = new OAuthService({ fetchImpl: fakeFetch, loadConfig });

// 1. Real authorize -> yields the state we must echo back on callback.
const { state } = await service.startAuthorization({ agentId: "main", provider: "google" });

// 2. Real callback: exchanges code (fake Google), fetches account, persists.
const connection = await service.handleCallback({ provider: "google", code: "e2e-auth-code", state });
assert.equal(connection.account, "e2e-user@example.com", "account label round-trips");
assert.equal(connection.accessToken, ACCESS, "service returns decrypted access token in memory");
assert.equal(connection.refreshToken, REFRESH, "service returns decrypted refresh token in memory");

// 3. Read the persisted row straight off disk — the real store file.
const file = path.join(home, "oauth", "main__google.json");
assert.ok(fs.existsSync(file), `expected persisted connection file at ${file}`);
const rawOnDisk = fs.readFileSync(file, "utf8");
const parsed = JSON.parse(rawOnDisk);

// CORE ASSERTION: no plaintext token was persisted.
assert.ok(!rawOnDisk.includes(ACCESS), "access token MUST NOT appear in plaintext on disk");
assert.ok(!rawOnDisk.includes(REFRESH), "refresh token MUST NOT appear in plaintext on disk");
assert.ok(parsed.accessToken.startsWith("enc:v2:"), "accessToken on disk is AES-GCM ciphertext");
assert.ok(parsed.refreshToken.startsWith("enc:v2:"), "refreshToken on disk is AES-GCM ciphertext");

// Non-secret metadata stays readable.
assert.equal(parsed.account, "e2e-user@example.com");
assert.equal(parsed.provider, "google");

// 4. Read-back through the real service decrypts transparently.
const readBack = service.getConnection("main", "google");
assert.equal(readBack?.accessToken, ACCESS, "getConnection decrypts access token");
assert.equal(readBack?.refreshToken, REFRESH, "getConnection decrypts refresh token");

// Evidence: dump the on-disk row (ciphertext) for the validation record.
fs.writeFileSync(
  path.join(process.cwd(), "validation", "alg-359", "01-token-row-on-disk.json"),
  rawOnDisk
);

console.log("E2E PASS: tokens encrypted at rest");
console.log("  on-disk accessToken:", parsed.accessToken.slice(0, 24) + "...");
console.log("  on-disk refreshToken:", parsed.refreshToken.slice(0, 24) + "...");
console.log("  in-memory access token (decrypted):", readBack?.accessToken);
console.log("  file:", file);
