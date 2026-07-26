import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentConfigSchema,
  GlobalSandboxConfigSchema,
  type MountAllowlist,
} from "@yoplai/shared";
import {
  buildContainerArgs,
  buildVolumeMounts,
  filterSecretEnvVars,
  getAgentDataDir,
  getSessionUploadsDir,
  validateMount,
  type ContainerVolumeMount,
} from "./container.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-container-"));
  tempDirs.push(dir);
  return dir;
}

function argValues(args: string[], flag: string): string[] {
  return args
    .map((arg, index) => (arg === flag ? args[index + 1] : undefined))
    .filter((arg): arg is string => Boolean(arg));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildVolumeMounts", () => {
  it("builds standard, user, onecli, env shadow, and custom mounts", () => {
    const root = tmpDir();
    const workspace = path.join(root, "agents", "cloud");
    const shared = path.join(root, "shared");
    const homeDir = path.join(root, "yoplai");
    const custom = path.join(root, "docs");
    const caPath = path.join(root, "onecli-ca.pem");

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(workspace, ".env"), "SECRET=1");
    fs.writeFileSync(caPath, "cert");

    const agent = AgentConfigSchema.parse({
      id: "cloud",
      name: "Cloud",
      workspace,
      model: { provider: "anthropic", model: "claude" },
      sandbox: {
        mounts: [{ host: custom, container: "/docs", readonly: false }],
      },
    });
    const globalSandbox = GlobalSandboxConfigSchema.parse({
      sharedDir: shared,
      mountAllowlist: { allowedRoots: [root] },
    });
    const onecliConfig = {
      enabled: true,
      mode: "proxy" as const,
      gatewayUrl: "http://onecli:4141",
      ca: { source: "file" as const, path: caPath },
    };

    const mounts = buildVolumeMounts(
      agent,
      globalSandbox,
      homeDir,
      "user-1",
      onecliConfig
    );

    expect(mounts).toEqual(
      expect.arrayContaining<ContainerVolumeMount>([
        { source: workspace, target: "/workspace", readonly: true },
        {
          source: getAgentDataDir(homeDir, "cloud"),
          target: "/workspace/data",
          readonly: false,
        },
        { source: shared, target: "/shared", readonly: false },
        {
          source: path.join(homeDir, "sessions", "users", "user-1"),
          target: "/users/user-1",
          readonly: false,
        },
        {
          source: path.join(homeDir, "sessions", "cloud"),
          target: "/sessions",
          readonly: false,
        },
        {
          source: path.join(homeDir, "ipc", "cloud"),
          target: "/workspace/ipc",
          readonly: false,
        },
        {
          source: caPath,
          target: "/usr/local/share/ca-certificates/onecli-ca.pem",
          readonly: true,
        },
        { source: "/dev/null", target: "/workspace/.env", readonly: true },
        { source: custom, target: "/docs", readonly: false },
      ])
    );
  });

  it("uses a writable workspace mount when configured", () => {
    const root = tmpDir();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const agent = AgentConfigSchema.parse({
      id: "agent",
      name: "Agent",
      workspace,
      model: { provider: "anthropic", model: "claude" },
      sandbox: { workspaceWritable: true },
    });
    const mounts = buildVolumeMounts(agent, {}, path.join(root, "yoplai"));

    expect(mounts[0]).toEqual({
      source: workspace,
      target: "/workspace",
      readonly: false,
    });
  });

  it("adds a read-only uploads mount for a session", () => {
    const root = tmpDir();
    const workspace = path.join(root, "workspace");
    const homeDir = path.join(root, "yoplai");
    fs.mkdirSync(workspace, { recursive: true });

    const agent = AgentConfigSchema.parse({
      id: "agent",
      name: "Agent",
      workspace,
      model: { provider: "anthropic", model: "claude" },
    });

    const mounts = buildVolumeMounts(
      agent,
      {},
      homeDir,
      undefined,
      undefined,
      "session-1"
    );

    expect(mounts).toEqual(
      expect.arrayContaining<ContainerVolumeMount>([
        {
          source: getSessionUploadsDir(homeDir, "agent", "session-1"),
          target: "/workspace/uploads",
          readonly: true,
        },
      ])
    );
    expect(
      fs.existsSync(getSessionUploadsDir(homeDir, "agent", "session-1"))
    ).toBe(true);
  });
});

