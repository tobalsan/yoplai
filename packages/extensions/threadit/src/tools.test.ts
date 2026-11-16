import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  ExtensionAgentToolContext,
  ExtensionContext,
  GatewayConfig,
} from "@yoplai/shared";
import { threaditAgentTools, MAX_ATTACHMENT_BYTES } from "./tools.js";

const TOKEN = "tok-secret-123";

type Seen = {
  method: string;
  path: string;
  search: string;
  body: string;
  auth: string | null;
  contentType: string | null;
};

let workspace: string;
let home: string;
let outside: string;
let seen: Seen[];
let respond: (seen: Seen) => Response;
let saveToken: ReturnType<typeof vi.fn>;
let live: AgentConfig | undefined;

function agent(extra: Record<string, unknown> = {}): AgentConfig {
  return {
    id: "bot",
    workspace: "bot",
    extensions: { threadit: { token: TOKEN, ...extra } },
  } as unknown as AgentConfig;
}

function config(root: Record<string, unknown> | null = { baseUrl: "http://board:8000/" }) {
  return { extensions: root ? { threadit: root } : {} } as unknown as GatewayConfig;
}

function context(
  overrides: Partial<ExtensionAgentToolContext> = {}
): ExtensionAgentToolContext {
  return { agent: agent(), config: config(), env: {}, ...overrides };
}

const fetchFn = async (url: string, init?: RequestInit) => {
  const parsed = new URL(url);
  const entry: Seen = {
    method: init?.method ?? "GET",
    path: parsed.pathname,
    search: parsed.search,
    body: init?.body instanceof Uint8Array ? "<bytes>" : String(init?.body ?? ""),
    auth: new Headers(init?.headers).get("authorization"),
    contentType: new Headers(init?.headers).get("content-type"),
  };
  seen.push(entry);
  return respond(entry);
};

function host(): ExtensionContext {
  return {
    getAgent: () => live,
    getDataDir: () => home,
    resolveWorkspaceDir: () => workspace,
    updateAgentExtensionConfig: saveToken,
  } as unknown as ExtensionContext;
}

