import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { defaultAc, userAc } from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import type Database from "better-sqlite3";
import type { GatewayConfig, MultiUserConfig } from "@yoplai/shared";

function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getAuthBaseUrl(config: GatewayConfig): string {
  const configured =
    nonEmpty(config.server?.baseUrl) ??
    nonEmpty(config.web?.baseUrl) ??
    `http://127.0.0.1:${config.gateway?.port ?? 4000}`;
  return normalizeOrigin(configured);
}

function getTrustedOrigins(config: GatewayConfig): string[] {
  const uiPort = config.ui?.port ?? 3000;
  const candidates = [
    nonEmpty(config.server?.baseUrl),
    nonEmpty(config.web?.baseUrl),
    getAuthBaseUrl(config),
    // Dev mode: web UI runs on a separate port
    `http://localhost:${uiPort}`,
    `http://127.0.0.1:${uiPort}`,
  ].filter((value): value is string => !!value);

  return [...new Set(candidates.map(normalizeOrigin))];
}

/**
 * Bootstrap fields applied to a new user in the `before` create hook.
 * The very first user of a fresh instance becomes `superadmin` and is
 * auto-approved; everyone else keeps the default role and is unapproved.
 *
 * Setting these in `before` ensures the initial session reflects them
 * immediately (an `after`-hook update would be masked by the session cache).
 */
export function resolveBootstrapUserFields(userCount: number): {
  approved: boolean;
  role?: string;
} {
  const isFirstUser = userCount === 0;
  return {
    approved: isFirstUser,
    ...(isFirstUser ? { role: "superadmin" } : {}),
  };
}

function isAllowedDomain(email: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return allowedDomains.some((allowed) => allowed.toLowerCase() === domain);
}

export type MultiUserAuth = {
  handler: ReturnType<typeof betterAuth>["handler"];
  api: ReturnType<typeof betterAuth>["api"] & {
    listUsers(args: {
      headers: Headers;
      query: Record<string, never>;
    }): Promise<{ users: Array<Record<string, unknown>>; total: number }>;
    getUser(args: {
      headers: Headers;
      query: { id: string };
    }): Promise<Record<string, unknown> | null>;
    setRole(args: {
      headers: Headers;
      body: { userId: string; role: string };
    }): Promise<{ user: Record<string, unknown> }>;
    verifyApiKey(args: {
      body: { key: string };
    }): Promise<{
      valid: boolean;
      key?: Record<string, unknown> | null;
      error?: { message?: string; code?: string } | null;
    }>;
    createApiKey(args: {
      body: { userId: string; name?: string };
    }): Promise<Record<string, unknown>>;
    listApiKeys(args: {
      headers: Headers;
      query?: Record<string, unknown>;
    }): Promise<Array<Record<string, unknown>>>;
    deleteApiKey(args: {
      headers?: Headers;
      body: { keyId: string };
    }): Promise<Record<string, unknown>>;
  };
};

function buildMultiUserAuth(
  config: GatewayConfig,
  multiUserConfig: Extract<MultiUserConfig, { enabled: true }>,
  db: Database.Database
) {
  return betterAuth({
    appName: "Yoplai",
    baseURL: getAuthBaseUrl(config),
    basePath: "/api/auth",
    secret: multiUserConfig.sessionSecret,
    database: db,
    trustedOrigins: getTrustedOrigins(config),
    socialProviders: {
      google: {
        clientId: multiUserConfig.oauth.google.clientId,
        clientSecret: multiUserConfig.oauth.google.clientSecret,
        prompt: "select_account",
      },
    },
    user: {
      additionalFields: {
        approved: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    plugins: [
      admin({
        defaultRole: "user",
        // Both admins and superadmins count as staff for better-auth admin
        // APIs (listUsers, setRole, impersonation, etc.).
        adminRoles: ["admin", "superadmin"],
        // Both roles must be declared in the access-control roles map or
        // better-auth rejects them in `adminRoles`.
        //
        // `create`, `set-role`, and `impersonate-admins` are granted ONLY to
        // `superadmin`. This is the enforcement point for "admins cannot
        // change roles":
        //   - Without `set-role`, the built-in `POST /admin/set-role` (and the
        //     `role` field of `POST /admin/update-user`) rejects admins, so an
        //     admin cannot escalate an existing user's role.
        //   - Without `create`, the built-in `POST /admin/create-user` rejects
        //     admins, so an admin cannot mint a brand-new superadmin account.
        // Users self-register via Google OAuth, so admins never need the
        // built-in create-user endpoint.
        roles: {
          user: userAc,
          // Stock admin permissions minus `create` and `set-role`.
          admin: defaultAc.newRole({
            user: [
              "list",
              "ban",
              "impersonate",
              "delete",
              "set-password",
              "get",
              "update",
            ],
            session: ["list", "revoke", "delete"],
          }),
          superadmin: defaultAc.newRole({
            user: [
              "create",
              "list",
              "set-role",
              "ban",
              "impersonate",
              "impersonate-admins",
              "delete",
              "set-password",
              "get",
              "update",
            ],
            session: ["list", "revoke", "delete"],
          }),
        },
      }),
      apiKey({
        rateLimit: { enabled: false },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowedDomain(user.email, multiUserConfig.allowedDomains)) {
              throw new APIError("FORBIDDEN", {
                message: "Email domain is not allowed",
              });
            }

            const userCount = db
              .prepare("SELECT COUNT(*) AS count FROM user")
              .get() as { count: number };

            return {
              data: {
                ...user,
                ...resolveBootstrapUserFields(userCount.count),
              },
            };
          },
        },
      },
    },
  });
}

export async function createMultiUserAuth(
  config: GatewayConfig,
  multiUserConfig: Extract<MultiUserConfig, { enabled: true }>,
  db: Database.Database
): Promise<MultiUserAuth> {
  const auth = buildMultiUserAuth(config, multiUserConfig, db);

  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  return auth as unknown as MultiUserAuth;
}
