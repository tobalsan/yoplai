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
  });

  it("writes a version 3 config with no agents and loopback bind when the config is missing", () => {
    const home = path.join(tempDir(), "new", "home");

    expect(seedHome(home)).toBe(true);

    expect(JSON.parse(fs.readFileSync(path.join(home, "yoplai.json"), "utf8"))).toEqual({
      version: 3,
      agents: [],
      gateway: { bind: "loopback" },
      ui: { bind: "loopback" },
    });
  });

  it("keeps an existing config", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, "yoplai.json"), '{"version":3,"agents":["x"]}');

    expect(seedHome(home)).toBe(false);

    expect(fs.readFileSync(path.join(home, "yoplai.json"), "utf8")).toBe('{"version":3,"agents":["x"]}');
  });

  it("keeps a legacy config file", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, "aihub.json"), '{"version":3}');

    expect(seedHome(home)).toBe(false);

    expect(fs.existsSync(path.join(home, "yoplai.json"))).toBe(false);
  });
});
