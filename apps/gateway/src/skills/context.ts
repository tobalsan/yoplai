import { CONFIG_DIR, loadConfig } from "../config/index.js";
import { isExtensionLoaded } from "../extensions/registry.js";
import { getBuiltInSkillsDir } from "../sdk/pi/skills.js";
import { SkillStore } from "./store.js";
import { SkillAccessPolicy } from "./access.js";
import type { SkillActor } from "./types.js";

async function eligibleAccount(userId: string) {
  if (!isExtensionLoaded("multiUser")) return undefined;
  const { getMultiUserRuntime, getEligibleAccount } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  return runtime ? getEligibleAccount(runtime.db, userId) : undefined;
}

export async function getSkillContext() {
  const multiUser = loadConfig().extensions?.multiUser?.enabled === true;
  return {
    store: new SkillStore(CONFIG_DIR, { builtinsDir: getBuiltInSkillsDir() }),
    policy: new SkillAccessPolicy({ multiUser, getEligibleAccount: eligibleAccount }),
    multiUser,
  };
}

export async function resolveSkillActor(userId?: string): Promise<SkillActor | undefined> {
  if (loadConfig().extensions?.multiUser?.enabled !== true) return { userId: "local", role: "superadmin" };
  const account = userId ? await eligibleAccount(userId) : undefined;
  return account ? { userId: account.id, role: account.role } : undefined;
}
