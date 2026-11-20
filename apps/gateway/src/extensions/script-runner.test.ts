import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

let home: string;
let workspace: string;

async function configureAgent(extraYaml?: string, extraConfig?: Record<string, unknown>) {
  await writeTestV3Config(home, {
    agents: [{ id: "alpha", extraYaml }],
    extraConfig: { ...extraConfig, agents: [workspace] },
  });
  await fs.copyFile(path.join(home, "agents/alpha/agent.yaml"), path.join(workspace, "agent.yaml"));
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "script-runner-"));
  workspace = path.join(home, "workspaces", "alpha");
  await fs.mkdir(workspace, { recursive: true });
  vi.stubEnv("YOPLAI_HOME", home);
  vi.stubEnv("PATH", `${home}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("SCHEDULER_FIXTURE_CANARY", "invented-value");
  vi.resetModules();
  await configureAgent("sandbox:\n  enabled: true");

  // Model the Docker CLI lifecycle in a temporary directory. Start reads the
  // mounted fixture and uses only the environment explicitly set at create.
  await fs.writeFile(path.join(home, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [action, ...args] = process.argv.slice(2);
const home = ${JSON.stringify(home)};
const values = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
const state = (name) => path.join(home, name + '.json');
fs.appendFileSync(path.join(home, 'docker-actions'), action + '\\n');
if (action === 'create') {
  const env = Object.fromEntries(values('--env').map((entry) => {
    const separator = entry.indexOf('=');
    return separator === -1 ? [entry, process.env[entry]] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const create = JSON.stringify({ env, args });
  fs.writeFileSync(state(values('--name')[0]), create);
  fs.writeFileSync(path.join(home, 'last-create.json'), create);
} else if (action === 'network') {
  if (args[0] !== 'connect' || args[1] !== 'fixture-network' || !fs.existsSync(state(args.at(-1)))) process.exit(94);
  if (process.env.DOCKER_FIXTURE_ATTACH_FAIL) {
    console.error('fixture network unavailable');
    process.exit(1);
  }
} else if (action === 'start') {
  if (process.env.DOCKER_FIXTURE_START_FAIL) {
    console.error('fixture container cannot start');
    process.exit(1);
  }
  const { env, args: createArgs } = JSON.parse(fs.readFileSync(state(args.at(-1)), 'utf8'));
  const runtimePath = createArgs.at(-1);
  const prefix = '/workspace/data/';
  if (!runtimePath.startsWith(prefix)) process.exit(91);
  const dataMount = createArgs.find((argument) => argument.includes(',target=/workspace/data'));
  if (!dataMount) process.exit(92);
  const dataDir = dataMount.split(',')[1].slice('source='.length);
  const input = fs.readFileSync(0);
  const result = spawnSync('/bin/bash', [path.join(dataDir, runtimePath.slice(prefix.length))], { env, input });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
} else if (action === 'inspect') {
  console.log('created');
} else if (action === 'rm') {
  const retried = path.join(home, 'remove-retried');
  if (process.env.DOCKER_FIXTURE_REMOVE_RETRY && !fs.existsSync(retried)) {
    fs.writeFileSync(retried, '1');
    console.error('fixture Docker removal temporarily unavailable');
    process.exit(1);
  }
  fs.rmSync(state(args.at(-1)), { force: true });
} else {
  process.exitCode = 93;
}
`, { mode: 0o755 });
});

afterEach(async () => {
  const { terminateRunningScripts } = await import("@yoplai/shared/node/script");
  await terminateRunningScripts();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function context() {
  const { loadConfig } = await import("../config/index.js");
  const { createExtensionContext } = await import("./context.js");
  return createExtensionContext(loadConfig());
}

async function enableExtraNetwork() {
  const filename = path.join(home, "yoplai.json");
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  config.onecli = { enabled: false, gatewayUrl: "http://proxy.example.test", sandbox: { network: "fixture-network" } };
  await fs.writeFile(filename, JSON.stringify(config));
}

async function writeDataScript(name: string, content: string) {
  const dataDir = path.join(home, "agents", "alpha", "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, name), content);
}

async function dockerActions() {
  return (await fs.readFile(path.join(home, "docker-actions"), "utf8")).trim().split("\n");
}

async function containers() {
  return (await fs.readdir(home)).filter((file) => /^yoplai-script-.*\.json$/.test(file));
}

it("runs the mounted data script with stdin and an explicit environment", async () => {
  await enableExtraNetwork();
  await writeDataScript("marker.sh", `
    test -z "\${SCHEDULER_FIXTURE_CANARY+x}" || exit 11
    read -r payload
    printf '%s %s\\n' "$WEBHOOK_NAME" "$payload"
  `);
  const ctx = await context();
  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "./data/marker.sh", timeoutMs: 5000,
    stdin: "fixture-payload\n", env: { WEBHOOK_NAME: "fixture-hook" }, owner: "webhooks",
  })).resolves.toEqual({
    stdout: "fixture-hook fixture-payload\n", stderr: "", finalStdoutLine: "fixture-hook fixture-payload",
  });
  expect(await dockerActions()).toEqual(["create", "network", "start", "rm"]);
  expect(await containers()).toEqual([]);
});

