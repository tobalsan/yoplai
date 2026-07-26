// Worker processes (or user hooks) may still read the pre-rename AIHUB_* names, so every
// YOPLAI_* var handed to a spawned worker is mirrored under its legacy AIHUB_* name too.
function withLegacyEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const mirrored: Record<string, string | undefined> = { ...extra };
  for (const [key, value] of Object.entries(extra)) {
    if (!key.startsWith("YOPLAI_")) continue;
    const legacyKey = `AIHUB_${key.slice("YOPLAI_".length)}`;
    if (!(legacyKey in mirrored)) mirrored[legacyKey] = value;
  }
  return mirrored;
}

export function sanitizedWorkerEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...withLegacyEnv(extra) };
  delete env.LINEAR_API_KEY;
  delete env.PLANE_API_KEY;
  delete env.PLANE_OAUTH_TOKEN;
  delete env.PLANE_BOT_TOKEN;
  return env;
}
