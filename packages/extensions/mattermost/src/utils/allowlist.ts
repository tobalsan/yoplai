/**
 * Allowlist entries are Mattermost user IDs or usernames (with or without a
 * leading `@`), compared case-insensitively. An empty or missing list matches
 * no one; callers decide whether "no list" means open or closed.
 */
export function matchesUserAllowlist(
  user: { id: string; username?: string },
  allowlist: string[] | undefined
): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const id = user.id.toLowerCase();
  const username = user.username?.toLowerCase();
  return allowlist.some((entry) => {
    const normalized = entry.trim().replace(/^@/, "").toLowerCase();
    return (
      normalized === id || (username !== undefined && normalized === username)
    );
  });
}
