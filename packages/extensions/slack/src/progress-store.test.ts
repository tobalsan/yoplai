import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackProgressStore } from "./progress-store.js";

describe("Slack progress store", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
  });

  it("recovers an unfinished message and retains records whose update fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-progress-"));
    dirs.push(dir);
    const store = new SlackProgressStore(dir);
    await store.add({ owner: "bot", channel: "C1", ts: "1.0", updatedAt: Date.now() });
    await store.add({ owner: "bot", channel: "C2", ts: "2.0", updatedAt: Date.now() });
    const update = vi.fn().mockImplementation(async ({ ts }: { ts: string }) => {
      if (ts === "2.0") throw new Error("temporary");
    });

    await store.recover(["bot"], update);

    expect(update).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(path.join(dir, "progress-messages.json"), "utf8"))).toEqual([
      expect.objectContaining({ ts: "2.0" }),
    ]);
  });
});
