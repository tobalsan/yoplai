import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { createMultiUserAuth } from "../../../../packages/extensions/multi-user/src/auth.js";
import { initializeMultiUserDatabase } from "../../../../packages/extensions/multi-user/src/db.js";
import { setMultiUserRuntime, type MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { authenticateDashboardRequest, resolveDashboardHttpActor } from "./http-auth.js";
import { createDashboardRoutes } from "./routes.js";
import { DashboardRegistry } from "./store.js";

vi.mock("../config/index.js", async (original) => ({
  ...await original<typeof import("../config/index.js")>(),
  loadConfig: () => ({ extensions: { multiUser: { enabled: true } } }),
}));

it("a real authenticated pending session gets not found instead of being treated as logged out", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-pending-session-"));
  const db = initializeMultiUserDatabase(root);
  try {
    const config = GatewayConfigSchema.parse({ version: 2, agents: [], gateway: { port: 4999 }, canvas: { enabled: true }, extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, autoApprove: false, sessionSecret: "isolated-auth-test-secret-32-characters" } } });
    const multiUser = config.extensions?.multiUser;
    if (!multiUser?.enabled) throw new Error("Expected multi-user fixture");
    const auth = await createMultiUserAuth(config, multiUser, db);
    setMultiUserRuntime({ auth, db } as unknown as MultiUserRuntime);
    const signup = (email: string) => auth.handler(new Request("http://127.0.0.1:4999/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4999" }, body: JSON.stringify({ email, name: "Test user", password: "dummy-password-for-isolated-test" }) }));
    expect((await signup("bootstrap@example.test")).status).toBe(200);
    const pending = await signup("pending@example.test");
    expect(pending.status).toBe(200);
    const cookie = pending.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) });
    expect(session?.user.email).toBe("pending@example.test");
    const registry = new DashboardRegistry(path.join(root, "canvas", "registry.json"));
    const entry = await registry.createOwned("agent", "private.html", "owner", "PRIVATE");
    const routes = createDashboardRoutes({ getConfig: () => config, getAgent: () => undefined, registry, authenticate: authenticateDashboardRequest, resolveActor: resolveDashboardHttpActor, hasAgentAccess: async () => false, sessionExists: async () => false });
    const response = await routes.request(`/${entry.id}`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  } finally {
    setMultiUserRuntime(null);
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
