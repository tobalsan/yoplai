import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LeadSession } from "@yoplai/shared";
import {
  readLeadSessionsForProject,
  updateLeadSessionInProject,
  writeLeadSessionsForProject,
} from "./store.js";

function session(id: string): LeadSession {
  return {
    id,
    projectId: "PRO-1",
    agentId: "cloud",
    kind: "lead",
    title: "New session",
    titleLocked: false,
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    transcriptRef: id.replaceAll(":", "-"),
  };
}

describe("lead session store", () => {
  it("serializes concurrent index mutations", async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-lead-sessions-")
    );
    await writeLeadSessionsForProject(projectDir, [
      session("lead:PRO-1:first"),
      session("lead:PRO-1:second"),
    ]);

    await Promise.all([
      updateLeadSessionInProject(projectDir, "lead:PRO-1:first", (current) => ({
        ...current,
        title: "First updated",
      })),
      updateLeadSessionInProject(
        projectDir,
        "lead:PRO-1:second",
        (current) => ({ ...current, title: "Second updated" })
      ),
    ]);

    const sessions = await readLeadSessionsForProject({
      id: "PRO-1",
      absolutePath: projectDir,
    });
    expect(sessions.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "lead:PRO-1:first", title: "First updated" },
      { id: "lead:PRO-1:second", title: "Second updated" },
    ]);
  });
});
