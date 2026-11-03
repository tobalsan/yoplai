import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, GatewayConfig } from "@yoplai/shared";
import { ensureAgentForksTable, ensureTeamMembersTable, ensureTeamsTable } from "../../../../packages/extensions/multi-user/src/db.js";
import { createForkStore } from "../../../../packages/extensions/multi-user/src/forks.js";
import { createMembershipStore } from "../../../../packages/extensions/multi-user/src/membership.js";
import { createAccessResolver } from "../../../../packages/extensions/multi-user/src/access.js";
import { setMultiUserRuntime, type MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { SchedulerService, clearSchedulerContext, setSchedulerContext } from "../../../../packages/extensions/scheduler/src/service.js";

it("rechecks owner account and agent membership before every script-only scheduled execution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-actor-"));
  const db = new Database(":memory:");
  let scheduler: SchedulerService | undefined;
  try {
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, approved INTEGER, role TEXT, banned INTEGER)");
    db.prepare("INSERT INTO user VALUES ('alice', 'Alice', 'alice@example.test', 1, 'user', 0)").run();
    ensureTeamsTable(db); ensureTeamMembersTable(db); ensureAgentForksTable(db);
    db.prepare("INSERT INTO teams (id, name, createdBy) VALUES ('team', 'Team', 'alice')").run();
    const source = path.join(home, "pool");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "agent.yaml"), "id: alpha\nname: Alpha\n");
    await fs.writeFile(path.join(source, "mark.sh"), "#!/bin/bash\nprintf fired >> marker.txt\n");
    const forks = createForkStore({ db, getForksDir: () => path.join(home, "agents"), getPoolAgent: () => ({ id: "alpha", workspaceDir: source }) });
    forks.setTeams("alpha", { mode: "list", teamIds: ["team"] }, "alice");
    const membership = createMembershipStore(db);
    membership.setMembers("team", { mode: "list", userIds: ["alice"] }, "alice");
    setMultiUserRuntime({ db, forks, membership, access: createAccessResolver({ membership, forks }), getPoolAgentIds: () => [] } as unknown as MultiUserRuntime);
    const agent = { id: "alpha", name: "Alpha", workspace: path.join(home, "agents", "alpha"), model: { provider: "test", model: "test" } } as AgentConfig;
    const config = { version: 3, agents: [agent], extensions: { multiUser: { enabled: true, sessionSecret: "test", emailAndPassword: { enabled: true } } } } as GatewayConfig;
    const mintToolToken = vi.fn(() => ({ token: "fixture-tool-token", gatewayUrl: "http://127.0.0.1:4000", revoke: vi.fn() }));
    setSchedulerContext({
      getConfig: () => config, getAgent: () => agent, getAgents: () => [agent], getDataDir: () => home, isAgentActive: () => true,
      resolveWorkspaceDir: () => agent.workspace, getDeliverySink: () => undefined,
      mintToolToken,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ExtensionContext);
    scheduler = new SchedulerService();
    const job = await scheduler.add("alpha", { name: "Owner script", credentialMode: "owner", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { script: "mark.sh", noAgent: true } }, "alice");
    expect((await scheduler.runNow("alpha", job.id)).status).toBe("ok");
    expect(mintToolToken).toHaveBeenCalledOnce();
    mintToolToken.mockClear();
    membership.setMembers("team", { mode: "list", userIds: [] }, "alice");
    expect(await scheduler.runNow("alpha", job.id)).toMatchObject({ status: "error", error: "Agent access denied" });
    expect(mintToolToken).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(agent.workspace, "marker.txt"), "utf8")).toBe("fired");
    membership.setMembers("team", { mode: "list", userIds: ["alice"] }, "alice");
    db.prepare("UPDATE user SET banned = 1 WHERE id = 'alice'").run();
    expect((await scheduler.runNow("alpha", job.id)).status).toBe("error");
    db.prepare("UPDATE user SET banned = 0, approved = 0, role = 'admin' WHERE id = 'alice'").run();
    expect((await scheduler.runNow("alpha", job.id)).status).toBe("error");
    db.prepare("UPDATE user SET role = 'superadmin' WHERE id = 'alice'").run();
    expect(mintToolToken).not.toHaveBeenCalled();
    expect((await scheduler.runNow("alpha", job.id)).status).toBe("ok");
    expect(mintToolToken).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(agent.workspace, "marker.txt"), "utf8")).toBe("firedfired");
  } finally {
    await scheduler?.stop(); clearSchedulerContext(); setMultiUserRuntime(null);
    db.close(); await fs.rm(home, { recursive: true, force: true });
  }
});
