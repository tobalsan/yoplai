/**
 * ALG-359 e2e (fail-closed): prove the real gateway runtime NEVER persists a
 * plaintext token row when oauth.encryptionKey is unset.
 *
 * Same real code path as e2e-token-encryption.mts (real config load, real
 * file-backed store, only Google's HTTP endpoints faked), but the seeded
 * YOPLAI_HOME config OMITS oauth.encryptionKey. The connect must fail and no
 * token file may be written.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const home = process.env.YOPLAI_HOME;
assert.ok(home, "YOPLAI_HOME must be set");

const { OAuthService } = await import("../../apps/gateway/src/oauth/service.ts");
const { loadConfig } = await import("../../apps/gateway/src/config/index.ts");

const ACCESS = "ya29.FAILCLOSED-ACCESS-TOKEN";
const REFRESH = "1//FAILCLOSED-REFRESH-TOKEN";

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
  if (url.includes("userinfo")) {
    return new Response(JSON.stringify({ email: "e2e-user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch in e2e: ${url}`);
}) as typeof fetch;

const service = new OAuthService({ fetchImpl: fakeFetch, loadConfig });

const { state } = await service.startAuthorization({ agentId: "main", provider: "google" });

// The callback exchanges the code then tries to persist. With no encryption key
// configured, save() must fail closed rather than write plaintext.
let threw = false;
try {
  await service.handleCallback({ provider: "google", code: "e2e-auth-code", state });
} catch (err) {
  threw = true;
  const msg = (err as Error).message;
  assert.match(msg, /plaintext/i, "error explains it refuses plaintext");
  assert.match(msg, /oauth\.encryptionKey/, "error points operator at the key");
}
assert.ok(threw, "connect MUST fail when oauth.encryptionKey is unset");

// No token file may exist on disk.
const file = path.join(home, "oauth", "main__google.json");
assert.ok(!fs.existsSync(file), `no token file may be written; found ${file}`);

console.log("E2E PASS (fail-closed): no plaintext token row persisted without a key");
