import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { resolveHomeDir } from "@yoplai/shared";
import { getAgentDataDir } from "../agents/container.js";
import {
  canvasExtension,
  dashboardDirectory,
  normalizeDashboardSlug,
  openDashboardFile,
} from "./index.js";
import { createDashboardRoutes, dashboardCsp } from "./routes.js";
import { DashboardRegistry } from "./store.js";

let root: string;
let workspace: string;
let registry: DashboardRegistry;
const config = {
  agents: [],
  canvas: { enabled: true, baseUrl: "https://yoplai.test" },
} as unknown as GatewayConfig;

function agent(): AgentConfig {
  return { id: "agent-1", name: "Agent", workspace } as AgentConfig;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-test-"));
  workspace = path.join(root, "agent");
  await fs.mkdir(path.join(workspace, "dashboards"), { recursive: true });
  registry = new DashboardRegistry(path.join(root, "registry.json"));
});

afterEach(async () => {
  await canvasExtension.stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe("dashboard registry and tool", () => {
  it("keeps a stable unguessable link across edits and lists updated files", async () => {
    const file = path.join(workspace, "dashboards", "hello.html");
    await fs.writeFile(file, "<h1>one</h1>");
    await canvasExtension.start({
      getDataDir: () => root,
    } as never);
    const tools = await canvasExtension.getAgentTools!(agent(), { config });
    const tool = tools[0];

    const first = (await tool.execute({ slug: "hello.html" }, {} as never)) as {
      link: string;
      updatedAt: string;
    };
    await fs.writeFile(file, "<h1>two</h1>");
    const second = (await tool.execute(
      { slug: "hello.html" },
      {} as never
    )) as {
      link: string;
    };
    const listed = (await tool.execute({}, {} as never)) as Array<{
      link: string;
      slug: string;
    }>;

    expect(first.link).toMatch(
      /^https:\/\/yoplai\.test\/d\/[A-Za-z0-9_-]{32}$/
    );
    expect(second.link).toBe(first.link);
    expect(listed).toEqual([
      expect.objectContaining({ slug: "hello.html", link: first.link }),
    ]);
  });

  it("deduplicates concurrent links", async () => {
    const [first, second] = await Promise.all([
      registry.link("agent-1", "hello.html"),
      registry.link("agent-1", "hello.html"),
    ]);
    expect(second.id).toBe(first.id);
    expect(await registry.list("agent-1")).toHaveLength(1);
  });

  it("uses the mounted data directory for sandboxed agents", () => {
    const sandboxed = { ...agent(), sandbox: { enabled: true } } as AgentConfig;
    expect(dashboardDirectory(sandboxed)).toBe(
      path.join(getAgentDataDir(resolveHomeDir(), sandboxed.id), "dashboards")
    );
  });

  it("rejects symlinked dashboard files and directories", async () => {
    const outside = path.join(root, "outside.html");
    await fs.writeFile(outside, "secret");
    await fs.symlink(
      outside,
      path.join(workspace, "dashboards", "linked.html")
    );
    await expect(openDashboardFile(agent(), "linked.html")).rejects.toThrow(
      "Dashboard not found"
    );

    await fs.rm(path.join(workspace, "dashboards"), { recursive: true });
    await fs.mkdir(path.join(root, "outside"));
    await fs.writeFile(path.join(root, "outside", "hello.html"), "secret");
    await fs.symlink(
      path.join(root, "outside"),
      path.join(workspace, "dashboards")
    );
    await expect(openDashboardFile(agent(), "hello.html")).rejects.toThrow(
      "Dashboard not found"
    );
  });

  it.each([
    "../secret.html",
    "nested/page.html",
    "/tmp/page.html",
    "page.txt",
    ".html",
  ])("rejects confined slug %s", (slug) =>
    expect(() => normalizeDashboardSlug(slug)).toThrow()
  );
});

describe("dashboard viewer", () => {
  async function app(auth: unknown | null, allowed: boolean) {
    const entry = await registry.link("agent-1", "hello.html");
    return {
      entry,
      app: createDashboardRoutes({
        getConfig: () => config,
        getAgent: () => agent(),
        registry,
        authenticate: async () => auth,
        hasAgentAccess: async () => allowed,
      }),
    };
  }

  it("redirects unauthenticated viewers to login", async () => {
    const { app: routes, entry } = await app(null, false);
    const response = await routes.request(`https://yoplai.test/${entry.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://yoplai.test/login?returnTo=%2F${entry.id}`
    );
  });

  it("returns 404 to a logged-in non-member", async () => {
    const { app: routes, entry } = await app({}, false);
    expect((await routes.request(`/${entry.id}`)).status).toBe(404);
  });

  it("returns 404 when a linked dashboard was deleted", async () => {
    const { app: routes, entry } = await app({}, true);
    expect((await routes.request(`/${entry.id}`)).status).toBe(404);
  });

  it("serves the current file with the sandbox CSP to a member", async () => {
    await fs.writeFile(
      path.join(workspace, "dashboards", "hello.html"),
      "<script>fetch('/api/me',{credentials:'include'})</script>"
    );
    const { app: routes, entry } = await app({}, true);
    const first = await routes.request(`/${entry.id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-security-policy")).toBe(
      dashboardCsp(config)
    );
    expect(first.headers.get("content-security-policy")).toContain(
      "connect-src 'none'"
    );
    await fs.writeFile(
      path.join(workspace, "dashboards", "hello.html"),
      "<h1>edited</h1>"
    );
    expect(await (await routes.request(`/${entry.id}`)).text()).toContain(
      "edited"
    );
  });
});
