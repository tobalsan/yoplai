import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { readEnv, resolveBindHost } from "@yoplai/shared";
import { loadConfig, CONFIG_DIR } from "../config/index.js";
import { resolveConfigSecrets } from "../config/secrets.js";
import { logError } from "../logging.js";

type CachedToken = {
  token: string;
  tokenId?: string;
  userId?: string;
  createdAt: string;
};

type UserRow = {
  id: string;
  email: string;
  name?: string | null;
};

type CreateOptions = {
  user: string;
  name?: string;
};

type ListOptions = {
  user?: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_CACHE_FILENAME = "user-token.json";

function getTokenCachePath(): string {
  return path.join(CONFIG_DIR, TOKEN_CACHE_FILENAME);
}

export function loadCachedToken(): CachedToken | null {
  const p = getTokenCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as CachedToken;
  } catch {
    return null;
  }
}

export function saveCachedToken(token: CachedToken): void {
  const p = getTokenCachePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore on platforms that don't support chmod
  }
}

function getApiBaseUrl(): string {
  const envUrl = readEnv("API_URL");
  if (envUrl) return envUrl;

  const config = loadConfig();
  const host = config.gateway?.host ?? resolveBindHost(config.gateway?.bind);
  const port = config.gateway?.port ?? 4000;
  return `http://${host}:${port}`;
}

function resolveUser(
  db: { prepare: (sql: string) => unknown },
  identifier: string
): UserRow | null {
  const byIdStmt = db.prepare(
    "SELECT id, email, name FROM user WHERE id = ?"
  ) as { get: (id: string) => UserRow | undefined };
  const byId = byIdStmt.get(identifier);
  if (byId) return byId;
  const byEmailStmt = db.prepare(
    "SELECT id, email, name FROM user WHERE email = ?"
  ) as { get: (email: string) => UserRow | undefined };
  return byEmailStmt.get(identifier) ?? null;
}

export async function createTokenInProcess(opts: {
  identifier: string;
  name?: string;
  dataDir?: string;
}): Promise<{ token: string; tokenId: string; userId: string }> {
  // loadConfig() loads $YOPLAI_HOME/.env into process.env but leaves $env: refs
  // unresolved on the returned object; the gateway proper resolves them via
  // prepareStartupConfig(). The CLI bootstrap mirrors that step so baseUrl /
  // sessionSecret / OAuth refs reach better-auth as real strings.
  const config = await resolveConfigSecrets(loadConfig());
  const mu = config.extensions?.multiUser;
  if (!mu?.enabled) {
    throw new Error(
      "multi-user extension is not enabled in this Yoplai config"
    );
  }

  const dataDir = opts.dataDir ?? CONFIG_DIR;
  const { initializeMultiUserDatabase, createMultiUserAuth } = await import(
    "@yoplai/extension-multi-user"
  );

  const db = initializeMultiUserDatabase(dataDir);
  try {
    const auth = await createMultiUserAuth(config, mu, db);
    const user = resolveUser(db, opts.identifier);
    if (!user) {
      throw new Error(`No user matched "${opts.identifier}" (email or id)`);
    }

    const result = (await auth.api.createApiKey({
      body: { userId: user.id, name: opts.name },
    })) as Record<string, unknown>;

    // On creation, the plugin returns the plaintext key in `key` (only at this moment).
    const token = result.key as string | undefined;
    const tokenId = (result.id as string | undefined) ?? "";
    if (!token) {
      throw new Error(
        "createApiKey did not return a plaintext key; cannot proceed"
      );
    }

    console.log(
      JSON.stringify({
        event: "user_token.created",
        userId: user.id,
        tokenId,
        actor: "cli",
      })
    );

    return { token, tokenId, userId: user.id };
  } finally {
    db.close();
  }
}

async function bearerRequest(
  pathname: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  token: string,
  baseUrl: string
): Promise<Response> {
  const url = new URL(pathname, baseUrl).toString();
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetchImpl(url, { ...init, headers });
}

async function printResponse(
  res: Response,
  okLabel?: string
): Promise<void> {
  const text = await res.text();
  if (!res.ok) {
    logError("User token request failed", text || res.statusText);
    process.exit(1);
  }
  if (okLabel) console.log(okLabel);
  if (text) console.log(text);
}

function reportError(err: unknown): never {
  logError("Error", err);
  process.exit(1);
}

export function registerUserTokenCommands(
  program: Command,
  options?: {
    fetchImpl?: FetchLike;
    baseUrl?: string;
  }
): void {
  const fetchImpl = options?.fetchImpl ?? fetch;

  const user = program.command("user").description("Manage users");
  const token = user
    .command("token")
    .description("Manage bearer API tokens for headless API calls");

  token
    .command("create")
    .description("Create a new bearer API token for a user")
    .requiredOption("--user <emailOrId>", "User email or id")
    .option("--name <name>", "Optional token name")
    .action(async (opts: CreateOptions) => {
      try {
        const cached = loadCachedToken();
        if (cached) {
          // HTTP path: use cached bearer to ask the gateway to create the token.
          const baseUrl = options?.baseUrl ?? getApiBaseUrl();
          const res = await bearerRequest(
            "/api/auth/api-key/create",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                userId: opts.user,
                name: opts.name,
              }),
            },
            fetchImpl,
            cached.token,
            baseUrl
          );
          await printResponse(res);
          return;
        }

        // Bootstrap path: open the auth DB locally.
        const { token: plain, tokenId, userId } = await createTokenInProcess({
          identifier: opts.user,
          name: opts.name,
        });

        saveCachedToken({
          token: plain,
          tokenId,
          userId,
          createdAt: new Date().toISOString(),
        });

        console.log("");
        console.log("Token (shown once, save it now):");
        console.log(plain);
        console.log("");
        console.log(`Cached at ${getTokenCachePath()} (mode 0600)`);
      } catch (err) {
        reportError(err);
      }
    });

  token
    .command("list")
    .description("List bearer API tokens (uses cached bearer)")
    .option("--user <emailOrId>", "Filter to a user (admin only)")
    .action(async (opts: ListOptions) => {
      try {
        const cached = loadCachedToken();
        if (!cached) {
          logError(
            "No cached bearer token",
            "Run `yoplai user token create --user <email>` first."
          );
          process.exit(1);
        }

        const baseUrl = options?.baseUrl ?? getApiBaseUrl();
        const params = opts.user
          ? `?userId=${encodeURIComponent(opts.user)}`
          : "";
        const res = await bearerRequest(
          `/api/auth/api-key/list${params}`,
          { method: "GET" },
          fetchImpl,
          cached.token,
          baseUrl
        );
        await printResponse(res);
      } catch (err) {
        reportError(err);
      }
    });

  token
    .command("revoke")
    .description("Revoke a bearer API token by id (uses cached bearer)")
    .argument("<tokenId>", "Token id to revoke")
    .action(async (tokenId: string) => {
      try {
        const cached = loadCachedToken();
        if (!cached) {
          logError(
            "No cached bearer token",
            "Run `yoplai user token create --user <email>` first."
          );
          process.exit(1);
        }

        const baseUrl = options?.baseUrl ?? getApiBaseUrl();
        const res = await bearerRequest(
          `/api/user/token/${encodeURIComponent(tokenId)}`,
          { method: "DELETE" },
          fetchImpl,
          cached.token,
          baseUrl
        );
        await printResponse(res, "Revoked.");
      } catch (err) {
        reportError(err);
      }
    });
}
