import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { initializeMultiUserDatabase } from "./db.js";
import { createMultiUserAuth, resolveBootstrapUserFields } from "./auth.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootstrap user fields", () => {
  it("assigns superadmin + approved to the first user", () => {
    expect(resolveBootstrapUserFields(0)).toEqual({
      approved: true,
      role: "superadmin",
    });
  });

  it("leaves later users unapproved with the default role", () => {
    expect(resolveBootstrapUserFields(1)).toEqual({ approved: false });
    expect(resolveBootstrapUserFields(5)).toEqual({ approved: false });
  });
});

describe("multi-user auth", () => {
  it("creates auth instance and runs Better Auth migrations", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-auth-"));
    tempDirs.push(tempDir);

    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      gateway: {
        port: 4123,
      },
      extensions: {
        multiUser: {
          enabled: true,
          oauth: {
            google: {
              clientId: "client-id",
              clientSecret: "client-secret",
            },
          },
          sessionSecret: "x".repeat(32),
        },
      },
    });

    const db = initializeMultiUserDatabase(path.join(tempDir, "auth.db"));
    const multiUserConfig = config.extensions?.multiUser;
    if (!multiUserConfig || !multiUserConfig.enabled) {
      throw new Error("multiUser config missing");
    }

    const auth = await createMultiUserAuth(config, multiUserConfig, db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;

    db.close();

    expect(typeof auth.handler).toBe("function");
    expect(typeof auth.api.getSession).toBe("function");
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "account",
        "agent_assignments",
        "session",
        "user",
        "verification",
      ])
    );
  });

  it("treats empty server.baseUrl / web.baseUrl as missing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-auth-"));
    tempDirs.push(tempDir);

    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      gateway: { port: 4124 },
      // Both baseUrls are empty strings (e.g. unset $env: ref): the auth
      // builder must fall back to the gateway default instead of letting
      // `new URL("")` blow up.
      server: { baseUrl: "" },
      web: { baseUrl: "   " },
      extensions: {
        multiUser: {
          enabled: true,
          oauth: {
            google: {
              clientId: "client-id",
              clientSecret: "client-secret",
            },
          },
          sessionSecret: "x".repeat(32),
        },
      },
    });

    const db = initializeMultiUserDatabase(path.join(tempDir, "auth.db"));
    const multiUserConfig = config.extensions?.multiUser;
    if (!multiUserConfig || !multiUserConfig.enabled) {
      throw new Error("multiUser config missing");
    }

    await expect(
      createMultiUserAuth(config, multiUserConfig, db)
    ).resolves.toBeDefined();

    db.close();
  });

  it("grants set-role only to superadmin (admins cannot escalate roles)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-auth-"));
    tempDirs.push(tempDir);

    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      gateway: { port: 4125 },
      extensions: {
        multiUser: {
          enabled: true,
          oauth: {
            google: { clientId: "client-id", clientSecret: "client-secret" },
          },
          sessionSecret: "x".repeat(32),
        },
      },
    });

    const db = initializeMultiUserDatabase(path.join(tempDir, "auth.db"));
    const multiUserConfig = config.extensions?.multiUser;
    if (!multiUserConfig || !multiUserConfig.enabled) {
      throw new Error("multiUser config missing");
    }

    const auth = await createMultiUserAuth(config, multiUserConfig, db);

    // Inspect the access-control roles the admin plugin was configured with.
    // The built-in `POST /api/auth/admin/set-role` endpoint authorizes
    // against these; without `set-role` an admin cannot bypass the custom
    // superadmin-guarded route to escalate roles.
    const options = (auth as unknown as { options: { plugins: Array<{
      id: string;
      options?: {
        roles?: Record<string, { authorize: (req: Record<string, string[]>) => { success: boolean } }>;
      };
    }> } }).options;
    const roles = options.plugins.find((p) => p.id === "admin")?.options?.roles;
    if (!roles) throw new Error("admin roles not configured");

    expect(roles.admin.authorize({ user: ["set-role"] }).success).toBe(false);
    expect(roles.superadmin.authorize({ user: ["set-role"] }).success).toBe(
      true
    );
    // `create` is superadmin-only too, so an admin cannot mint a new
    // superadmin via the built-in create-user endpoint.
    expect(roles.admin.authorize({ user: ["create"] }).success).toBe(false);
    expect(roles.superadmin.authorize({ user: ["create"] }).success).toBe(true);
    // Admin retains other staff powers (ban) but not admin impersonation.
    expect(roles.admin.authorize({ user: ["ban"] }).success).toBe(true);
    expect(
      roles.admin.authorize({ user: ["impersonate-admins"] }).success
    ).toBe(false);
    expect(
      roles.superadmin.authorize({ user: ["impersonate-admins"] }).success
    ).toBe(true);

    db.close();
  });
});