function tools(withHost: ExtensionContext | undefined = host()) {
  const list = threaditAgentTools({ fetchFn, getHost: () => withHost });
  return (name: string) => {
    const found = list.find((t) => t.name === `threadit.${name}`);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
}

const run = (name: string, args: unknown, ctx = context()) =>
  tools()(name).execute(args, ctx) as Promise<Record<string, unknown>>;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "threadit-tools-"));
  home = await mkdtemp(path.join(os.tmpdir(), "threadit-home-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "threadit-out-"));
  seen = [];
  respond = () => Response.json({ marker: true });
  saveToken = vi.fn(async () => {});
  live = undefined;
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("threadit tools: requests", () => {
  const cases: Array<{
    tool: string;
    args: Record<string, unknown>;
    method: string;
    path: string;
    search?: string;
    body?: unknown;
  }> = [
    { tool: "whoami", args: {}, method: "GET", path: "/api/me" },
    {
      tool: "update_profile",
      args: { description: "I help" },
      method: "PATCH",
      path: "/api/me",
      body: { description: "I help" },
    },
    { tool: "list_users", args: {}, method: "GET", path: "/api/users" },
    { tool: "list_areas", args: {}, method: "GET", path: "/api/areas" },
    { tool: "get_area", args: { area: "ops team" }, method: "GET", path: "/api/areas/ops%20team" },
    { tool: "get_area", args: { area: 4 }, method: "GET", path: "/api/areas/4" },
    {
      tool: "create_area",
      args: { name: "Ops", description: "Be brief" },
      method: "POST",
      path: "/api/areas",
      body: { name: "Ops", description: "Be brief" },
    },
    {
      tool: "update_area",
      args: { area: 4, name: "Ops2" },
      method: "PATCH",
      path: "/api/areas/4",
      body: { name: "Ops2" },
    },
    {
      tool: "list_threads",
      args: { area_id: 2, state: "all", sort: "hot", order: "asc", limit: 10, offset: 20 },
      method: "GET",
      path: "/api/threads",
      search: "?area_id=2&state=all&sort=hot&order=asc&limit=10&offset=20",
    },
    { tool: "read_thread", args: { thread_id: 9 }, method: "GET", path: "/api/threads/9" },
    {
      tool: "read_thread",
      args: { thread_id: 9, top_level_only: true },
      method: "GET",
      path: "/api/threads/9/messages",
      search: "?top_level_only=true",
    },
    {
      tool: "create_thread",
      args: { area_id: 2, title: "T", body: "B", attachment_ids: [5] },
      method: "POST",
      path: "/api/threads",
      body: { area_id: 2, title: "T", body: "B", attachment_ids: [5] },
    },
    {
      tool: "update_thread",
      args: { thread_id: 9, title: "New" },
      method: "PATCH",
      path: "/api/threads/9",
      body: { title: "New" },
    },
    {
      tool: "close_thread",
      args: { thread_id: 9, reason: "completed" },
      method: "POST",
      path: "/api/threads/9/close",
      body: { reason: "completed" },
    },
    { tool: "reopen_thread", args: { thread_id: 9 }, method: "POST", path: "/api/threads/9/reopen" },
    {
      tool: "pin_thread",
      args: { thread_id: 9, pinned: true },
      method: "PUT",
      path: "/api/threads/9/pin",
      body: { pinned: true },
    },
    { tool: "get_message", args: { message_id: 7 }, method: "GET", path: "/api/messages/7" },
    {
      tool: "message_context",
      args: { message_id: 7 },
      method: "GET",
      path: "/api/messages/7/context",
    },
    {
      tool: "reply",
      args: { thread_id: 9, body: "Hi @ann", parent_id: 7, attachment_ids: [1, 2] },
      method: "POST",
      path: "/api/threads/9/messages",
      body: { body: "Hi @ann", parent_id: 7, attachment_ids: [1, 2] },
    },
    {
      tool: "edit_message",
      args: { message_id: 7, body: "fixed" },
      method: "PATCH",
      path: "/api/messages/7",
      body: { body: "fixed" },
    },
    {
      tool: "edit_message",
      args: { message_id: 7, attachment_ids: [3, 4] },
      method: "PATCH",
      path: "/api/messages/7",
      body: { attachment_ids: [3, 4] },
    },
    {
      tool: "edit_message",
      args: { message_id: 7, body: "fixed", attachment_ids: [3] },
      method: "PATCH",
      path: "/api/messages/7",
      body: { body: "fixed", attachment_ids: [3] },
    },
    {
      tool: "edit_message",
      args: { message_id: 7, attachment_ids: [] },
      method: "PATCH",
      path: "/api/messages/7",
      body: { attachment_ids: [] },
    },
    {
      tool: "vote",
      args: { message_id: 7, delta: -5 },
      method: "POST",
      path: "/api/messages/7/votes",
      body: { delta: -5 },
    },
    {
      tool: "react",
      args: { message_id: 7, emoji: "👀" },
      method: "POST",
      path: "/api/messages/7/reactions",
      body: { emoji: "👀" },
    },
    {
      tool: "unreact",
      args: { message_id: 7, emoji: "👀" },
      method: "DELETE",
      path: "/api/messages/7/reactions/%F0%9F%91%80",
    },
    {
      tool: "attention",
      args: { status: "unacknowledged", include_closed: true, order: "asc" },
      method: "GET",
      path: "/api/attention",
      search: "?status=unacknowledged&include_closed=true&order=asc",
    },
    {
      tool: "search",
      args: { q: "deploy", include_closed: true, area_id: 2 },
      method: "GET",
      path: "/api/search",
      search: "?q=deploy&include_closed=true&area_id=2",
    },
    {
      tool: "activity",
      args: { limit: 5, before_id: 90 },
      method: "GET",
      path: "/api/activity",
      search: "?limit=5&before_id=90",
    },
  ];

  it.each(cases)("$tool sends $method $path", async (c) => {
    const result = await run(c.tool, c.args);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: c.method,
      path: c.path,
      search: c.search ?? "",
      auth: `Bearer ${TOKEN}`,
    });
    expect(seen[0]?.body ? JSON.parse(seen[0].body) : undefined).toEqual(c.body);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("covers every tool name once", () => {
    const names = threaditAgentTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("threadit."))).toBe(true);
    expect(names).toEqual(
      expect.arrayContaining(["threadit.register", "threadit.upload_attachment", "threadit.download_attachment"])
    );
    const used = new Set([...cases.map((c) => `threadit.${c.tool}`), "threadit.register", "threadit.upload_attachment", "threadit.download_attachment"]);
    expect(names.filter((n) => !used.has(n))).toEqual([]);
  });

  it("returns the data fields with ok: true", async () => {
    respond = () => Response.json({ users: [{ username: "ann" }] });
    expect(await run("list_users", {})).toEqual({ ok: true, users: [{ username: "ann" }] });
  });

  it("uses the agent base URL over the root URL and resolves an $env token", async () => {
    const ctx = context({
      agent: agent({ token: "$env:THREADIT_TOKEN", baseUrl: "http://own:1/" }),
      env: { THREADIT_TOKEN: "from-env" },
    });
    await tools()("whoami").execute({}, ctx);
    expect(seen[0]).toMatchObject({ auth: "Bearer from-env", path: "/api/me" });
  });

  it("prefers the live agent config, so a token saved in this run works", async () => {
    live = agent({ token: "live-token" });
    await run("whoami", {}, context({ agent: agent({ token: undefined }) }));
    expect(seen[0]).toMatchObject({ auth: "Bearer live-token" });
  });
});

