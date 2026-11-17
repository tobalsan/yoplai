import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";
import type { FullHistoryMessage } from "@yoplai/shared";

type AuthContext = { user: { id: string; role: string }; session: { id: string; userId: string } } | null;
const state = vi.hoisted(() => ({ auth: null as AuthContext, multiUser: true }));
vi.mock("../extensions/registry.js", () => ({
  getLoadedExtensions: () => state.multiUser ? [{ id: "multiUser" }] : [],
  isExtensionLoaded: (id: string) => state.multiUser && id === "multiUser",
  isMultiUserLoaded: () => state.multiUser,
  getHomeExtension: () => undefined,
  getExtensionRuntime: () => ({ getCapabilities: () => ({}), getRouteMatchers: () => [], isEnabled: () => state.multiUser }),
}));
vi.mock("@yoplai/extension-multi-user", async (importOriginal) => ({
  ...await importOriginal<typeof import("@yoplai/extension-multi-user")>(),
  getForwardedAuthContext: () => state.auth,
  hasAgentAccess: async () => true,
}));

describe("chat share links", () => {
  let home: string;
  let previousEnv: Pick<NodeJS.ProcessEnv, "YOPLAI_HOME" | "HOME" | "USERPROFILE">;
  let api: typeof import("./api.core.js").api;
  let historyFile: string;
  const ownerRoute = "/agents/sales/sessions/chat-one/share";
  const initialHistory = [
    { type: "history", agentId: "sales", sessionId: "chat-one", role: "user", timestamp: 1, content: [{ type: "text", text: "What did we agree?" }] },
    { type: "history", agentId: "sales", sessionId: "chat-one", role: "assistant", timestamp: 2, content: [{ type: "text", text: "Ship on Friday." }] },
    { type: "meta", key: "title", value: "Launch decision", timestamp: 3 },
  ];

  function asUser(id: string) {
    state.auth = { user: { id, role: "user" }, session: { id: `auth-${id}`, userId: id } };
  }
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-chat-share-api-"));
    previousEnv = { YOPLAI_HOME: process.env.YOPLAI_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.YOPLAI_HOME = home;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await writeTestV3Config(home, { agents: [{ id: "sales", name: "Sales" }] });
    vi.resetModules();
    api = (await import("./api.core.js")).api;
    historyFile = path.join(home, "sessions", "users", "alice", "history", "sales-chat-one.jsonl");
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
  });
  beforeEach(async () => {
    state.multiUser = true;
    asUser("alice");
    await fs.writeFile(historyFile, initialHistory.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await fs.rm(path.join(home, "chat-shares.json"), { force: true });
  });
  afterAll(async () => {
    for (const key of ["YOPLAI_HOME", "HOME", "USERPROFILE"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  it("lets an owner create one stable URL-safe link and read its status", async () => {
    expect(await (await api.request(ownerRoute)).json()).toEqual({ shared: false });
    const created = await api.request(ownerRoute, { method: "PUT" });
    expect(created.status).toBe(200);
    const share = await created.json() as { shared: boolean; token: string };
    expect(share).toEqual({ shared: true, token: expect.stringMatching(/^[A-Za-z0-9_-]{43,}$/) });
    expect(await (await api.request(ownerRoute, { method: "PUT" })).json()).toEqual(share);
    expect(await (await api.request(ownerRoute)).json()).toEqual(share);
  });

  it("reads the owner's full persisted transcript, preserving tools and compaction but stripping system context", async () => {
    const records = [
      { role: "system", timestamp: 4, content: [{ type: "text", text: "System instructions" }], context: { kind: "web", name: "Alice", credentials: "private-context" } },
      { role: "assistant", timestamp: 5, content: [{ type: "toolCall", id: "call-one", name: "lookup", arguments: { query: "launch" } }] },
      { role: "toolResult", timestamp: 6, toolCallId: "call-one", toolName: "lookup", isError: false, content: [{ type: "text", text: "Friday confirmed" }], view: { server: "test", tool: "lookup", resourceUri: "ui://launch", recordId: "view-launch" } },
      { role: "system", timestamp: 7, content: [{ type: "text", text: "Compacted launch context" }], compaction: { id: "compact-one", coveredThrough: 6 } },
    ];
    await fs.appendFile(historyFile, records.map((entry) => JSON.stringify({ type: "history", agentId: "sales", sessionId: "chat-one", ...entry })).join("\n") + "\n");
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    asUser("bob");
    const response = await api.request(`/shared-chats/${token}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { agentId: string; agentName: string; title: string; messages: FullHistoryMessage[] };
    expect(Object.keys(body).sort()).toEqual(["agentId", "agentName", "messages", "title"]);
    expect(body).toMatchObject({ agentId: "sales", agentName: "Sales", title: "Launch decision" });
    expect(body.messages).toEqual([
      { role: "user", timestamp: 1, content: [{ type: "text", text: "What did we agree?" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Ship on Friday." }] },
      { role: "system", timestamp: 4, content: [{ type: "text", text: "System instructions" }] },
      { role: "assistant", timestamp: 5, content: [{ type: "toolCall", id: "call-one", name: "lookup", arguments: { query: "launch" } }] },
      { role: "toolResult", timestamp: 6, toolCallId: "call-one", toolName: "lookup", isError: false, content: [{ type: "text", text: "Friday confirmed" }], view: { server: "test", tool: "lookup", resourceUri: "ui://launch", recordId: "view-launch" } },
      { role: "system", timestamp: 7, content: [{ type: "text", text: "Compacted launch context" }], compaction: { id: "compact-one", coveredThrough: 6 } },
    ]);
    await fs.appendFile(historyFile, JSON.stringify({ type: "history", agentId: "sales", sessionId: "chat-one", role: "user", timestamp: 8, content: [{ type: "text", text: "Latest persisted turn" }] }) + "\n");
    const refreshed = await (await api.request(`/shared-chats/${token}`)).json() as { messages: FullHistoryMessage[] };
    expect(refreshed.messages.at(-1)).toEqual({ role: "user", timestamp: 8, content: [{ type: "text", text: "Latest persisted turn" }] });
  });

  it("revokes immediately and re-sharing leaves the old link dead", async () => {
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    const revoked = await api.request(ownerRoute, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ shared: false });
    expect(await (await api.request(ownerRoute)).json()).toEqual({ shared: false });
    asUser("bob");
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(404);
    asUser("alice");
    const next = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    expect(next.token).not.toBe(token);
    asUser("bob");
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(404);
    expect((await api.request(`/shared-chats/${next.token}`)).status).toBe(200);
  });

  it("keeps sharing status, creation and revocation scoped to the session owner", async () => {
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    asUser("bob");
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await api.request(ownerRoute, { method })).status).toBe(404);
    }
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(200);
    asUser("alice");
    expect(await (await api.request(ownerRoute)).json()).toEqual({ shared: true, token });
  });

  it("returns not found for unknown links and links whose session was deleted", async () => {
    expect((await api.request("/shared-chats/unknown-token")).status).toBe(404);
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    expect((await api.request("/agents/sales/sessions/chat-one", { method: "DELETE" })).status).toBe(200);
    asUser("bob");
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(404);
  });

  it("makes share routes unavailable in single-user mode", async () => {
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    state.multiUser = false;
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await api.request(ownerRoute, { method })).status).toBe(404);
    }
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(404);
  });

  it("does not grant the viewer access to an owner's registered file", async () => {
    const media = await import("../media/metadata.js");
    await media.ensureMediaDirectories();
    const fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const storedFilename = `${fileId}.txt`;
    const filePath = path.join(media.MEDIA_OUTBOUND_DIR, storedFilename);
    await fs.writeFile(filePath, "owner-only file");
    await media.registerMediaFile({ fileId, direction: "outbound", filename: "launch.txt", storedFilename, path: filePath, mimeType: "text/plain", size: 15, agentId: "sales", sessionId: "chat-one", userId: "alice" });
    const { token } = await (await api.request(ownerRoute, { method: "PUT" })).json() as { token: string };
    const ownerDownload = await api.request(`/media/download/${fileId}`);
    expect(ownerDownload.status).toBe(200);
    expect(await ownerDownload.text()).toBe("owner-only file");
    asUser("bob");
    expect((await api.request(`/shared-chats/${token}`)).status).toBe(200);
    expect((await api.request(`/media/download/${fileId}`)).status).toBe(403);
  });

  it("applies the existing session-id and active-agent checks to owner share routes", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await api.request("/agents/sales/sessions/invalid%2Fsession/share", { method })).status).toBe(400);
      expect((await api.request("/agents/missing/sessions/chat-one/share", { method })).status).toBe(404);
      expect((await api.request("/agents/sales/sessions/missing/share", { method })).status).toBe(404);
    }
  });
});
