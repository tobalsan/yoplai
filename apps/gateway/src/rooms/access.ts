export async function canUseRooms(userId: string | undefined, multiUser: boolean): Promise<boolean> {
  if (!multiUser) return userId === undefined;
  if (userId === undefined) return false;
  const { getMultiUserRuntime, getEligibleAccount } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  return !!runtime && !!getEligibleAccount(runtime.db, userId, { approvalBypass: "superadmin" });
}
