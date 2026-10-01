import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateToolLabel,
  readToolLabels,
  resetToolLabelDepsForTests,
  setToolLabelDepsForTests,
} from "./tool-labels.js";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-labels-"));
  filePath = path.join(dir, "tool-labels.json");
});
afterEach(async () => {
  resetToolLabelDepsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("tool label generation", () => {
  it("stores a validated template", async () => {
    const complete = vi.fn().mockResolvedValue('"Fetched {id}"');
    setToolLabelDepsForTests({ filePath, complete, hasMaintenanceModel: () => true });
    const params = { agentId: "a", toolName: "get_thing", args: { id: 1 } };
    expect(await generateToolLabel(params)).toBe("Fetched {id}");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      get_thing: "Fetched {id}",
    });
    expect(await readToolLabels()).toEqual({ get_thing: "Fetched {id}" });
    // already stored: no second call
    expect(await generateToolLabel(params)).toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("passes the run session id so session-routed providers accept it", async () => {
    const complete = vi.fn().mockResolvedValue("Did thing");
    setToolLabelDepsForTests({ filePath, complete, hasMaintenanceModel: () => true });
    await generateToolLabel({ agentId: "a", sessionId: "s1", toolName: "t", args: {} });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1" })
    );
  });

  it("never generates templates for built-in tools", async () => {
    const complete = vi.fn().mockResolvedValue("Ran bash command");
    setToolLabelDepsForTests({ filePath, complete, hasMaintenanceModel: () => true });
    expect(
      await generateToolLabel({ agentId: "a", toolName: "bash", args: { command: "ls" } })
    ).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("dedupes in-flight generation", async () => {
    let release!: (value: string) => void;
    const complete = vi.fn(
      () => new Promise<string>((resolve) => (release = resolve))
    );
    setToolLabelDepsForTests({ filePath, complete, hasMaintenanceModel: () => true });
    const params = { agentId: "a", toolName: "t", args: {} };
    const first = generateToolLabel(params);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(await generateToolLabel(params)).toBeNull();
    release("Did thing");
    expect(await first).toBe("Did thing");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown placeholders and skips without maintenance model", async () => {
    const complete = vi.fn().mockResolvedValue("Fetched {bogus}");
    setToolLabelDepsForTests({ filePath, complete, hasMaintenanceModel: () => true });
    expect(
      await generateToolLabel({ agentId: "a", toolName: "t", args: { id: 1 } })
    ).toBeNull();
    expect(await readToolLabels()).toEqual({});

    const skipped = vi.fn();
    setToolLabelDepsForTests({ filePath, complete: skipped, hasMaintenanceModel: () => false });
    await generateToolLabel({ agentId: "a", toolName: "t", args: {} });
    expect(skipped).not.toHaveBeenCalled();
  });
});