it("removes the created container and skips start if the extra network cannot attach", async () => {
  await enableExtraNetwork();
  vi.stubEnv("DOCKER_FIXTURE_ATTACH_FAIL", "1");
  await writeDataScript("marker.sh", "echo fixture-ran\n");
  const ctx = await context();

  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "data/marker.sh", timeoutMs: 5000,
  })).rejects.toMatchObject({ reason: "spawn", message: expect.stringContaining("network attach failed") });
  expect(await dockerActions()).toEqual(["create", "network", "rm"]);
  expect(await containers()).toEqual([]);
});

it("reports a start failure and removes the created container", async () => {
  vi.stubEnv("DOCKER_FIXTURE_START_FAIL", "1");
  await writeDataScript("marker.sh", "echo fixture-ran\n");
  const ctx = await context();

  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "data/marker.sh", timeoutMs: 5000,
  })).rejects.toMatchObject({ reason: "spawn", message: expect.stringContaining("container start failed") });
  expect(await containers()).toEqual([]);
});

it.each([false, true])("mounts only the script runtime paths with workspaceWritable=%s", async (workspaceWritable) => {
  const shared = path.join(home, "shared");
  const ca = path.join(home, "fixture-ca.pem");
  await fs.mkdir(shared);
  await fs.mkdir(path.join(workspace, "mounted"));
  await fs.writeFile(ca, "fixture-ca");
  for (const file of ["AGENTS.md", ".env"]) await fs.writeFile(path.join(workspace, file), "");
  for (const file of ["models.json", "models-store.json"]) await fs.writeFile(path.join(home, file), "{}");
  await configureAgent(
    `sandbox:\n  enabled: true\n  workspaceWritable: ${workspaceWritable}\n  mounts:\n    - host: ${shared}\n      container: /workspace/mounted`,
    {
      sandbox: { sharedDir: shared, gatewayTransport: "socket", mountAllowlist: { allowedRoots: [home] } },
      onecli: { enabled: true, gatewayUrl: "http://proxy.example.test", ca: { source: "file", path: ca } },
    }
  );
  await writeDataScript("marker.sh", "echo fixture-ran\n");
  const ctx = await context();
  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "data/marker.sh", timeoutMs: 5000,
  })).resolves.toMatchObject({ stdout: "fixture-ran\n" });
  if (!workspaceWritable) expect((await fs.stat(path.join(workspace, "data"))).isDirectory()).toBe(true);

  const { args } = JSON.parse(await fs.readFile(path.join(home, "last-create.json"), "utf8")) as { args: string[] };
  const mounts = args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]] : []);
  expect(mounts.sort()).toEqual([
    `type=bind,source=${workspace},target=/workspace${workspaceWritable ? "" : ",readonly"}`,
    ...(workspaceWritable ? ["AGENTS.md", "agent.yaml"].map((file) =>
      `type=bind,source=${path.join(workspace, file)},target=/workspace/${file},readonly`) : []),
    `type=bind,source=${path.join(home, "agents/alpha/data")},target=/workspace/data`,
    `type=bind,source=${shared},target=/shared`,
    `type=bind,source=${shared},target=/workspace/mounted,readonly`,
    `type=bind,source=${ca},target=/usr/local/share/ca-certificates/onecli-ca.pem,readonly`,
    `type=bind,source=${path.join(home, "run/sandbox-gateway")},target=/run/yoplai,readonly`,
    "type=bind,source=/dev/null,target=/workspace/.env,readonly",
  ].sort());
});

it("keeps trusted scripts on the host with the existing environment", async () => {
  await configureAgent();
  await fs.writeFile(path.join(workspace, "marker.sh"), 'test "$SCHEDULER_FIXTURE_CANARY" = invented-value && echo host-marker\n');
  const ctx = await context();

  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "marker.sh", timeoutMs: 5000,
  })).resolves.toMatchObject({ stdout: "host-marker\n" });
  await expect(dockerActions()).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes the named container after a script timeout", async () => {
  vi.stubEnv("DOCKER_FIXTURE_REMOVE_RETRY", "1");
  await writeDataScript("slow.sh", "exec /bin/sleep 30\n");
  const ctx = await context();
  await expect(ctx.runAgentScript!({
    agentId: "alpha", workspaceDir: workspace, script: "data/slow.sh", timeoutMs: 1000,
  })).rejects.toMatchObject({ reason: "timeout" });

  expect(await dockerActions()).toEqual(["create", "start", "rm", "rm"]);
  expect(await containers()).toEqual([]);
});

it("terminates only webhook containers during an owner-scoped stop", async () => {
  await writeDataScript("job.sh", "exec /bin/sleep 30\n");
  await writeDataScript("hook.sh", "exec /bin/sleep 30\n");
  const ctx = await context();
  const { terminateRunningScripts } = await import("@yoplai/shared/node/script");
  const params = { agentId: "alpha", workspaceDir: workspace, timeoutMs: 30_000 };
  const job = ctx.runAgentScript!({ ...params, script: "data/job.sh" }).catch((error: unknown) => error);
  const hook = ctx.runAgentScript!({ ...params, script: "data/hook.sh", owner: "webhooks" }).catch((error: unknown) => error);
  await vi.waitFor(async () => expect((await dockerActions()).filter((action) => action === "start")).toHaveLength(2));

  await terminateRunningScripts("webhooks");
  expect(await hook).toMatchObject({ reason: "signal" });
  const remaining = await containers();
  expect(remaining).toHaveLength(1);
  expect(await fs.readFile(path.join(home, remaining[0]!), "utf8")).toContain("/workspace/data/job.sh");
  await terminateRunningScripts();
  expect(await job).toMatchObject({ reason: "signal" });
  expect(await containers()).toEqual([]);
});
