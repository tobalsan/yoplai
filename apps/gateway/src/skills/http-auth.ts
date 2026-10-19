import { loadConfig } from "../config/index.js";

export async function listSkillRecipients(): Promise<{ id: string; name: string; email: string }[]> {
  if (!loadConfig().extensions?.multiUser?.enabled) return [];
  const { getMultiUserRuntime, getEligibleAccount } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  if (!runtime) return [];
  const users = runtime.db.prepare("SELECT id, name, email FROM user ORDER BY name, email").all() as { id: string; name: string; email: string }[];
  return users.filter((user) => getEligibleAccount(runtime.db, user.id));
}

export async function skillOwnerName(id: string): Promise<string> {
  if (id === "local") return "You";
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const user = getMultiUserRuntime()?.db.prepare("SELECT name FROM user WHERE id = ?").get(id) as { name?: string } | undefined;
  return user?.name || "Unknown user";
}
