import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@yoplai/shared";
import { executeAgentUpdateInstructions, executeSharedUpdateSystemFile } from "./tools.js";

let home: string;
let workspace: string;
let config: GatewayConfig;
const fixture = vi.hoisted(() => ({ multiUser: false, db: undefined as Database.Database | undefined }));
vi.mock("../config/index.js", async (original) => ({
  ...await original<typeof import("../config/index.js")>(),
  loadConfig: () => ({ extensions: { multiUser: { enabled: fixture.multiUser } } }),
}));
vi.mock("../extensions/registry.js", async (original) => ({
  ...await original<typeof import("../extensions/registry.js")>(), isExtensionLoaded: () => fixture.multiUser,
}));
vi.mock("@yoplai/extension-multi-user", async (original) => ({
  ...await original<typeof import("@yoplai/extension-multi-user")>(),
  getMultiUserRuntime: () => fixture.db ? { db: fixture.db } : undefined,
}));

beforeEach(async () => {
  fixture.multiUser = false;
  fixture.db = new Database(":memory:");
  fixture.db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, approved INTEGER, role TEXT, banned INTEGER)");
  fixture.db.prepare("INSERT INTO user VALUES ('casey', 'casey@example.test', 1, 'user', 0)").run();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-instructions-"));
  workspace = path.join(home, "agents", "assistant");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Answer in English.\n");
  vi.stubEnv("YOPLAI_HOME", home);
  config = GatewayConfigSchema.parse({ agents: [{
    id: "assistant", name: "Assistant", workspace,
    model: { provider: "test", model: "test" },
  }] });
});

