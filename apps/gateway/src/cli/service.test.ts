import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LABEL = "com.yoplai.gateway";
const LEGACY_LABEL = "com.aihub.gateway";

const launchd = vi.hoisted(() => ({
  loaded: new Set<string>(),
  calls: [] as string[][],
  failBootstrapFor: null as string | null,
}));

// No real launchctl ever runs: every invocation is served from `launchd`.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "/usr/local/bin/yoplai\n"),
  execFileSync: vi.fn((file: string, args: string[]) => {
    launchd.calls.push([file, ...args]);
    const [cmd, target, plistPath] = args;
    if (cmd === "print") {
      if (!launchd.loaded.has(target)) {
        throw Object.assign(new Error("Could not find service"), { status: 113 });
      }
      return `${target} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n`;
    }
    if (cmd === "bootstrap") {
      const label = path.basename(plistPath, ".plist");
      if (launchd.failBootstrapFor === label) {
        throw Object.assign(new Error("Bootstrap failed: 5: Input/output error"), {
          status: 5,
        });
      }
      launchd.loaded.add(`${target}/${label}`);
      return "";
    }
    if (cmd === "bootout") {
      launchd.loaded.delete(target);
      return "";
    }
    return "";
  }),
}));

const originalPlatform = process.platform;
const originalHome = process.env.HOME;
const originalConfigHome = process.env.YOPLAI_HOME;

let homeDir: string;
let logs: string[];
let warnings: string[];
let errors: string[];

function launchAgentsDir(): string {
  return path.join(homeDir, "Library", "LaunchAgents");
}

function plistPathFor(label: string): string {
  return path.join(launchAgentsDir(), `${label}.plist`);
}

function target(label: string): string {
  return `gui/${process.getuid?.() ?? ""}/${label}`;
}

function installPlist(label: string, loadIt: boolean): void {
  fs.mkdirSync(launchAgentsDir(), { recursive: true });
  fs.writeFileSync(plistPathFor(label), `<plist>${label}</plist>`);
  if (loadIt) launchd.loaded.add(target(label));
}

function callIndex(...parts: string[]): number {
  return launchd.calls.findIndex((call) =>
    parts.every((part) => call.includes(part))
  );
}

async function run(command: string): Promise<void> {
  vi.resetModules();
  const { registerGatewayServiceCommands } = await import("./service.js");
  const program = new Command();
  program.exitOverride();
  const gatewayCmd = program.command("gateway");
  registerGatewayServiceCommands(gatewayCmd);
  await program.parseAsync(["gateway", command], { from: "user" });
}

