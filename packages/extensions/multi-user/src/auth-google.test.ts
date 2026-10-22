import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { createMultiUserAuth, type MultiUserAuth } from "./auth.js";
import { initializeMultiUserDatabase } from "./db.js";

const origin = "http://127.0.0.1:4130";
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function rememberCookies(jar: Map<string, string>, response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookies(jar: Map<string, string>) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function googleSignIn(auth: MultiUserAuth, expectedError?: string) {
  const jar = new Map<string, string>();
  const start = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ provider: "google", callbackURL: `${origin}/teams` }),
  }));
  expect(start.status).toBe(200);
  rememberCookies(jar, start);
  const { url } = await start.json() as { url: string };
  const state = new URL(url).searchParams.get("state");
  const callback = await auth.handler(new Request(
    `${origin}/api/auth/callback/google?code=test-code&state=${state}`,
    { headers: { cookie: cookies(jar) } },
  ));
  expect(callback.status).toBe(302);
  if (expectedError) {
    expect(new URL(callback.headers.get("location")!, origin).searchParams.get("error")).toBe(expectedError);
  } else {
    expect(callback.headers.get("location")).toBe(`${origin}/teams`);
  }
  rememberCookies(jar, callback);
  return jar;
}

it.each(["https://lh3.googleusercontent.com/old-photo", null])("refreshes an existing Google user's picture (%s) without replacing their edited identity", async (storedImage) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-google-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = initializeMultiUserDatabase(path.join(directory, "auth.db"));
  cleanups.push(() => db.close());
  const config = GatewayConfigSchema.parse({
    version: 3,
    agents: [],
    gateway: { port: 4130 },
    extensions: { multiUser: {
      enabled: true,
      sessionSecret: "google-avatar-test-secret-32-characters",
      oauth: { google: { clientId: "test-client", clientSecret: "test-secret" } },
    } },
  });
  const multiUser = config.extensions?.multiUser;
  if (!multiUser?.enabled) throw new Error("Missing multi-user configuration");
  const auth = await createMultiUserAuth(config, multiUser, db);

  let picture: string | undefined = "https://lh3.googleusercontent.com/old-photo";
  let email = "google@e2e.test";
  let exchangeFails = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== "https://oauth2.googleapis.com/token") {
      throw new Error(`Unexpected external request: ${String(input)}`);
    }
    if (exchangeFails) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    // Only the external token exchange is controlled; Better Auth owns the flow.
    const profile = Buffer.from(JSON.stringify({
      sub: "google-account-123",
      name: "Google Name",
      email,
      email_verified: true,
      picture,
    })).toString("base64url");
    return Response.json({
      access_token: "test-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: `eyJhbGciOiJub25lIn0.${profile}.test`,
    });
  }));

  const firstCookies = await googleSignIn(auth);
  const session = async (jar: Map<string, string>, fresh = false) => {
    const response = await auth.handler(new Request(
      `${origin}/api/auth/get-session${fresh ? "?disableCookieCache=true" : ""}`,
      { headers: { cookie: cookies(jar) } },
    ));
    expect(response.status).toBe(200);
    return response.json();
  };
  const first = await session(firstCookies);
  expect(first.user.image).toBe("https://lh3.googleusercontent.com/old-photo");

  // Arrange an admin-edited local identity independently of Google's profile.
  db.prepare("UPDATE user SET name = ?, email = ?, image = ? WHERE id = ?")
    .run("Admin Edited Name", "local@e2e.test", storedImage, first.user.id);
  picture = "https://lh3.googleusercontent.com/current-photo";
  email = "new-google@e2e.test";
  const nextCookies = await googleSignIn(auth);
  for (const fresh of [false, true]) {
    const next = await session(nextCookies, fresh);
    expect(next.user).toMatchObject({
      id: first.user.id,
      name: "Admin Edited Name",
      email: "local@e2e.test",
      image: "https://lh3.googleusercontent.com/current-photo",
    });
  }

  picture = undefined;
  const noPhotoCookies = await googleSignIn(auth);
  expect((await session(noPhotoCookies)).user.image).toBeNull();
  expect((await session(noPhotoCookies, true)).user.image).toBeNull();

  exchangeFails = true;
  await googleSignIn(auth, "invalid_code");
  expect((await session(noPhotoCookies, true)).user.image).toBeNull();
  exchangeFails = false;
  picture = "https://lh3.googleusercontent.com/recovered-photo";
  expect((await session(await googleSignIn(auth))).user.image).toBe("https://lh3.googleusercontent.com/recovered-photo");

});