describe("threadit tools: errors", () => {
  it("maps a Threadit error to ok: false with the message", async () => {
    respond = () =>
      Response.json(
        { error: { code: "thread_closed", message: "Thread is closed" } },
        { status: 409 }
      );
    expect(await run("reply", { thread_id: 1, body: "x" })).toEqual({
      ok: false,
      error: "Threadit error 409 thread_closed: Thread is closed",
    });
  });

  it("maps a non-JSON error and a network failure", async () => {
    respond = () => new Response("oops", { status: 502 });
    expect(await run("whoami", {})).toEqual({ ok: false, error: "Threadit error 502" });
    const failing = threaditAgentTools({
      fetchFn: async () => {
        throw new Error(`socket ${TOKEN}`);
      },
    });
    const result = await failing[0]!.execute({}, context());
    expect(result).toEqual({ ok: false, error: "Could not reach the Threadit board." });
  });

  it("never puts the token in an error, even when the server echoes it", async () => {
    respond = () =>
      Response.json(
        { error: { code: "invalid_input", message: `bad ${TOKEN}` } },
        { status: 422 }
      );
    const result = await run("whoami", {});
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects bad arguments without a request", async () => {
    const result = await run("vote", { message_id: 1, delta: 3 });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Invalid arguments");
    expect(seen).toEqual([]);
  });

  it("rejects an edit with neither body nor attachments, or too many attachments", async () => {
    const empty = await run("edit_message", { message_id: 1 });
    expect(empty.ok).toBe(false);
    expect(String(empty.error)).toContain("needs body or attachment_ids");
    const many = await run("edit_message", {
      message_id: 1,
      attachment_ids: Array.from({ length: 11 }, (_, i) => i + 1),
    });
    expect(many.ok).toBe(false);
    expect(String(many.error)).toContain("Invalid arguments");
    expect(seen).toEqual([]);
  });

  it("hints to register when there is no token", async () => {
    const result = await run("whoami", {}, context({ agent: agent({ token: undefined }) }));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("threadit.register");
    expect(seen).toEqual([]);
  });

  it("surfaces a pending account on whoami", async () => {
    respond = () =>
      Response.json(
        { error: { code: "account_pending", message: "Needs approval" } },
        { status: 403 }
      );
    expect(await run("whoami", {})).toEqual({
      ok: false,
      error: "Threadit error 403 account_pending: Needs approval",
    });
  });
});

describe("threadit tools: gating", () => {
  async function names(ctx: ExtensionAgentToolContext) {
    const { threaditExtension } = await import("./index.js");
    const list = await threaditExtension.getAgentTools?.(ctx.agent, {
      config: ctx.config,
      env: ctx.env,
    });
    return (list ?? []).map((t) => t.name);
  }

  it("offers tools with only a base URL", async () => {
    expect((await names(context({ agent: agent({ token: undefined }) }))).length).toBeGreaterThan(20);
  });

  it("offers none without a base URL, or when disabled", async () => {
    expect(await names(context({ config: config(null) }))).toEqual([]);
    expect(await names(context({ config: config({ baseUrl: "http://x", enabled: false }) }))).toEqual([]);
    expect(await names(context({ agent: agent({ enabled: false }) }))).toEqual([]);
  });
});

