import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasDesktopTurnAnswer } from "../history/store.js";

const active = new Map<string, Promise<boolean>>();

function recordPath(home: string, agentId: string, sessionId: string, turnId: string): string {
  const key = createHash("sha256").update(JSON.stringify([agentId, sessionId, turnId])).digest("hex");
  return path.join(home, "desktop-turns", key);
}

async function saveClaim(file: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // The directory is an exclusive claim with no message content.
    await fs.mkdir(file, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function claimDesktopTurn(home: string, agentId: string, sessionId: string, turnId: string) {
  const file = recordPath(home, agentId, sessionId, turnId);
  const previous = active.get(file);
  if (previous) {
    await previous;
    return undefined;
  }
  const claim = saveClaim(file);
  active.set(file, claim);
  const finish = () => {
    if (active.get(file) === claim) active.delete(file);
  };
  try {
    if (await claim) return finish;
  } catch (error) {
    finish();
    throw error;
  }
  finish();
  return undefined;
}

export async function desktopTurnState(home: string, agentId: string, sessionId: string, turnId: string) {
  const file = recordPath(home, agentId, sessionId, turnId);
  const claim = active.get(file);
  if (claim && await claim && active.get(file) === claim) return "running";
  try {
    await fs.access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
  return await hasDesktopTurnAnswer(agentId, sessionId, turnId) ? "answered" : "failed";
}