describe("gateway service launchd label", () => {
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-service-"));
    process.env.HOME = homeDir;
    process.env.YOPLAI_HOME = path.join(homeDir, ".yoplai");
    Object.defineProperty(process, "platform", { value: "darwin" });

    launchd.loaded.clear();
    launchd.calls.length = 0;
    launchd.failBootstrapFor = null;

    logs = [];
    warnings = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = originalConfigHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  describe("legacy-only install (pre-rename service)", () => {
    it("status reports the running legacy job and warns once", async () => {
      installPlist(LEGACY_LABEL, true);

      await run("status");

      expect(logs.join("\n")).toContain(LEGACY_LABEL);
      expect(logs.join("\n")).toContain("running pid 4242");
      expect(logs.join("\n")).not.toContain("not installed");
      expect(warnings.filter((w) => w.includes(LEGACY_LABEL))).toHaveLength(1);
    });

    it("stop boots out the legacy job", async () => {
      installPlist(LEGACY_LABEL, true);

      await run("stop");

      expect(callIndex("bootout", target(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(launchd.loaded.has(target(LEGACY_LABEL))).toBe(false);
      expect(logs).toContain(`Stopped: ${LEGACY_LABEL}`);
    });

    it("start bootstraps the legacy plist that is on disk", async () => {
      installPlist(LEGACY_LABEL, false);

      await run("start");

      expect(callIndex("bootstrap", plistPathFor(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(callIndex("kickstart", target(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(logs).toContain(`Started: ${LEGACY_LABEL}`);
    });

    it("restart kickstarts the legacy job", async () => {
      installPlist(LEGACY_LABEL, true);

      await run("restart");

      expect(callIndex("kickstart", target(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(logs).toContain(`Restarted: ${LEGACY_LABEL}`);
    });

    it("uninstall boots out and removes the legacy install", async () => {
      installPlist(LEGACY_LABEL, true);

      await run("uninstall");

      expect(callIndex("bootout", target(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(plistPathFor(LEGACY_LABEL))).toBe(false);
      expect(logs).toContain(`Uninstalled: ${LEGACY_LABEL}`);
    });

    it("stops a loaded legacy job whose plist was already deleted", async () => {
      launchd.loaded.add(target(LEGACY_LABEL));

      await run("stop");

      expect(callIndex("bootout", target(LEGACY_LABEL))).toBeGreaterThanOrEqual(0);
      expect(logs).toContain(`Stopped: ${LEGACY_LABEL}`);
    });

    it("install migrates to the new label without ever loading both jobs", async () => {
      installPlist(LEGACY_LABEL, true);

      await run("install");

      const bootoutLegacy = callIndex("bootout", target(LEGACY_LABEL));
      const bootstrapNew = callIndex("bootstrap", plistPathFor(LABEL));
      expect(bootoutLegacy).toBeGreaterThanOrEqual(0);
      expect(bootstrapNew).toBeGreaterThan(bootoutLegacy);

      expect(launchd.loaded.has(target(LABEL))).toBe(true);
      expect(launchd.loaded.has(target(LEGACY_LABEL))).toBe(false);
      expect(fs.existsSync(plistPathFor(LABEL))).toBe(true);
      expect(fs.existsSync(plistPathFor(LEGACY_LABEL))).toBe(false);
      expect(logs).toContain(`Migrated:  ${LEGACY_LABEL} -> ${LABEL}`);
      expect(fs.readFileSync(plistPathFor(LABEL), "utf-8")).toContain(
        `<string>${LABEL}</string>`
      );
    });

    it("rolls back to the legacy install when the new bootstrap fails", async () => {
      installPlist(LEGACY_LABEL, true);
      launchd.failBootstrapFor = LABEL;

      await expect(run("install")).rejects.toThrow("process.exit(1)");

      // Legacy install survives intact; the half-written new plist is gone.
      expect(fs.existsSync(plistPathFor(LEGACY_LABEL))).toBe(true);
      expect(fs.existsSync(plistPathFor(LABEL))).toBe(false);
      expect(launchd.loaded.has(target(LEGACY_LABEL))).toBe(true);
      expect(launchd.loaded.has(target(LABEL))).toBe(false);
      expect(errors.join("\n")).toContain("rolled back to the legacy service");
    });
  });

  describe("new-only install", () => {
    it("status reports the new label with no legacy warning", async () => {
      installPlist(LABEL, true);

      await run("status");

      expect(logs.join("\n")).toContain(LABEL);
      expect(logs.join("\n")).toContain("running pid 4242");
      expect(warnings.join("\n")).not.toContain(LEGACY_LABEL);
      expect(logs.join("\n")).not.toContain(LEGACY_LABEL);
    });

    it("stop and uninstall operate on the new label", async () => {
      installPlist(LABEL, true);

      await run("stop");
      expect(callIndex("bootout", target(LABEL))).toBeGreaterThanOrEqual(0);

      installPlist(LABEL, true);
      await run("uninstall");
      expect(fs.existsSync(plistPathFor(LABEL))).toBe(false);
      expect(logs).toContain(`Uninstalled: ${LABEL}`);
    });
  });

  describe("both labels present", () => {
    it("never lets the legacy plist shadow the new install", async () => {
      installPlist(LABEL, true);
      installPlist(LEGACY_LABEL, false);

      await run("stop");

      expect(callIndex("bootout", target(LABEL))).toBeGreaterThanOrEqual(0);
      expect(callIndex("bootout", target(LEGACY_LABEL))).toBe(-1);
      expect(logs).toContain(`Stopped: ${LABEL}`);
    });

    it("status flags the leftover legacy install", async () => {
      installPlist(LABEL, true);
      installPlist(LEGACY_LABEL, false);

      await run("status");

      expect(logs.join("\n")).toContain(`Service  ${LABEL}`);
      expect(logs.join("\n")).toContain(`${LEGACY_LABEL} also present`);
    });

    it("uninstall removes both rather than silently picking one", async () => {
      installPlist(LABEL, true);
      installPlist(LEGACY_LABEL, true);

      await run("uninstall");

      expect(fs.existsSync(plistPathFor(LABEL))).toBe(false);
      expect(fs.existsSync(plistPathFor(LEGACY_LABEL))).toBe(false);
      expect(launchd.loaded.size).toBe(0);
      expect(logs).toContain(`Uninstalled: ${LABEL}`);
      expect(logs).toContain(`Uninstalled: ${LEGACY_LABEL}`);
    });
  });

  describe("nothing installed", () => {
    it("status reports not installed under the new label", async () => {
      await run("status");

      expect(logs.join("\n")).toContain("not installed");
      expect(logs.join("\n")).toContain(LABEL);
      expect(warnings.join("\n")).not.toContain(LEGACY_LABEL);
    });

    it("uninstall is a no-op", async () => {
      await run("uninstall");

      expect(logs).toContain(`No plist at ${plistPathFor(LABEL)}`);
      expect(logs).toContain(`Uninstalled: ${LABEL}`);
    });
  });
});
