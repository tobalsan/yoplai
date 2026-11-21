import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPackagedLaunchPlan } from "./launch-plan.js";
import { buildPackagedEnv, resolveHome, seedHome } from "./packaged-env.js";

const input = {
  parentEnv: {
    HOME: "/Users/test",
    USER: "test",
    LOGNAME: "test",
    SHELL: "/bin/zsh",
    TMPDIR: "/tmp/x",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TZ: "Europe/Paris",
    PATH: "/parent/bin",
    NODE_OPTIONS: "--conditions=development",
    YOPLAI_DEV: "1",
    WEB_DEV: "1",
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    YOPLAI_HOME: "/parent/home",
    ELECTRON_RUN_AS_NODE: "0",
  } as NodeJS.ProcessEnv,
  shellPath: "/probe/bin:/usr/bin",
  home: "/home/yoplai",
  ports: { gatewayPort: 4002, uiPort: 3001, appsPort: 4003 },
  resourcesPath: "/App/Contents/Resources",
  loopbackHost: "127.0.0.1",
};

describe("packaged env", () => {
  it("passes only the allowlisted names and the probed PATH", () => {
    const env = buildPackagedEnv(input);

    expect(env).toMatchObject({
      HOME: "/Users/test", USER: "test", LOGNAME: "test", SHELL: "/bin/zsh", TMPDIR: "/tmp/x",
      LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", LC_CTYPE: "UTF-8", TZ: "Europe/Paris",
      PATH: "/probe/bin:/usr/bin",
    });
    for (const name of ["NODE_OPTIONS", "YOPLAI_DEV", "WEB_DEV", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it("sets the values of the launcher last", () => {
    const env = buildPackagedEnv(input);

    expect(env).toMatchObject({
      YOPLAI_HOME: "/home/yoplai",
      YOPLAI_DESKTOP: "1",
      YOPLAI_GATEWAY_PORT: "4002",
      YOPLAI_UI_PORT: "3001",
      YOPLAI_APPS_PORT: "4003",
      YOPLAI_GATEWAY_HOST: "127.0.0.1",
      YOPLAI_UI_HOST: "127.0.0.1",
      YOPLAI_SKIP_WEB: "1",
      YOPLAI_WEB_DIST: "/App/Contents/Resources/web",
      YOPLAI_TEMPLATES_DIR: "/App/Contents/Resources/templates",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("starts the bundled gateway on the app runtime with absolute resource paths", () => {
    const plan = createPackagedLaunchPlan(input.ports, {
      execPath: "/App/Contents/MacOS/Yoplai",
      resourcesPath: input.resourcesPath,
      home: input.home,
      shellPath: input.shellPath,
      parentEnv: input.parentEnv,
    });

    expect(plan.uiUrl).toBe("http://127.0.0.1:3001");
    expect(plan.readyUrls).toEqual(["http://127.0.0.1:4002/health", "http://127.0.0.1:3001"]);
    expect(plan.children).toHaveLength(1);
    expect(plan.children[0]).toMatchObject({
      name: "gateway",
      command: "/App/Contents/MacOS/Yoplai",
      args: ["/App/Contents/Resources/gateway/dist/cli/index.js", "gateway", "--host", "127.0.0.1", "--port", "4002"],
      cwd: "/home/yoplai",
    });
  });
});

describe("home", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-home-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the app support folder and lets YOPLAI_HOME override it", () => {
    expect(resolveHome({}, "/Users/test/Library/Application Support")).toBe("/Users/test/Library/Application Support/Yoplai/home");
    expect(resolveHome({ YOPLAI_HOME: "  " }, "/support")).toBe("/support/Yoplai/home");
    expect(resolveHome({ YOPLAI_HOME: "/custom/home" }, "/support")).toBe("/custom/home");
    expect(resolveHome({ YOPLAI_HOME: "~/custom" }, "/support")).toBe(path.join(os.homedir(), "custom"));
  });

  it("writes a version 3 config with no agents and loopback bind when the config is missing", () => {
    const home = path.join(tempDir(), "new", "home");

    expect(seedHome(home)).toBe(true);

    expect(JSON.parse(fs.readFileSync(path.join(home, "yoplai.json"), "utf8"))).toEqual({
      version: 3,
      agents: "$YOPLAI_HOME/agents/*",
      gateway: { bind: "loopback" },
      ui: { bind: "loopback" },
      oauth: { encryptionKey: "$env:OAUTH_ENCRYPTION_KEY" },
    });
  });

  it("writes a random OAuth encryption key to .env, readable by the user only", () => {
    const first = tempDir();
    const second = tempDir();
    seedHome(first);
    seedHome(second);

    const envFile = path.join(first, ".env");
    const match = /^OAUTH_ENCRYPTION_KEY=([A-Za-z0-9_-]{43})\n$/.exec(fs.readFileSync(envFile, "utf8"));
    expect(match).not.toBeNull();
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(second, ".env"), "utf8")).not.toBe(fs.readFileSync(envFile, "utf8"));
  });

  it("keeps the other values of a .env that exists", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, ".env"), "OTHER=1\n");

    seedHome(home);

    expect(fs.readFileSync(path.join(home, ".env"), "utf8")).toMatch(/^OTHER=1\nOAUTH_ENCRYPTION_KEY=\S+\n$/);
  });

  it("keeps a quoted OAuth key already present before first run", () => {
    const home = tempDir();
    const envFile = path.join(home, ".env");
    const original = 'export OAUTH_ENCRYPTION_KEY="existing-key"\nOTHER=1';
    fs.writeFileSync(envFile, original);

    expect(seedHome(home)).toBe(true);
    expect(fs.readFileSync(envFile, "utf8")).toBe(original);
  });

  it("starts the new OAuth key on its own line when .env has no final newline", () => {
    const home = tempDir();
    const envFile = path.join(home, ".env");
    fs.writeFileSync(envFile, "OTHER=1");

    expect(seedHome(home)).toBe(true);
    expect(fs.readFileSync(envFile, "utf8")).toMatch(/^OTHER=1\nOAUTH_ENCRYPTION_KEY=[\w-]{43}\n$/);
  });

  it("keeps an existing config", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, "yoplai.json"), '{"version":3,"agents":["x"]}');

    expect(seedHome(home)).toBe(false);

    expect(fs.readFileSync(path.join(home, "yoplai.json"), "utf8")).toBe('{"version":3,"agents":["x"]}');
  });

  it.each(["yoplai.json", "aihub.json"])("changes only the empty agents array in %s", (name) => {
    const home = tempDir();
    const file = path.join(home, name);
    const config = { version: 3, agents: [], pool: "team/*", ui: { port: 3100 }, other: { value: true } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });

    expect(seedHome(home)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...config, agents: "$YOPLAI_HOME/agents/*" });
    expect(fs.readdirSync(home)).toEqual([name]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("migrates the target of a config link and keeps the link", () => {
    const home = tempDir();
    const targetDir = tempDir();
    const target = path.join(targetDir, "config.json");
    const link = path.join(home, "yoplai.json");
    const config = { version: 3, agents: [], pool: "team/*" };
    fs.writeFileSync(target, JSON.stringify(config));
    fs.symlinkSync(path.relative(home, target), link);

    expect(seedHome(home)).toBe(false);
    expect(fs.readlinkSync(link)).toBe(path.relative(home, target));
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ ...config, agents: "$YOPLAI_HOME/agents/*" });
    expect(fs.readdirSync(targetDir)).toEqual(["config.json"]);
  });

  it("keeps a legacy config file", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, "aihub.json"), '{"version":3}');

    expect(seedHome(home)).toBe(false);

    expect(fs.existsSync(path.join(home, "yoplai.json"))).toBe(false);
  });
});