describe("threadit.register", () => {
  const created = {
    id: 5,
    username: "bot",
    token: "new-token-xyz",
    account_type: "agent",
    status: "pending",
    is_superadmin: false,
    description: "d",
  };
  const args = { username: "bot", description: "I help" };
  const noToken = () => context({ agent: agent({ token: undefined }) });

  beforeEach(() => {
    respond = (s) => (s.path === "/api/register" ? Response.json(created, { status: 201 }) : Response.json({}));
  });

  it("creates an agent account, saves the token, and hides the token", async () => {
    const result = await run("register", args, noToken());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/register", auth: null });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      username: "bot",
      account_type: "agent",
      description: "I help",
    });
    expect(saveToken).toHaveBeenCalledWith("bot", "threadit", {
      secrets: { token: "new-token-xyz" },
    });
    expect(result).toMatchObject({ ok: true, username: "bot", status: "pending", is_superadmin: false });
    expect(JSON.stringify(result)).not.toContain("new-token-xyz");
  });

  it("refuses when the current token works", async () => {
    respond = (s) =>
      s.path === "/api/me" ? Response.json({ id: 5 }) : Response.json(created, { status: 201 });
    const result = await run("register", args);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("already have a working");
    expect(seen.map((s) => s.path)).toEqual(["/api/me"]);
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("refuses when the current token is valid but pending", async () => {
    respond = (s) =>
      s.path === "/api/me"
        ? Response.json({ error: { code: "account_pending", message: "wait" } }, { status: 403 })
        : Response.json(created, { status: 201 });
    const result = await run("register", args);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("waits for approval");
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("registers over a working token when replace is true, with no check", async () => {
    const result = await run("register", { ...args, replace: true });
    expect(result.ok).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(["/api/register"]);
    expect(saveToken).toHaveBeenCalledTimes(1);
  });

  it("registers when the current token gets 401", async () => {
    respond = (s) =>
      s.path === "/api/me"
        ? Response.json({ error: { code: "invalid_token", message: "bad" } }, { status: 401 })
        : Response.json(created, { status: 201 });
    const result = await run("register", args);
    expect(result.ok).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(["/api/me", "/api/register"]);
    expect(saveToken).toHaveBeenCalledTimes(1);
  });

  it("does not replace a token when the board does not answer", async () => {
    respond = () => new Response("down", { status: 503 });
    const result = await run("register", args);
    expect(result.ok).toBe(false);
    expect(seen.map((s) => s.path)).toEqual(["/api/me"]);
  });

  it("maps a taken username", async () => {
    respond = () =>
      Response.json({ error: { code: "username_taken", message: "Taken" } }, { status: 409 });
    const result = await run("register", args, noToken());
    expect(result).toEqual({ ok: false, error: "Threadit error 409 username_taken: Taken" });
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("reports a save failure without the token", async () => {
    saveToken.mockRejectedValueOnce(new Error("disk full new-token-xyz"));
    const result = await run("register", args, noToken());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("could not save the token");
    expect(JSON.stringify(result)).not.toContain("new-token-xyz");
  });

  it("fails when the host cannot save a token", async () => {
    const bare = { ...host(), updateAgentExtensionConfig: undefined } as unknown as ExtensionContext;
    const result = (await tools(bare)("register").execute(args, noToken())) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("threadit attachments", () => {
  const png = Buffer.from([1, 2, 3, 4]);

  beforeEach(async () => {
    await writeFile(path.join(workspace, "a.png"), png);
    respond = () =>
      Response.json(
        { id: 11, filename: "a.png", content_type: "image/png", size: 4, url: "/x" },
        { status: 201 }
      );
  });

  it("uploads a workspace file and returns the id", async () => {
    const result = await run("upload_attachment", { path: "a.png" });
    expect(result).toMatchObject({ ok: true, attachment: { id: 11 } });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/attachments",
      search: "?filename=a.png",
      contentType: "image/png",
      auth: `Bearer ${TOKEN}`,
    });
  });

  it("maps /workspace to the host workspace", async () => {
    await mkdir(path.join(workspace, "out"));
    await writeFile(path.join(workspace, "out", "b.txt"), "hi");
    const result = await run("upload_attachment", { path: "/workspace/out/b.txt" });
    expect(result.ok).toBe(true);
    expect(seen[0]).toMatchObject({ search: "?filename=b.txt", contentType: "text/plain" });
  });

  it("maps /workspace/data and /workspace/uploads to the mounted host dirs", async () => {
    await mkdir(path.join(home, "agents", "bot", "data"), { recursive: true });
    await mkdir(path.join(home, "agents", "bot", "uploads", "s1"), { recursive: true });
    await writeFile(path.join(home, "agents", "bot", "data", "report.pdf"), "d");
    await writeFile(path.join(home, "agents", "bot", "uploads", "s1", "input.pdf"), "u");
    const ctx = context({ sessionId: "s1" });
    expect((await run("upload_attachment", { path: "/workspace/data/report.pdf" }, ctx)).ok).toBe(true);
    expect((await run("upload_attachment", { path: "/workspace/uploads/input.pdf" }, ctx)).ok).toBe(true);
    expect(seen.map((s) => s.search)).toEqual(["?filename=report.pdf", "?filename=input.pdf"]);
    const escape = await run("upload_attachment", { path: "/workspace/data/../../x" }, ctx);
    expect(escape.ok).toBe(false);
  });

  it("allows an absolute host path inside the workspace", async () => {
    const result = await run("upload_attachment", { path: path.join(workspace, "a.png") });
    expect(result.ok).toBe(true);
  });

  it("rejects paths outside the workspace", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "threadit-out-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "s");
      await symlink(outside, path.join(workspace, "link"));
      await symlink(path.join(outside, "secret.txt"), path.join(workspace, "file-link"));
      for (const p of [
        "../secret.txt",
        "/workspace/../secret.txt",
        path.join(outside, "secret.txt"),
        "/etc/hosts",
        "link/secret.txt",
        "file-link",
      ]) {
        const result = await run("upload_attachment", { path: p });
        expect(result.ok, p).toBe(false);
        expect(String(result.error), p).toMatch(/outside your workspace|not found/);
      }
      expect(seen).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a file above 10 MB, an empty file, and a directory", async () => {
    const big = path.join(workspace, "big.bin");
    await writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(String((await run("upload_attachment", { path: "big.bin" })).error)).toContain("10 MB");
    await writeFile(path.join(workspace, "empty"), "");
    expect((await run("upload_attachment", { path: "empty" })).ok).toBe(false);
    await mkdir(path.join(workspace, "dir"));
    expect((await run("upload_attachment", { path: "dir" })).ok).toBe(false);
    await writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES));
    expect((await run("upload_attachment", { path: "big.bin" })).ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("downloads into threadit-attachments and returns the host path", async () => {
    respond = () => new Response(png, { status: 200 });
    const result = await run("download_attachment", { id: 11, filename: "../../evil name.png" });
    const saved = path.join(workspace, "threadit-attachments", "11-evil_name.png");
    expect(result).toEqual({ ok: true, path: saved, size: 4 });
    expect(await readFile(saved)).toEqual(png);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/attachments/11" });
  });

  it("returns a /workspace path for a sandboxed agent and uses the disposition name", async () => {
    respond = () =>
      new Response(png, {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="pic.png"' },
      });
    const sandboxed = agent();
    (sandboxed as unknown as { sandbox: unknown }).sandbox = { enabled: true };
    live = sandboxed;
    const result = await run("download_attachment", { id: 3 }, context({ agent: sandboxed }));
    expect(result.path).toBe("/workspace/threadit-attachments/3-pic.png");
    expect((await stat(path.join(workspace, "threadit-attachments", "3-pic.png"))).size).toBe(4);
  });

  it("refuses a download through a symlinked folder or file", async () => {
    respond = () => new Response(png, { status: 200 });
    await symlink(outside, path.join(workspace, "threadit-attachments"));
    const viaDir = await run("download_attachment", { id: 5, filename: "a.png" });
    expect(viaDir.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
    await rm(path.join(workspace, "threadit-attachments"));
    await mkdir(path.join(workspace, "threadit-attachments"));
    await writeFile(path.join(outside, "target"), "keep");
    await symlink(
      path.join(outside, "target"),
      path.join(workspace, "threadit-attachments", "6-a.png")
    );
    const viaFile = await run("download_attachment", { id: 6, filename: "a.png" });
    expect(viaFile.ok).toBe(false);
    expect(await readFile(path.join(outside, "target"), "utf8")).toBe("keep");
  });

  it("refuses a download above 10 MB", async () => {
    respond = () => new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), { status: 200 });
    const result = await run("download_attachment", { id: 3 });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("10 MB");
  });
});
