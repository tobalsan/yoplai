import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAgentContext } from "@yoplai/shared";

const { resolveSessionProject, get, listFiles, listReferences, getNotes } = vi.hoisted(() => ({ resolveSessionProject: vi.fn(), get: vi.fn(), listFiles: vi.fn(), listReferences: vi.fn(), getNotes: vi.fn() }));
vi.mock("../history/store.js", () => ({ resolveSessionProject }));
vi.mock("../config/index.js", () => ({ CONFIG_DIR: "/tmp/context-test" }));
vi.mock("./store.js", () => ({
  isSafeChatProjectId: (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id),
  ChatProjectStore: class { get = get; listFiles = listFiles; listReferences = listReferences; getNotes = getNotes; filesDirectory = () => "/tmp/context-test/files"; },
}));
import { ProjectContextResolver } from "./context-resolver.js";

describe("ProjectContextResolver", () => {
  beforeEach(() => { vi.clearAllMocks(); listFiles.mockResolvedValue([]); listReferences.mockResolvedValue([]); getNotes.mockResolvedValue(""); });
  it("omits project context outside a project", async () => {
    resolveSessionProject.mockResolvedValue(null);
    expect(await new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "chat" })).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
  it("strips supplied stale project memory outside projects and after deletion, preserving user context", async () => {
    const context = { kind: "web" as const, name: "Alice", project: { id: "stale", instructions: "Private instructions", notes: "Private memory" } };
    const resolver = new ProjectContextResolver();
    resolveSessionProject.mockResolvedValue(null);
    expect(await resolver.resolve({ agentId: "sally", sessionId: "removed", context })).toEqual({ kind: "web", name: "Alice" });
    resolveSessionProject.mockResolvedValue("deleted");
    get.mockResolvedValue(null);
    expect(await resolver.resolve({ agentId: "casey", sessionId: "deleted", context })).toEqual({ kind: "web", name: "Alice" });
    expect(context.project.notes).toBe("Private memory");
  });

  it("resolves membership and edited instructions each turn, including moved chats", async () => {
    const resolver = new ProjectContextResolver();
    resolveSessionProject.mockResolvedValue("research");
    get.mockResolvedValue({ instructions: "Use primary sources." });
    const context = await resolver.resolve({ agentId: "alpha", sessionId: "chat", userId: "alice", context: { kind: "web", name: "Alice" } });
    const text = renderAgentContext(context!);
    expect(text).toContain("Use primary sources.");
    expect(text).toContain("from the project instructions, files and notes, look for additional useful wiki sources and propose adding them as project references");
    expect(text.match(/\[PROJECT CONTEXT\]/g)).toHaveLength(1);
    expect(text).not.toContain("research");
    resolveSessionProject.mockResolvedValue("work");
    get.mockResolvedValue({ instructions: "Be concise." });
    expect(await resolver.resolve({ agentId: "alpha", sessionId: "chat" })).toMatchObject({ project: { instructions: "Be concise." } });
    resolveSessionProject.mockResolvedValue(null);
    expect(await resolver.resolve({ agentId: "alpha", sessionId: "chat" })).toBeUndefined();
  });
  it("includes small text and large file names within budget, refreshing deletions next turn", async () => {
    resolveSessionProject.mockResolvedValue("work");
    get.mockResolvedValue({ instructions: "Read files." });
    const small = { id: "small", name: "notes.txt", size: 12, text: "Useful notes" };
    const large = { id: "large", name: "book.txt", size: 5000, text: "x".repeat(5000) };
    listFiles.mockResolvedValue([small, large]);
    const resolver = new ProjectContextResolver();
    const result = await resolver.resolve({ agentId: "alpha", sessionId: "chat" });
    expect(result?.project?.files).toContain("Useful notes");
    expect(result?.project?.files).toContain("book.txt");
    expect(result?.project?.files).not.toContain(large.text);
    expect(result?.project?.filesPath).toBe("/tmp/context-test/files");
    listFiles.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ ...small, id: String(index), text: "z".repeat(4000) })));
    const many = (await resolver.resolve({ agentId: "alpha", sessionId: "chat" }))?.project?.files ?? "";
    expect(Buffer.byteLength(many, "utf8")).toBeLessThanOrEqual(12000);
    expect(many).toContain("notes.txt (99, 12 bytes)");
    expect(many.match(/notes\.txt \(/g)).toHaveLength(100);
    expect(many).not.toContain("Additional files omitted");
    listFiles.mockResolvedValue(Array.from({ length: 20 }, (_, index) => ({ ...small, id: String(index), text: "😀".repeat(1900) })));
    const unicode = (await resolver.resolve({ agentId: "alpha", sessionId: "chat" }))?.project?.files ?? "";
    expect(Buffer.byteLength(unicode, "utf8")).toBeLessThanOrEqual(12000);
    expect(unicode).toContain("notes.txt (0, 12 bytes)");
    expect(unicode).toContain("notes.txt (19, 12 bytes)");
    expect(unicode.match(/notes\.txt \(/g)).toHaveLength(20);
    expect(unicode).toContain("😀");
    expect(unicode).not.toContain("Additional files omitted");
    expect(unicode).not.toContain("�");
    listFiles.mockResolvedValue([]);
    expect((await resolver.resolve({ agentId: "alpha", sessionId: "chat" }))?.project?.files).toBe("");
  });

  it("omits files only when their headers alone exceed the byte budget", async () => {
    resolveSessionProject.mockResolvedValue("work");
    get.mockResolvedValue({ instructions: "Read files." });
    listFiles.mockResolvedValue([
      { id: "first", name: "first.txt", size: 3, text: "optional text" },
      ...Array.from({ length: 100 }, (_, index) => ({ id: String(index), name: "x".repeat(196) + ".txt", size: 3 })),
      { id: "last", name: "last.txt", size: 3 },
    ]);
    const files = (await new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "chat" }))?.project?.files ?? "";
    expect(Buffer.byteLength(files, "utf8")).toBeLessThanOrEqual(12000);
    expect(files).toContain("first.txt (first, 3 bytes)");
    expect(files).toContain("Additional files omitted from context; inspect the project files directory.");
    expect(files).not.toContain("last.txt (last, 3 bytes)");
    expect(files).not.toContain("optional text");
  });

  it("refreshes shared references and the bounded notes tail across agents including reference paths", async () => {
    resolveSessionProject.mockResolvedValue("work");
    get.mockResolvedValue({ instructions: "Read memory." });
    listReferences.mockResolvedValue([{ title: "Wiki", description: "Useful source", path: "/private/wiki" }]);
    getNotes.mockResolvedValue("- [2026-10-13] Sally learned this.\n");
    const resolver = new ProjectContextResolver();
    const sally = await resolver.resolve({ agentId: "sally", sessionId: "first" });
    const casey = await resolver.resolve({ agentId: "casey", sessionId: "second" });
    expect(casey?.project).toEqual(sally?.project);
    const rendered = renderAgentContext(casey!);
    expect(rendered).toContain("Wiki: Useful source (path: /private/wiki)");
    expect(rendered).toContain("Sally learned this");
    getNotes.mockResolvedValue("old" + "x".repeat(5000) + "latest");
    const tail = (await resolver.resolve({ agentId: "casey", sessionId: "second" }))?.project?.notes;
    expect(tail).toHaveLength(4000);
    expect(tail).toMatch(/latest$/);
    expect(tail).not.toContain("old");
  });

  it("ignores a stale project hint after a move or removal", async () => {
    resolveSessionProject.mockResolvedValue("work");
    get.mockImplementation(async (id) => id === "work" ? { instructions: "Current instructions." } : null);
    expect(await new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "chat", projectId: "deleted" })).toMatchObject({ project: { instructions: "Current instructions." } });
    expect(get).not.toHaveBeenCalledWith("deleted");
    resolveSessionProject.mockResolvedValue(null);
    expect(await new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "chat", projectId: "deleted" })).toBeUndefined();
  });
  it("omits deleted projects and rejects inaccessible initial projects", async () => {
    resolveSessionProject.mockResolvedValue("research");
    get.mockResolvedValue(null);
    expect(await new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "chat" })).toBeUndefined();
    resolveSessionProject.mockImplementation(async (_agent, _session, _user, projectId, validate) => {
      await validate(projectId);
      return projectId;
    });
    await expect(new ProjectContextResolver().resolve({ agentId: "alpha", sessionId: "new", projectId: "research" })).rejects.toThrow("Project not found");
  });

  it("renders the session_history hint only when enabled", async () => {
    const resolver = new ProjectContextResolver();
    resolveSessionProject.mockResolvedValue("research");
    get.mockResolvedValue({ instructions: "x" });
    const on = await resolver.resolve({ agentId: "alpha", sessionId: "c", sessionHistory: true });
    const off = await resolver.resolve({ agentId: "alpha", sessionId: "c", sessionHistory: false });
    expect(renderAgentContext(on!)).toContain("session_history:");
    expect(renderAgentContext(off!)).not.toContain("session_history:");
  });
});