describe("shared_update_system_file", () => {
  it("does not report ignored AGENTS.md system_files entries as affected", async () => {
    await fs.mkdir(path.join(home, "shared"));
    await fs.writeFile(path.join(home, "shared", "AGENTS.md"), "Shared.\n");
    config.agents[0].system_files = ["$YOPLAI_HOME/shared/AGENTS.md"];
    const result = await executeSharedUpdateSystemFile({ file: "AGENTS.md", expected: "Shared.\n", content: "Changed.\n" }, {
      agentId: "assistant", source: "web", config,
    });
    expect(result.affectedAgents).toEqual([]);
  });
  it.each([
    { role: "user", source: "web", error: "Only superadmins can change shared system files." },
    { role: "admin", source: "web", error: "Only superadmins can change shared system files." },
    { role: "superadmin", source: "scheduler", error: "human chat requester" },
  ])("refuses shared changes from $role on $source", async ({ role, source, error }) => {
    fixture.multiUser = true;
    fixture.db?.prepare("UPDATE user SET role = ? WHERE id = 'casey'").run(role);
    await fs.mkdir(path.join(home, "shared"));
    await fs.writeFile(path.join(home, "shared", "company.md"), "Acme.\n");
    await expect(executeSharedUpdateSystemFile({ file: "company.md", expected: "Acme.\n", content: "Changed.\n" }, {
      agentId: "assistant", source, userId: "casey", config,
    })).rejects.toThrow(error);
    expect(await fs.readFile(path.join(home, "shared", "company.md"), "utf8")).toBe("Acme.\n");
  });
  it("lets a superadmin update a shared file after refusing stale expected text", async () => {
    fixture.multiUser = true;
    fixture.db?.prepare("UPDATE user SET role = 'superadmin' WHERE id = 'casey'").run();
    await fs.mkdir(path.join(home, "shared"));
    await fs.writeFile(path.join(home, "shared", "company.md"), "Acme.\n");
    const context = { agentId: "assistant", source: "web", userId: "casey", config };
    await expect(executeSharedUpdateSystemFile({ file: "company.md", expected: "Old.\n", content: "Changed.\n" }, context)).rejects.toThrow("file changed; re-read and retry");
    expect(await fs.readFile(path.join(home, "shared", "company.md"), "utf8")).toBe("Acme.\n");
    const result = await executeSharedUpdateSystemFile({ file: "company.md", expected: "Acme.\n", content: "Changed.\n" }, context);
    expect(await fs.readFile(path.join(home, "shared", "company.md"), "utf8")).toBe("Changed.\n");
    expect(result.diff).toContain("-Acme.\n+Changed.\n");
    expect(result.affectedAgents).toEqual([]);
  });
  it("refuses a symlink escape without changing its target", async () => {
    await fs.mkdir(path.join(home, "shared"));
    await fs.writeFile(path.join(home, "outside.md"), "Original.\n");
    await fs.symlink(path.join(home, "outside.md"), path.join(home, "shared", "company.md"));
    await expect(executeSharedUpdateSystemFile({ file: "company.md", expected: "Original.\n", content: "Changed.\n" }, {
      agentId: "assistant", source: "web", config,
    })).rejects.toThrow("symlink escapes");
    expect(await fs.readFile(path.join(home, "outside.md"), "utf8")).toBe("Original.\n");
  });
  it.each(["../x.md", "sub/x.md", "sub\\x.md", "x..md", "x.txt", "absent.md"])("refuses disallowed shared filename %s without changing files", async (file) => {
    await fs.mkdir(path.join(home, "shared", "sub"), { recursive: true });
    await fs.writeFile(path.join(home, "x.md"), "Original.\n");
    await fs.writeFile(path.join(home, "shared", "sub", "x.md"), "Original.\n");
    await fs.writeFile(path.join(home, "shared", "x.txt"), "Original.\n");
    await expect(executeSharedUpdateSystemFile({ file, expected: "Original.\n", content: "Changed.\n" }, {
      agentId: "assistant", source: "web", config,
    })).rejects.toThrow("existing .md file directly in the shared folder");
    expect(await fs.readFile(path.join(home, "x.md"), "utf8")).toBe("Original.\n");
    expect(await fs.readFile(path.join(home, "shared", "sub", "x.md"), "utf8")).toBe("Original.\n");
    expect(await fs.readFile(path.join(home, "shared", "x.txt"), "utf8")).toBe("Original.\n");
  });
  it("updates an existing shared file and lists agents loading its real path", async () => {
    await fs.mkdir(path.join(home, "shared"));
    await fs.writeFile(path.join(home, "shared", "company.md"), "Acme.\n");
    config.agents[0].system_files = ["$YOPLAI_HOME/shared/company.md"];
    config.agents.push({ ...config.agents[0], id: "reader", name: "Reader", system_files: ["../../shared/company.md"] });
    config.agents.push({ ...config.agents[0], id: "other", name: "Other", system_files: ["missing.md"] });
    const result = await executeSharedUpdateSystemFile({ file: "company.md", expected: "Acme.\n", content: "Acme France.\n" }, {
      agentId: "assistant", source: "web", config,
    });
    expect(await fs.readFile(path.join(home, "shared", "company.md"), "utf8")).toBe("Acme France.\n");
    expect(result.file).toBe("company.md");
    expect(result.diff).toContain("-Acme.\n+Acme France.\n");
    expect(result.affectedAgents).toEqual(["assistant", "reader"]);
  });
});
afterEach(async () => {
  fixture.db?.close();
  fixture.db = undefined;
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("agent_update_instructions", () => {
  it("accepts only one of two concurrent edits based on the same original text", async () => {
    const context = { agentId: "assistant", source: "web", config };
    const edits = await Promise.allSettled([
      executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Answer in French.\n" }, context),
      executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Answer in German.\n" }, context),
    ]);
    expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
    const rejected = edits.find((edit) => edit.status === "rejected");
    expect(rejected?.reason.message).toContain("file changed; re-read and retry");
    expect(["Answer in French.\n", "Answer in German.\n"]).toContain(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8"));
  });
  it("uses trusted container identity for host writes and refuses spoofed human identity", async () => {
    fixture.multiUser = true;
    fixture.db?.prepare("UPDATE user SET role = 'admin' WHERE id = 'casey'").run();
    const { createInternalTools } = await import("../server/internal-tools.js");
    const { registerContainerToken, removeContainerToken } = await import("../sdk/container/tokens.js");
    const app = createInternalTools({ getConfig: () => config });
    const dispatch = () => app.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      tool: "agent_update_instructions", agentToken: "instructions-fixture", agentId: "assistant", sessionId: "chat",
      args: { expected: "Answer in English.\n", content: "Answer in French.\n", source: "web", sender: undefined, userId: "casey" },
    }) });
    try {
      for (const identity of [
        { source: "scheduler", userId: "casey" },
        { source: "slack", userId: "casey", sender: { kind: "agent" } },
        { source: "slack", userId: undefined },
      ]) {
        registerContainerToken("instructions-fixture", { agentId: "assistant", sessionId: "chat", runId: "run", containerName: "offline", roots: { workspace, data: home, uploads: home }, background: true, ...identity });
        const denied = await dispatch();
        expect(denied.ok).toBe(false);
        expect((await denied.json() as { error: string }).error).toMatch(/human chat requester|use the web app or ask an admin/);
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in English.\n");
        removeContainerToken("instructions-fixture");
      }
      registerContainerToken("instructions-fixture", { agentId: "assistant", sessionId: "chat", userId: "casey", source: "slack", background: true, runId: "run", containerName: "offline", roots: { workspace, data: home, uploads: home } });
      const response = await dispatch();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ file: "AGENTS.md", diff: expect.stringContaining("-Answer in English.\n+Answer in French.\n") });
      expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in French.\n");
    } finally { removeContainerToken("instructions-fixture"); }
  });
  it.each(["admin", "superadmin"])("lets an eligible %s replace instructions", async (role) => {
    fixture.multiUser = true;
    fixture.db?.prepare("UPDATE user SET role = ? WHERE id = 'casey'").run(role);
    await executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Answer in French.\n" }, {
      agentId: "assistant", source: "web", userId: "casey", config,
    });
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in French.\n");
  });
  it.each(["web", "slack", "discord", "telegram", "mattermost", "irc", "threadit"])("allows a background human reply from %s", async (source) => {
    await executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Answer in French.\n" }, {
      agentId: "assistant", source, background: true, config,
    });
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in French.\n");
  });
  it("creates missing instructions only when expected is empty", async () => {
    await fs.rm(path.join(workspace, "AGENTS.md"));
    await expect(executeAgentUpdateInstructions({ expected: "Old.\n", content: "French.\n" }, {
      agentId: "assistant", source: "web", config,
    })).rejects.toThrow("file changed; re-read and retry");
    await executeAgentUpdateInstructions({ expected: "", content: "French.\n" }, {
      agentId: "assistant", source: "web", config,
    });
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("French.\n");
  });
  it.each([undefined, "missing", "casey"])("refuses multi-user requester %s without admin privileges", async (userId) => {
    fixture.multiUser = true;
    await expect(executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Changed.\n" }, {
      agentId: "assistant", source: "web", userId, config,
    })).rejects.toThrow(userId === "casey" ? "Only admins can change agent instructions; ask an admin." : "use the web app or ask an admin");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in English.\n");
  });
  it.each(["web", "slack", "discord", "telegram", "mattermost", "irc", "threadit"])("refuses an agent sender on %s", async (source) => {
    await expect(executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Changed.\n" }, {
      agentId: "assistant", source, sender: { kind: "agent" }, config,
    })).rejects.toThrow("human chat requester");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in English.\n");
  });
  it("replaces the calling agent's instructions for a single-user human chat and returns a unified diff", async () => {
    const result = await executeAgentUpdateInstructions({
      expected: "Answer in English.\n", content: "Answer in French.\n",
    }, { agentId: "assistant", source: "web", config });
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in French.\n");
    expect(result.file).toBe("AGENTS.md");
    expect(result.diff).toContain("--- AGENTS.md\n+++ AGENTS.md\n@@ -1,1 +1,1 @@\n-Answer in English.\n+Answer in French.\n");
  });
  it("refuses stale expected text without replacing the current instructions", async () => {
    await expect(executeAgentUpdateInstructions({ expected: "Outdated instructions.\n", content: "Answer in French.\n" }, {
      agentId: "assistant", source: "web", config,
    })).rejects.toThrow("file changed; re-read and retry");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in English.\n");
  });
  it.each(["scheduler", "webhook", "heartbeat", "dream", "orchestrator", undefined])("refuses a %s run even in single-user mode", async (source) => {
    await expect(executeAgentUpdateInstructions({ expected: "Answer in English.\n", content: "Changed.\n" }, {
      agentId: "assistant", source, actorKind: "local", config,
    })).rejects.toThrow("human chat requester");
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Answer in English.\n");
  });
});
