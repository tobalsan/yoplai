import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ContainerInput } from "@yoplai/shared";
import { runAgent } from "../runner.js";

const loaded = vi.hoisted(() => ({ skills: [] as { name: string; filePath: string }[] }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => undefined, getModel: () => ({ provider: "offline", id: "fixture" }) }) },
  createAgentSession: async ({ resourceLoader }: { resourceLoader: ResourceLoader }) => {
    loaded.skills = resourceLoader.getSkills().skills;
    return { session: {
      systemPrompt: "Offline skill loading", messages: [], agent: { state: { messages: [] }, continue: async () => undefined },
      setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
      prompt: async () => undefined, sendUserMessage: async () => undefined,
      abort: async () => undefined, dispose: () => undefined,
    } };
  },
}));

let home: string | undefined;
afterEach(async () => { if (home) await fs.rm(home, { recursive: true, force: true }); home = undefined; });

it("loads mounted managed skills and preserves workspace skill precedence in the runner", async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-skills-"));
  const workspaceDir = path.join(home, "workspace");
  const managedSkillsDir = path.join(home, "managed");
  for (const [root, name, description] of [
    [managedSkillsDir, "managed-writing", "Managed guidance"],
    [managedSkillsDir, "legacy-writing", "Managed duplicate"],
    [path.join(workspaceDir, "skills"), "legacy-writing", "Legacy guidance"],
  ]) {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.`);
  }
  const input: ContainerInput = {
    agentId: "offline", sessionId: "test", message: "hello", workspaceDir, managedSkillsDir,
    sessionDir: path.join(home, "sessions"), ipcDir: path.join(home, "ipc"),
    gatewayUrl: "http://127.0.0.1", agentToken: "offline-fixture", toolDeferral: { enabled: false, alwaysOnTools: [], alwaysOnExtensions: [] },
    sdkConfig: { sdk: "pi", model: { provider: "offline", model: "fixture" } },
  };
  await runAgent(input);
  expect(loaded.skills.map((skill) => skill.name)).toContain("managed-writing");
  expect(loaded.skills.find((skill) => skill.name === "legacy-writing")?.filePath).toBe(path.join(workspaceDir, "skills/legacy-writing/SKILL.md"));
});
