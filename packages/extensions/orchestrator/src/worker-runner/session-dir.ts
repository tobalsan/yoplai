import fsSync from "node:fs";
import path from "node:path";

const warnedLegacySessionDirs = new Set<string>();

/**
 * Resolves the transcript directory a worker CLI should read/write session
 * files from: `<workspace>/.yoplai/<subdir>`. If that directory doesn't
 * exist yet but a pre-rename `<workspace>/.aihub/<subdir>` does, the legacy
 * directory (and any transcripts in it) is migrated into place once, so a
 * resumed run still finds its history and every later read/write lands
 * under the new name.
 */
export function resolveSessionDir(workspace: string, subdir: string): string {
  const sessionDir = path.join(workspace, ".yoplai", subdir);
  if (fsSync.existsSync(sessionDir)) return sessionDir;

  const legacyDir = path.join(workspace, ".aihub", subdir);
  if (fsSync.existsSync(legacyDir)) {
    fsSync.mkdirSync(path.dirname(sessionDir), { recursive: true });
    fsSync.renameSync(legacyDir, sessionDir);
    if (!warnedLegacySessionDirs.has(legacyDir)) {
      warnedLegacySessionDirs.add(legacyDir);
      console.warn(`[worker-runner] Migrated legacy session dir ${legacyDir} to ${sessionDir}.`);
    }
  }

  return sessionDir;
}