describe("filterSecretEnvVars", () => {
  it("filters secret keys and logs a warning for each", () => {
    const warn = vi.fn();

    const env = filterSecretEnvVars(
      {
        API_KEY: "safe-looking",
        SECRET_TOKEN: "value",
        ACCESS_KEY_ID: "abc",
        NODE_ENV: "production",
      },
      warn
    );

    expect(env).toEqual({ NODE_ENV: "production" });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toContain("API_KEY");
    expect(warn.mock.calls[1][0]).toContain("SECRET_TOKEN");
    expect(warn.mock.calls[2][0]).toContain("ACCESS_KEY_ID");
  });

  it("passes through safe keys", () => {
    const warn = vi.fn();

    const env = filterSecretEnvVars(
      {
        NODE_ENV: "production",
        DEBUG: "1",
        CUSTOM_VAR: "value",
      },
      warn
    );

    expect(env).toEqual({
      NODE_ENV: "production",
      DEBUG: "1",
      CUSTOM_VAR: "value",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("filters values that look like secrets even when key looks innocent", () => {
    const warn = vi.fn();

    const env = filterSecretEnvVars(
      {
        CUSTOM_VAR: "sk-live-1234567890",
        PLAINTEXT: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
        SAFE_FLAG: "true",
      },
      warn
    );

    expect(env).toEqual({ SAFE_FLAG: "true" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("CUSTOM_VAR");
    expect(warn.mock.calls[1][0]).toContain("PLAINTEXT");
  });

  it("returns empty record for undefined or empty env", () => {
    const warn = vi.fn();

    expect(filterSecretEnvVars(undefined, warn)).toEqual({});
    expect(filterSecretEnvVars({}, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("buildContainerArgs", () => {
  it("builds docker run args with mounts, resources, network, and env", () => {
    const agent = AgentConfigSchema.parse({
      id: "cloud",
      name: "Cloud",
      workspace: "/workspace",
      model: { provider: "anthropic", model: "claude" },
      sandbox: {
        image: "custom-agent:latest",
        network: "custom-net",
        memory: "4g",
        cpus: 2,
        env: { CUSTOM_VAR: "value" },
      },
    });
    const globalSandbox = GlobalSandboxConfigSchema.parse({
      network: { name: "yoplai-agents" },
    });
    const onecliConfig = {
      enabled: true,
      mode: "proxy" as const,
      gatewayUrl: "http://onecli:4141",
    };
    const mounts: ContainerVolumeMount[] = [
      { source: "/host/workspace", target: "/workspace", readonly: true },
      { source: "/host/shared", target: "/shared", readonly: false },
    ];

    const args = buildContainerArgs(
      agent,
      globalSandbox,
      mounts,
      "/yoplai",
      "user-1",
      onecliConfig
    );

    expect(args.slice(0, 3)).toEqual(["run", "-i", "--rm"]);
    expect(argValues(args, "--name")).toEqual([
      expect.stringMatching(
        /^yoplai-agent-cloud-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ),
    ]);
    expect(argValues(args, "--memory")).toEqual(["4g"]);
    expect(argValues(args, "--cpus")).toEqual(["2"]);
    expect(argValues(args, "--network")).toEqual(["custom-net"]);
    expect(argValues(args, "--mount")).toEqual([
      "type=bind,source=/host/workspace,target=/workspace,readonly",
      "type=bind,source=/host/shared,target=/shared",
    ]);
    expect(argValues(args, "--env")).toEqual(
      expect.arrayContaining([
        "NODE_TLS_REJECT_UNAUTHORIZED=0",
        "GATEWAY_URL=http://gateway:4000",
        "ONECLI_URL=http://onecli:4141",
        "HTTP_PROXY=http://onecli:4141",
        "HTTPS_PROXY=http://onecli:4141",
        "NO_PROXY=gateway,host.docker.internal,localhost,127.0.0.1",
        "CUSTOM_VAR=value",
      ])
    );
    expect(args.at(-1)).toBe("custom-agent:latest");
  });

  it("includes safe top-level config env in the container", () => {
    vi.spyOn(Date, "now").mockReturnValue(123456);

    const agent = AgentConfigSchema.parse({
      id: "cloud",
      name: "Cloud",
      workspace: "/workspace",
      model: { provider: "anthropic", model: "claude" },
      sandbox: {
        env: {
          SHARED_FLAG: "agent-override",
          AGENT_ONLY: "set",
        },
      },
    });

    const args = buildContainerArgs(
      agent,
      {},
      [],
      "/yoplai",
      undefined,
      undefined,
      {
        SHARED_FLAG: "global",
        GLOBAL_ONLY: "set",
        SECRET_TOKEN: "should-not-pass",
      }
    );

    expect(argValues(args, "--env")).toEqual(
      expect.arrayContaining([
        "GATEWAY_URL=http://gateway:4000",
        "GLOBAL_ONLY=set",
        "SHARED_FLAG=agent-override",
        "AGENT_ONLY=set",
      ])
    );
    expect(argValues(args, "--env")).not.toContain(
      "SECRET_TOKEN=should-not-pass"
    );
  });

  it("does not pass YOPLAI_HOME or per-agent .env secrets into sandbox env", () => {
    const root = tmpDir();
    const homeDir = path.join(root, "yoplai");
    const workspace = path.join(root, "agents", "cloud");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".env"),
      "GLOBAL_SECRET=home-secret\n"
    );
    fs.writeFileSync(
      path.join(workspace, ".env"),
      "SLACK_TOKEN=agent-secret\n"
    );

    const agent = AgentConfigSchema.parse({
      id: "cloud",
      name: "Cloud",
      workspace,
      model: { provider: "anthropic", model: "claude" },
      sandbox: {},
    });
    const mounts = buildVolumeMounts(agent, {}, homeDir);
    const args = buildContainerArgs(
      agent,
      {},
      mounts,
      homeDir,
      undefined,
      undefined,
      {
        SAFE_FLAG: "visible",
        GLOBAL_SECRET: "config-secret",
      }
    );

    expect(mounts).toEqual(
      expect.arrayContaining<ContainerVolumeMount>([
        { source: "/dev/null", target: "/workspace/.env", readonly: true },
      ])
    );
    expect(argValues(args, "--env")).toEqual(
      expect.arrayContaining([
        "GATEWAY_URL=http://gateway:4000",
        "SAFE_FLAG=visible",
      ])
    );
    expect(argValues(args, "--env")).not.toContain("SLACK_TOKEN=agent-secret");
    expect(argValues(args, "--env")).not.toContain("GLOBAL_SECRET=home-secret");
    expect(argValues(args, "--env")).not.toContain(
      "GLOBAL_SECRET=config-secret"
    );
  });

  it("omits onecli env when onecli config is absent", () => {
    vi.spyOn(Date, "now").mockReturnValue(123456);

    const agent = AgentConfigSchema.parse({
      id: "cloud",
      name: "Cloud",
      workspace: "/workspace",
      model: { provider: "anthropic", model: "claude" },
      sandbox: {},
    });

    const args = buildContainerArgs(agent, {}, [], "/yoplai");

    expect(argValues(args, "--env")).toEqual([
      "GATEWAY_URL=http://gateway:4000",
    ]);
  });
});

describe("validateMount", () => {
  const allowlist: MountAllowlist = {
    allowedRoots: [path.join(os.tmpdir(), "allowed-root")],
    blockedPatterns: [".ssh", ".aws", ".env"],
  };

  it("accepts allowed absolute mount paths", () => {
    expect(() =>
      validateMount(
        {
          host: path.join(allowlist.allowedRoots[0], "docs"),
          container: "/docs",
          readonly: true,
        },
        allowlist
      )
    ).not.toThrow();
  });

  it("rejects host paths outside the allowlist", () => {
    expect(() =>
      validateMount(
        { host: "/etc/passwd", container: "/passwd", readonly: true },
        allowlist
      )
    ).toThrow(/not allowed/);
  });

  it("rejects symlinks that escape the allowlist", () => {
    const root = tmpDir();
    const allowedRoot = path.join(root, "allowed");
    const outsideRoot = path.join(root, "outside");
    const outsidePath = path.join(outsideRoot, "secret");
    const symlinkPath = path.join(allowedRoot, "link");

    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
    fs.symlinkSync(outsidePath, symlinkPath);

    expect(() =>
      validateMount(
        { host: symlinkPath, container: "/docs", readonly: true },
        { ...allowlist, allowedRoots: [allowedRoot] }
      )
    ).toThrow(/not allowed/);
  });

  it.each([".ssh", ".aws", ".env"])(
    "rejects blocked host path pattern %s",
    (pattern) => {
      expect(() =>
        validateMount(
          {
            host: path.join(allowlist.allowedRoots[0], pattern, "data"),
            container: "/data",
            readonly: true,
          },
          allowlist
        )
      ).toThrow(/blocked pattern/);
    }
  );

  it("rejects path traversal in container paths", () => {
    expect(() =>
      validateMount(
        {
          host: path.join(allowlist.allowedRoots[0], "docs"),
          container: "/docs/../secrets",
          readonly: true,
        },
        allowlist
      )
    ).toThrow(/path traversal/);
  });

  it("rejects non-absolute container paths", () => {
    expect(() =>
      validateMount(
        {
          host: path.join(allowlist.allowedRoots[0], "docs"),
          container: "docs",
          readonly: true,
        },
        allowlist
      )
    ).toThrow(/absolute/);
  });
});
