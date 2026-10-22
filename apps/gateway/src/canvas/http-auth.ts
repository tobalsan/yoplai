import type { DashboardActor } from "./policy.js";
import { loadConfig } from "../config/index.js";

type Auth = { user?: { id?: string } };

export async function resolveDashboardHttpActor(auth: unknown, agentId?: string): Promise<DashboardActor> {
  if (!loadConfig().extensions?.multiUser?.enabled) return { userId: "local", eligible: true, hasAgentAccess: true };
  const { getMultiUserRuntime, getEligibleAccount, hasAgentAccess } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  const userId = (auth as Auth | null)?.user?.id;
  const account = runtime && userId ? getEligibleAccount(runtime.db, userId, { approvalBypass: "superadmin" }) : undefined;
  const session = auth as Parameters<typeof hasAgentAccess>[0];
  const currentAuth = account && session ? { ...session, user: { ...session.user, role: account.role, approved: true } } : null;
  return { userId, eligible: !!account, superadmin: account?.role === "superadmin", hasAgentAccess: !!currentAuth && !!agentId && await hasAgentAccess(currentAuth, agentId) };
}

export async function listDashboardRecipients(): Promise<Array<{ id: string; name: string; email: string; image: string | null }>> {
  if (!loadConfig().extensions?.multiUser?.enabled) return [];
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  return getMultiUserRuntime()?.db.prepare("SELECT id, name, email, image FROM user WHERE COALESCE(banned, 0) = 0 AND (approved = 1 OR role = 'superadmin') ORDER BY name, email").all() as Array<{ id: string; name: string; email: string; image: string | null }> ?? [];
}

export async function dashboardOwnerName(userId: string): Promise<string> {
  if (userId === "local") return "You";
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const user = getMultiUserRuntime()?.db.prepare("SELECT name FROM user WHERE id = ?").get(userId) as { name?: string } | undefined;
  return user?.name || "Unknown user";
}

export async function authenticateDashboardRequest(request: Request): Promise<unknown | null> {
  const { validateWebSocketRequest, getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const authenticated = await validateWebSocketRequest(request);
  if (authenticated || request.headers.has("Authorization")) return authenticated;
  // A valid pending cookie session is still authenticated. Dashboard policy
  // returns not found for that account instead of sending it back to login.
  return getMultiUserRuntime()?.auth.api.getSession({ headers: request.headers }) ?? null;
}
