import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("gateway graceful shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("closes the server without preempting the CLI shutdown handler", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-shutdown-"));
    const prevHomeDir = process.env.YOPLAI_HOME;
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;

    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "test-agent", name: "Test Agent" }],
    });

    const cleanupOrphanContainers = vi.fn();
    vi.doMock("../agents/container.js", async () => {
      const actual = await vi.importActual<
        typeof import("../agents/container.js")
      >("../agents/container.js");
      return {
        ...actual,
        cleanupOrphanContainers,
      };
    });

    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const { startServer } = await import("./index.js");
    const server = startServer(0, "127.0.0.1");
    const closeSpy = vi.spyOn(server, "close");

    const sigtermCall = onSpy.mock.calls.filter(([event]) => event === "SIGTERM").at(-1);
    const sigintCall = onSpy.mock.calls.filter(([event]) => event === "SIGINT").at(-1);

    expect(sigtermCall).toBeTruthy();
    expect(sigintCall).toBeTruthy();

    const shutdown = sigtermCall?.[1] as () => void;
    shutdown();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    if (sigtermCall) process.off("SIGTERM", sigtermCall[1]);
    if (sigintCall) process.off("SIGINT", sigintCall[1]);

    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
