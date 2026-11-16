import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { GatewayConfigSchema } from "@yoplai/shared";
import { createMultiUserAuth, type MultiUserAuth } from "./auth.js";
import { ensureManagedKeyPrefixIndex, initializeMultiUserDatabase } from "./db.js";
import { randomBase64Url, s256Challenge } from "./gateway-link-codec.js";
import { createGatewayLinkService, type GatewayLinkService, type GatewayLinkServiceOptions } from "./gateway-link.js";

/** Synthetic fixtures for the gateway link tests. Every user, secret, and key here is made up for the test. */
export const REMOTE_ORIGIN = "https://remote.example.test";
export const SESSION_SECRET = "synthetic-session-secret-with-32-chars!";
export const CALLBACK_URI = "http://127.0.0.1:4555/api/relay/link/callback";

export type LinkFixture = {
  dir: string;
  db: Database.Database;
  auth: MultiUserAuth;
  service: GatewayLinkService;
  clock: { now: number };
  /** Builds a second service over the same database, as a restarted process would. */
  restart(options?: Partial<GatewayLinkServiceOptions>): GatewayLinkService;
  addUser(id: string, options?: { approved?: boolean; banned?: boolean; role?: string }): void;
  close(): void;
};

export async function createLinkFixture(options: Partial<GatewayLinkServiceOptions> = {}): Promise<LinkFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-gateway-link-"));
  const db = initializeMultiUserDatabase(path.join(dir, "auth.db"));
  const config = GatewayConfigSchema.parse({
    version: 2,
    agents: [],
    gateway: { port: 4999 },
    server: { baseUrl: REMOTE_ORIGIN },
    extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: SESSION_SECRET } },
  });
  const multiUser = config.extensions?.multiUser;
  if (!multiUser?.enabled) throw new Error("multi-user fixture config is disabled");
  const auth = await createMultiUserAuth(config, multiUser, db);
  ensureManagedKeyPrefixIndex(db);
  // The clock starts at real time. The plugin checks key expiry against the real clock.
  const clock = { now: Date.now() };
  const build = (extra: Partial<GatewayLinkServiceOptions> = {}) => {
    const service = createGatewayLinkService({
      db,
      auth: auth.api,
      secret: SESSION_SECRET,
      getAllowedOrigins: () => [REMOTE_ORIGIN],
      now: () => clock.now,
      ...options,
      ...extra,
    });
    service.recover();
    return service;
  };
  return {
    dir,
    db,
    auth,
    service: build(),
    clock,
    restart: (extra) => build(extra),
    addUser(id, userOptions = {}) {
      const now = new Date(clock.now).toISOString();
      db.prepare(
        `INSERT INTO user (id, name, email, emailVerified, image, role, approved, banned, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`
      ).run(id, `User ${id}`, `${id}@example.test`, userOptions.role ?? "user", userOptions.approved === false ? 0 : 1, userOptions.banned ? 1 : 0, now, now);
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: s256Challenge(verifier) };
}

export function requestInput(overrides: Partial<{ deviceLabel: string; callbackUri: string; replaceLinkId: string }> = {}) {
  const pkce = pkcePair();
  const state = randomBase64Url(32);
  return {
    pkce,
    state,
    body: {
      challenge: pkce.challenge,
      state,
      callbackUri: overrides.callbackUri ?? CALLBACK_URI,
      deviceLabel: overrides.deviceLabel ?? "Test laptop",
      ...(overrides.replaceLinkId ? { replaceLinkId: overrides.replaceLinkId } : {}),
    },
  };
}

export const sessionOf = (userId: string) => ({ userId, sessionId: `session-${userId}` });

/** Splits an approval redirect into the code and the state. */
export function readRedirect(redirectUrl: string): { code?: string; error?: string; state: string; base: string } {
  const [base, fragment = ""] = redirectUrl.split("#");
  const params = new URLSearchParams(fragment);
  return { base: base!, code: params.get("code") ?? undefined, error: params.get("error") ?? undefined, state: params.get("state") ?? "" };
}
