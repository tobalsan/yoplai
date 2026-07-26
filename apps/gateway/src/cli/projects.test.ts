import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
const projectsExtensionSpecifier = "@yoplai/extension-projects";
const { createProjectsCommand, registerProjectsCommands } = (await import(
  projectsExtensionSpecifier
)) as {
  createProjectsCommand: () => Command;
  registerProjectsCommands: (command: Command) => void;
};

function createTestProgram() {
  const program = createProjectsCommand();
  program.exitOverride();
  return program;
}

describe("projects CLI", () => {
  let prevApiUrl: string | undefined;

  beforeEach(() => {
    prevApiUrl = process.env.YOPLAI_API_URL;
    process.env.YOPLAI_API_URL = "http://localhost:4000";
  });

  afterEach(() => {
    if (prevApiUrl === undefined) delete process.env.YOPLAI_API_URL;
    else process.env.YOPLAI_API_URL = prevApiUrl;
    vi.unstubAllGlobals();
  });

  it("create command passes pitch when provided", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-1", frontmatter: {} }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "create",
      "-t",
      "Title",
      "Desc",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ title: "Title", pitch: "Desc" });
  });

  it("create command omits pitch when absent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-2", frontmatter: {} }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "create",
      "-t",
      "Title",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ title: "Title" });
  });

  it("create command sends --pitch", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-3", frontmatter: {} }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "create",
      "-t",
      "Title Name",
      "--pitch",
      "## Pitch",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ title: "Title Name", pitch: "## Pitch" });
  });

  it("move command passes agent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ id: "PRO-1", frontmatter: { status: "done" } }),
        {
          status: 200,
        }
      );
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "move",
      "pro-1",
      "done",
      "--agent",
      "Sage",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects/PRO-1");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ status: "done", agent: "Sage" });
  });

  it("update command sends --readme and --specs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-5", frontmatter: {} }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "update",
      "pro-5",
      "--readme",
      "# Updated",
      "--specs",
      "## Tasks",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects/PRO-5");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ readme: "# Updated", specs: "## Tasks" });
  });

  it("start command omits runAgent/runMode when flags omitted", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          ok: true,
          type: "cli",
          slug: "main",
          runMode: "worktree",
        }),
        {
          status: 200,
        }
      );
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync(["node", "projects", "start", "PRO-10", "--json"]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-10/start"
    );
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({});
  });

  it("start command passes per-run flags", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          ok: true,
          type: "cli",
          slug: "my-run",
          runMode: "worktree",
        }),
        {
          status: 200,
        }
      );
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "start",
      "pro-9",
      "--agent",
      "codex",
      "--mode",
      "worktree",
      "--branch",
      "main",
      "--slug",
      "my-run",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects/PRO-9/start");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({
      runAgent: "cli:codex",
      runMode: "worktree",
      baseBranch: "main",
      slug: "my-run",
    });
  });

  it("archive command posts to project archive endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-7" }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const program = createTestProgram();

    await program.parseAsync([
      "node",
      "projects",
      "archive",
      "pro-7",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-7/archive"
    );
    expect(calls[0].init?.method).toBe("POST");
  });

  it("registers commands under yoplai projects", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "PRO-11", frontmatter: {} }), {
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    const root = new Command();
    root.name("yoplai").exitOverride();
    registerProjectsCommands(root.command("projects"));

    await root.parseAsync([
      "node",
      "yoplai",
      "projects",
      "get",
      "pro-11",
      "--json",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/projects/PRO-11");
  });
});
