import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { JSDOM } from "jsdom";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { resolveHomeDir } from "@yoplai/shared";
import { getAgentDataDir } from "../agents/container.js";
import {
  canvasExtension,
  dashboardDirectory,
  normalizeDashboardSlug,
  openDashboardFile,
} from "./index.js";
import {
  createDashboardAssetRoutes,
  createDashboardRoutes,
  dashboardCsp,
  injectDashboardRuntime,
  parseThemeCookie,
} from "./routes.js";
import {
  DASHBOARD_VERSION_LIMIT,
  DashboardRegistry,
  getDashboardRegistry,
} from "./store.js";
import { listAgentDashboards } from "./list.js";
import {
  DASHBOARD_QUERY_ROW_LIMIT,
  DASHBOARD_RESULT_BYTE_LIMIT,
  DASHBOARD_SQL_BYTE_LIMIT,
  DASHBOARD_WORKER_LIMIT,
  DASHBOARD_WORKER_QUEUE_LIMIT,
  executeDashboardQueries,
  parseDashboardQueries,
  resolveDashboardDatabase,
  runDashboardQuery,
} from "./sql.js";

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
  await fs.mkdir(path.join(workspace, "data", "dashboards"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspace, "data"), { recursive: true });
  registry = new DashboardRegistry(path.join(root, "registry.json"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await canvasExtension.stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe("dashboard registry and tool", () => {
  it("lists dashboard titles, modified times, and stable viewer links", async () => {
    const file = path.join(workspace, "data", "dashboards", "sales.html");
    await fs.writeFile(
      file,
      "<html><head><title>Sales Overview</title></head></html>"
    );
    const first = await listAgentDashboards(agent(), registry, config);
    const second = await listAgentDashboards(agent(), registry, config);
    expect(first).toEqual([
      {
        title: "Sales Overview",
        slug: "sales.html",
        updatedAt: expect.any(String),
        link: expect.stringMatching(
          /^https:\/\/yoplai\.test\/d\/[A-Za-z0-9_-]{32}$/
        ),
      },
    ]);
    expect(second).toEqual(first);
    expect(await registry.list("agent-1")).toHaveLength(1);
  });

  it("keeps a stable unguessable link across edits and lists updated files", async () => {
    const file = path.join(workspace, "data", "dashboards", "hello.html");
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

  it("lists observed edits, restores content, keeps the link, and prunes old versions", async () => {
    const file = path.join(workspace, "data", "dashboards", "hello.html");
    await canvasExtension.start({ getDataDir: () => root } as never);
    const [linkTool, versionsTool] = await canvasExtension.getAgentTools!(
      agent(),
      { config }
    );
    let link = "";
    for (let index = 0; index < DASHBOARD_VERSION_LIMIT + 2; index += 1) {
      await fs.writeFile(file, `<h1>${index}</h1>`);
      const result = (await linkTool.execute(
        { slug: "hello.html" },
        {} as never
      )) as { link: string };
      link ||= result.link;
      expect(result.link).toBe(link);
    }

    const listed = (await versionsTool.execute(
      { slug: "hello.html" },
      {} as never
    )) as {
      link: string;
      versions: Array<{ id: string }>;
    };
    expect(listed.link).toBe(link);
    expect(listed.versions).toHaveLength(DASHBOARD_VERSION_LIMIT);

    const oldestRetained = listed.versions.at(-1)!;
    await fs.writeFile(file, "<h1>unseen edit</h1>");
    const restored = (await versionsTool.execute(
      { slug: "hello.html", restore: oldestRetained.id },
      {} as never
    )) as { link: string; restored: string };
    expect(restored).toEqual(
      expect.objectContaining({ link, restored: oldestRetained.id })
    );
    expect(await fs.readFile(file, "utf8")).toBe("<h1>2</h1>");
  });

  it("serializes version writes across registry instances", async () => {
    const registryFile = path.join(root, "shared-registry.json");
    const firstRegistry = new DashboardRegistry(registryFile);
    const secondRegistry = new DashboardRegistry(registryFile);
    const entry = await firstRegistry.link("agent-1", "hello.html");

    await Promise.all(
      Array.from({ length: DASHBOARD_VERSION_LIMIT }, (_, index) =>
        (index % 2 ? firstRegistry : secondRegistry).recordVersion(
          entry.id,
          `version-${index}`
        )
      )
    );

    expect(await firstRegistry.listVersions(entry.id)).toHaveLength(
      DASHBOARD_VERSION_LIMIT
    );
  });

  it("restores concurrent versions atomically", async () => {
    const file = path.join(workspace, "data", "dashboards", "hello.html");
    const firstContent = `first-${"a".repeat(200_000)}`;
    const secondContent = `second-${"b".repeat(200_000)}`;
    await canvasExtension.start({ getDataDir: () => root } as never);
    const [linkTool, versionsTool] = await canvasExtension.getAgentTools!(
      agent(),
      { config }
    );
    await fs.writeFile(file, firstContent);
    await linkTool.execute({ slug: "hello.html" }, {} as never);
    await fs.writeFile(file, secondContent);
    await linkTool.execute({ slug: "hello.html" }, {} as never);
    const listed = (await versionsTool.execute(
      { slug: "hello.html" },
      {} as never
    )) as { versions: Array<{ id: string }> };

    await Promise.all(
      listed.versions.map((version) =>
        versionsTool.execute(
          { slug: "hello.html", restore: version.id },
          {} as never
        )
      )
    );

    expect([firstContent, secondContent]).toContain(
      await fs.readFile(file, "utf8")
    );
  });

  it("uses Git history instead of managed dashboard versions", async () => {
    await fs.mkdir(path.join(workspace, ".git"));
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "hello.html"),
      "<h1>git</h1>"
    );
    await canvasExtension.start({ getDataDir: () => root } as never);
    const [linkTool, versionsTool] = await canvasExtension.getAgentTools!(
      agent(),
      { config }
    );
    await linkTool.execute({ slug: "hello.html" }, {} as never);
    await expect(
      versionsTool.execute({ slug: "hello.html" }, {} as never)
    ).resolves.toEqual(
      expect.objectContaining({ managed: false, versions: [] })
    );
  });

  it("discovers and links dashboard files when listing", async () => {
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "hello.html"),
      "<h1>hello</h1>"
    );
    await canvasExtension.start({
      getDataDir: () => root,
    } as never);
    const tools = await canvasExtension.getAgentTools!(agent(), { config });
    const tool = tools[0];

    const first = (await tool.execute({}, {} as never)) as Array<{
      link: string;
      slug: string;
    }>;
    const second = (await tool.execute({}, {} as never)) as Array<{
      link: string;
      slug: string;
    }>;

    expect(first).toEqual([
      expect.objectContaining({ slug: "hello.html", link: expect.any(String) }),
    ]);
    expect(second).toEqual(first);
  });

  it("reports query errors through dashboard_link", async () => {
    new Database(path.join(workspace, "data", "bad.db")).close();
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "bad.html"),
      `<script type="application/sql" data-name="broken" data-db="data/bad.db">select * from missing</script>`
    );
    await canvasExtension.start({ getDataDir: () => root } as never);
    const [tool] = await canvasExtension.getAgentTools!(agent(), { config });
    const result = (await tool.execute({ slug: "bad.html" }, {} as never)) as {
      queryErrors: Array<{ name: string; error: string }>;
    };
    expect(result.queryErrors).toEqual([
      expect.objectContaining({ name: "broken", error: expect.any(String) }),
    ]);
  });

  it("continues listing when one dashboard becomes unavailable", async () => {
    const dashboards = path.join(workspace, "data", "dashboards");
    await fs.writeFile(path.join(dashboards, "gone.html"), "gone");
    await fs.writeFile(path.join(dashboards, "hello.html"), "hello");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (candidate, ...args) => {
      if (String(candidate).endsWith("gone.html")) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return open(candidate, ...args);
    });
    await canvasExtension.start({
      getDataDir: () => root,
    } as never);
    const [tool] = await canvasExtension.getAgentTools!(agent(), { config });

    await expect(tool.execute({}, {} as never)).resolves.toEqual([
      expect.objectContaining({ slug: "hello.html" }),
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

  it("shares one registry for every writer using the same file", () => {
    const file = path.join(root, "shared-registry.json");
    expect(getDashboardRegistry(file)).toBe(getDashboardRegistry(file));
  });

  it("uses the mounted data directory for sandboxed agents", () => {
    const sandboxed = { ...agent(), sandbox: { enabled: true } } as AgentConfig;
    expect(dashboardDirectory(sandboxed)).toBe(
      path.join(getAgentDataDir(resolveHomeDir(), sandboxed.id), "dashboards")
    );
  });

  it("reads host dashboards from data/dashboards, not dashboards/", async () => {
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "new.html"),
      "new"
    );
    await fs.mkdir(path.join(workspace, "dashboards"));
    await fs.writeFile(path.join(workspace, "dashboards", "old.html"), "old");
    const file = await openDashboardFile(agent(), "new.html");
    await file.close();
    await expect(openDashboardFile(agent(), "old.html")).rejects.toThrow(
      "Dashboard not found: data/dashboards/old.html"
    );
  });

  it("links sandboxed dashboards and queries data/ from the data directory", async () => {
    vi.stubEnv("YOPLAI_HOME", path.join(root, "home"));
    const sandboxed = { ...agent(), sandbox: { enabled: true } } as AgentConfig;
    const dataDir = getAgentDataDir(resolveHomeDir(), sandboxed.id);
    await fs.mkdir(path.join(dataDir, "dashboards"), { recursive: true });
    const db = new Database(path.join(dataDir, "x.db"));
    db.exec("create table items(id integer); insert into items values (7)");
    db.close();
    await fs.writeFile(
      path.join(dataDir, "dashboards", "box.html"),
      `<script type="application/sql" data-name="items" data-db="data/x.db">select id from items</script>`
    );
    await canvasExtension.start({ getDataDir: () => root } as never);
    const [tool] = await canvasExtension.getAgentTools!(sandboxed, { config });
    const result = (await tool.execute({ slug: "box.html" }, {} as never)) as {
      queryErrors: unknown[];
    };
    expect(result.queryErrors).toEqual([]);
    const queried = await executeDashboardQueries(
      sandboxed,
      `<script type="application/sql" data-name="items" data-db="data/x.db">select id from items</script>`,
      {}
    );
    expect(queried).toEqual({ data: { items: [{ id: 7 }] }, errors: [] });

    new Database(path.join(root, "home", "agents", "x.db")).close();
    for (const database of ["x.db", "../x.db", "data/../../x.db", "data/"]) {
      await expect(
        resolveDashboardDatabase(sandboxed, database)
      ).rejects.toThrow(
        "Sandboxed dashboards can only read databases under data/"
      );
    }
    await expect(
      resolveDashboardDatabase(sandboxed, path.join(dataDir, "x.db"))
    ).rejects.toThrow("relative to the workspace root");
  });

  it.each([false, true])(
    "deletes dashboard files, links, and versions idempotently (sandboxed: %s)",
    async (sandboxed) => {
      vi.stubEnv("YOPLAI_HOME", path.join(root, "home"));
      const configuredAgent = sandboxed
        ? ({ ...agent(), sandbox: { enabled: true } } as AgentConfig)
        : agent();
      const dashboards = dashboardDirectory(configuredAgent);
      await fs.mkdir(dashboards, { recursive: true });
      const file = path.join(dashboards, "hello.html");
      const database = path.join(path.dirname(dashboards), "shared.db");
      await fs.writeFile(file, "<h1>first</h1>");
      await fs.writeFile(database, "preserve");
      await canvasExtension.start({ getDataDir: () => root } as never);
      const toolRegistry = getDashboardRegistry(
        path.join(root, "canvas", "registry.json")
      );
      const [linkTool, versionsTool, deleteTool] =
        await canvasExtension.getAgentTools!(configuredAgent, { config });
      const first = (await linkTool.execute(
        { slug: "hello.html" },
        {} as never
      )) as { link: string };
      await fs.writeFile(file, "<h1>second</h1>");
      await versionsTool.execute({ slug: "hello.html" }, {} as never);
      const registration = (await toolRegistry.list(configuredAgent.id))[0];
      const versionsDirectory = path.join(
        root,
        "canvas",
        "versions",
        registration.id
      );
      const routes = createDashboardRoutes({
        getConfig: () => config,
        getAgent: () => configuredAgent,
        registry: toolRegistry,
        authenticate: async () => ({}),
        hasAgentAccess: async () => true,
      });

      await expect(
        deleteTool.execute({ slug: "hello.html" }, {} as never)
      ).resolves.toEqual({
        slug: "hello.html",
        removed: { file: true, registry: true, versions: true },
        message: "Dashboard deleted",
      });
      await expect(fs.access(file)).rejects.toThrow();
      await expect(fs.access(versionsDirectory)).rejects.toThrow();
      expect(await toolRegistry.list(configuredAgent.id)).toEqual([]);
      expect(
        await listAgentDashboards(configuredAgent, toolRegistry, config)
      ).toEqual([]);
      expect((await routes.request(new URL(first.link).pathname)).status).toBe(
        404
      );
      expect(await fs.readFile(database, "utf8")).toBe("preserve");

      await expect(
        deleteTool.execute({ slug: "hello.html" }, {} as never)
      ).resolves.toEqual({
        slug: "hello.html",
        removed: { file: false, registry: false, versions: false },
        message: "Nothing to delete",
      });

      await fs.writeFile(file, "<h1>new</h1>");
      const recreated = (await linkTool.execute(
        { slug: "hello.html" },
        {} as never
      )) as { link: string };
      expect(recreated.link).not.toBe(first.link);
      const recreatedRegistration = (
        await toolRegistry.list(configuredAgent.id)
      )[0];
      expect(
        await toolRegistry.listVersions(recreatedRegistration.id)
      ).toHaveLength(1);
    }
  );

  it("does not follow a dashboard directory swapped during deletion", async () => {
    const dashboards = dashboardDirectory(agent());
    const outside = path.join(root, "outside");
    const moved = path.join(root, "moved-dashboards");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(dashboards, "hello.html"), "inside");
    await fs.writeFile(path.join(outside, "hello.html"), "outside");
    await canvasExtension.start({ getDataDir: () => root } as never);
    const tools = await canvasExtension.getAgentTools!(agent(), { config });
    await tools[0].execute({ slug: "hello.html" }, {} as never);

    const realpath = fs.realpath.bind(fs);
    let directoryChecks = 0;
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      if (String(candidate) === dashboards && ++directoryChecks === 3) {
        await fs.rename(dashboards, moved);
        await fs.symlink(outside, dashboards);
      }
      return realpath(candidate);
    });

    await expect(
      tools[2].execute({ slug: "hello.html" }, {} as never)
    ).rejects.toThrow("Dashboard not found");
    expect(await fs.readFile(path.join(outside, "hello.html"), "utf8")).toBe(
      "outside"
    );
  });

  it("rejects unsafe registration ids without deleting outside versions", async () => {
    const registryFile = path.join(root, "unsafe", "registry.json");
    const outside = path.join(root, "outside-versions");
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.html"), "keep");
    await fs.writeFile(
      registryFile,
      JSON.stringify({
        dashboards: [
          { id: "../../outside-versions", agentId: "agent-1", slug: "x.html" },
        ],
      })
    );
    const unsafeRegistry = new DashboardRegistry(registryFile);

    await expect(unsafeRegistry.delete("agent-1", "x.html")).rejects.toThrow(
      "Invalid dashboard registration id"
    );
    expect(await fs.readFile(path.join(outside, "keep.html"), "utf8")).toBe(
      "keep"
    );
  });

  it("rejects symlinked dashboard files and directories", async () => {
    const outside = path.join(root, "outside.html");
    await fs.writeFile(outside, "secret");
    await fs.symlink(
      outside,
      path.join(workspace, "data", "dashboards", "linked.html")
    );
    await expect(openDashboardFile(agent(), "linked.html")).rejects.toThrow(
      "Dashboard not found"
    );

    await fs.rm(path.join(workspace, "data", "dashboards"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "outside"));
    await fs.writeFile(path.join(root, "outside", "hello.html"), "secret");
    await fs.symlink(
      path.join(root, "outside"),
      path.join(workspace, "data", "dashboards")
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
      path.join(workspace, "data", "dashboards", "hello.html"),
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
      path.join(workspace, "data", "dashboards", "hello.html"),
      "<h1>edited</h1>"
    );
    expect(await (await routes.request(`/${entry.id}`)).text()).toContain(
      "edited"
    );
    expect(await registry.listVersions(entry.id)).toHaveLength(2);
  });

  it("injects live query data, viewer bindings, params, and dashboard links before page scripts", async () => {
    const databasePath = path.join(workspace, "data", "live.db");
    const db = new Database(databasePath);
    db.exec(
      "create table items(id integer primary key, owner text, label text); insert into items values (1, 'viewer@example.com', 'first')"
    );
    db.close();
    const dashboard = `<script type="application/sql" data-name="items" data-db="data/live.db">select label from items where owner = :viewer_email and id = :id</script><script type="application/sql" data-name="summary" data-db="data/live.db">select count(*) as count, :viewer_name as viewer_name, :today as today from items</script><script>window.seen=YOPLAI.data.items</script>`;
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "hello.html"),
      dashboard
    );
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "detail.html"),
      "<h1>detail</h1>"
    );
    const { app: routes, entry } = await app(
      { user: { email: "viewer@example.com", name: "Viewer" } },
      true
    );

    const first = await (await routes.request(`/${entry.id}?id=1`)).text();
    expect(first.indexOf("window.YOPLAI")).toBeLessThan(
      first.indexOf("window.seen")
    );
    expect(first).toContain('"label":"first"');
    expect(first).toContain('"email":"viewer@example.com"');
    expect(first).toContain('"name":"Viewer"');
    expect(first).toContain('"id":"1"');
    expect(first).toContain(
      `"summary":[{"count":1,"viewer_name":"Viewer","today":"${new Date().toISOString().slice(0, 10)}"}]`
    );
    const detail = (await registry.list("agent-1")).find(
      (item) => item.slug === "detail.html"
    )!;
    expect(first).toContain(`"detail.html":"/d/${detail.id}"`);

    const updated = new Database(databasePath);
    updated.prepare("update items set label = ? where id = 1").run("second");
    updated.close();
    expect(await (await routes.request(`/${entry.id}?id=1`)).text()).toContain(
      '"label":"second"'
    );
  });

  it("binds URL params instead of interpolating SQL", async () => {
    const databasePath = path.join(workspace, "data", "safe.db");
    const db = new Database(databasePath);
    db.exec("create table items(id text); insert into items values ('safe')");
    db.close();
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "hello.html"),
      `<script type="application/sql" data-name="items" data-db="data/safe.db">select id from items where id = :id</script>`
    );
    const { app: routes, entry } = await app({}, true);
    const attack = encodeURIComponent("safe' OR 1=1 --");
    const body = await (
      await routes.request(`/${entry.id}?id=${attack}`)
    ).text();
    expect(body).toContain('"items":[]');
  });

  it("shows query failures without returning 500", async () => {
    const databasePath = path.join(workspace, "data", "bad.db");
    new Database(databasePath).close();
    await fs.writeFile(
      path.join(workspace, "data", "dashboards", "hello.html"),
      `<script type="application/sql" data-name="broken" data-db="data/bad.db">select * from missing</script>`
    );
    const { app: routes, entry } = await app({}, true);
    const response = await routes.request(`/${entry.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dashboard query error");
  });
});

describe("dashboard kit assets", () => {
  it("serves the deployment theme mapping without caching", async () => {
    vi.stubEnv("YOPLAI_HOME", root);
    await fs.writeFile(
      path.join(root, "theme.css"),
      ":root { --bg-base: #010203; }"
    );
    const response = await createDashboardAssetRoutes(() => config).request(
      "/theme.css"
    );
    const css = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(css).toContain("--dk-bg: var(--bg-base)");
    expect(css).toContain(":root:root:not(");
    expect(css).not.toContain("--dk-positive");
    expect(css).toMatch(/}\n:root \{ --bg-base: #010203; \}$/);
  });

  it("serves an empty deployment theme when theme.css is absent", async () => {
    vi.stubEnv("YOPLAI_HOME", root);
    const response = await createDashboardAssetRoutes(() => config).request(
      "/theme.css"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("");
  });

  it("serves only fixed versioned public assets with immutable caching", async () => {
    const routes = createDashboardAssetRoutes(() => config);
    const response = await routes.request("/v1/kit.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("DashboardKit");
    expect((await routes.request("/v2/kit.js")).status).toBe(404);
    expect((await routes.request("/v1/../routes.ts")).status).toBe(404);
    const alias = await routes.request("/kit.js");
    expect(alias.status).toBe(302);
    expect(alias.headers.get("location")).toBe("/d-assets/v1/kit.js");
    expect(alias.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await routes.request("/kit.css")).headers.get("location")).toBe(
      "/d-assets/v1/kit.css"
    );
    expect((await routes.request("/echarts.js")).status).toBe(404);
  });

  it("sandboxes the sample.html asset with the dashboard CSP but not kit.js", async () => {
    const routes = createDashboardAssetRoutes(() => config);
    const sample = await routes.request("/v1/sample.html");
    expect(sample.headers.get("content-security-policy")).toMatch(/^sandbox/);
    const kit = await routes.request("/v1/kit.js");
    expect(kit.headers.get("content-security-policy")).toBeNull();
  });

  it("sanitizes markdown and exports valid CSV", async () => {
    const routes = createDashboardAssetRoutes(() => config);
    const dom = new JSDOM("<div id='markdown'></div>", {
      runScripts: "outside-only",
      url: "https://yoplai.test",
    });
    for (const asset of ["marked.js", "purify.js", "kit.js"]) {
      dom.window.eval(await (await routes.request(`/v1/${asset}`)).text());
    }
    const kit = (
      dom.window as unknown as {
        DashboardKit: {
          md(target: string, markdown: string): void;
          csv(
            rows: Array<Record<string, unknown>>,
            columns: Array<{ key: string; label: string }>
          ): string;
        };
      }
    ).DashboardKit;
    kit.md(
      "#markdown",
      '# Hello\n<script>window.pwned=true</script><img src=x onerror="window.pwned=true">'
    );
    expect(dom.window.document.querySelector("h1")?.textContent).toBe("Hello");
    expect(dom.window.document.querySelector("script")).toBeNull();
    expect(
      dom.window.document.querySelector("img")?.hasAttribute("onerror")
    ).toBe(false);
    expect(
      (dom.window as unknown as { pwned?: boolean }).pwned
    ).toBeUndefined();
    expect(
      kit.csv(
        [{ name: 'A "quote"', value: "1,200" }],
        [
          { key: "name", label: "Name" },
          { key: "value", label: "Value" },
        ]
      )
    ).toBe('"Name","Value"\r\n"A ""quote""","1,200"');
  });
});

describe("dashboard SQL", () => {
  it("confines real database paths and opens databases read-only", async () => {
    const outside = path.join(root, "outside.db");
    new Database(outside).close();
    await expect(
      resolveDashboardDatabase(agent(), "../outside.db")
    ).rejects.toThrow("escapes");
    await fs.symlink(outside, path.join(workspace, "data", "linked.db"));
    await expect(
      resolveDashboardDatabase(agent(), "data/linked.db")
    ).rejects.toThrow("escapes");

    const inside = path.join(workspace, "data", "readonly.db");
    const db = new Database(inside);
    db.exec("create table items(id integer)");
    db.close();
    const result = await executeDashboardQueries(
      agent(),
      `<script type="application/sql" data-name="write" data-db="data/readonly.db">insert into items values (1) returning id</script>`,
      {}
    );
    expect(result.errors[0]?.error).toMatch(/readonly|read-only/i);
    const check = new Database(inside, { readonly: true });
    expect(check.prepare("select count(*) count from items").get()).toEqual({
      count: 0,
    });
    check.close();
  });

  it("caps each query at 5000 rows", async () => {
    const databasePath = path.join(workspace, "data", "rows.db");
    const db = new Database(databasePath);
    db.exec("create table rows(value integer)");
    const insert = db.prepare("insert into rows values (?)");
    db.transaction(() => {
      for (let value = 0; value < DASHBOARD_QUERY_ROW_LIMIT + 10; value++)
        insert.run(value);
    })();
    db.close();
    const result = await executeDashboardQueries(
      agent(),
      `<script type="application/sql" data-name="rows" data-db="data/rows.db">select * from rows</script>`,
      {}
    );
    expect(result.errors).toEqual([]);
    expect(result.data.rows).toHaveLength(DASHBOARD_QUERY_ROW_LIMIT);
  });

  it("rejects excessive declarations and dangerous result names", () => {
    const query = (name: string) =>
      `<script type="application/sql" data-name="${name}" data-db="data/x.db">select 1</script>`;
    expect(() => parseDashboardQueries(query("__proto__"))).toThrow("Unsafe");
    expect(() =>
      parseDashboardQueries(
        Array.from({ length: 21 }, (_, index) => query(`q${index}`)).join("")
      )
    ).toThrow("query limit");
    expect(() =>
      parseDashboardQueries(
        `<script type="application/sql" data-name="large" data-db="data/x.db">select '${"x".repeat(DASHBOARD_SQL_BYTE_LIMIT)}'</script>`
      )
    ).toThrow("100KB");
  });

  it("rejects oversized serialized results", async () => {
    const databasePath = path.join(workspace, "data", "large.db");
    new Database(databasePath).close();
    await expect(
      runDashboardQuery(
        path.dirname(databasePath),
        path.basename(databasePath),
        `select printf('%.*c', ${DASHBOARD_RESULT_BYTE_LIMIT + 1}, 'x') as value`,
        {}
      )
    ).rejects.toThrow("5MB");
  });

  it("reads current WAL rows from the anchored snapshot", async () => {
    const databasePath = path.join(workspace, "data", "wal.db");
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.exec("create table items(value text)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare("insert into items values (?)").run("live");
    const query = `<script type="application/sql" data-name="items" data-db="data/wal.db">select value from items</script>`;
    await expect(executeDashboardQueries(agent(), query, {})).resolves.toEqual({
      data: { items: [{ value: "live" }] },
      errors: [],
    });
    db.prepare("update items set value = ?").run("updated");
    const updated = await executeDashboardQueries(agent(), query, {});
    expect(updated.data.items).toEqual([{ value: "updated" }]);
    db.close();
  });

  it("stays consistent while a WAL writer updates and checkpoints", async () => {
    const databasePath = path.join(workspace, "data", "wal-stress.db");
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.exec(
      "create table counter(value integer); insert into counter values (0)"
    );
    let value = 0;
    const timer = setInterval(() => {
      value += 1;
      db.prepare("update counter set value = ?").run(value);
      db.pragma("wal_checkpoint(PASSIVE)");
    }, 2);
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          runDashboardQuery(
            path.dirname(databasePath),
            path.basename(databasePath),
            "select value from counter",
            {}
          )
        )
      );
      expect(results).toHaveLength(12);
      for (const rows of results) {
        expect(rows).toEqual([{ value: expect.any(Number) }]);
      }
    } finally {
      clearInterval(timer);
      db.close();
    }
  });

  it("rejects direct symlink paths in the worker snapshot", async () => {
    const databasePath = path.join(workspace, "data", "real.db");
    new Database(databasePath).close();
    await fs.symlink(databasePath, path.join(workspace, "data", "alias.db"));
    await expect(
      runDashboardQuery(workspace, "data/alias.db", "select 1", {})
    ).rejects.toThrow();
  });

  it("bounds process-wide worker admission and recovers", async () => {
    const databasePath = path.join(workspace, "data", "admission.db");
    new Database(databasePath).close();
    const calls = Array.from(
      { length: DASHBOARD_WORKER_LIMIT + DASHBOARD_WORKER_QUEUE_LIMIT + 1 },
      () =>
        runDashboardQuery(
          path.dirname(databasePath),
          path.basename(databasePath),
          "with recursive n(x) as (select 1 union all select x + 1 from n) select sum(x) from n",
          {},
          50
        )
    );
    const results = await Promise.allSettled(calls);
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          String(result.reason).includes("queue is full")
      )
    ).toBe(true);
    await expect(
      runDashboardQuery(
        path.dirname(databasePath),
        path.basename(databasePath),
        "select 1 as ok",
        {}
      )
    ).resolves.toEqual([{ ok: 1 }]);
  });

  it("executes YOPLAI.link and safely serializes closing script text", () => {
    const html = injectDashboardRuntime(
      '<html><head><link href="/d-assets/v1/kit.css" rel="stylesheet"></head><body><script>window.loaded=true</script></body></html>',
      {
        data: {
          rows: [{ value: "</script><script>window.pwned=true</script>" }],
        },
        viewer: { email: null, name: null },
        params: {},
        links: { "detail.html": "/d/detail-id" },
        errors: [],
      }
    );
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "https://yoplai.test/d/source",
    });
    const window = dom.window as unknown as {
      YOPLAI: { link(slug: string, params: Record<string, string>): string };
      pwned?: boolean;
      loaded?: boolean;
    };
    expect(window.YOPLAI.link("detail.html", { id: "a&b" })).toBe(
      "/d/detail-id?id=a%26b"
    );
    expect(window.loaded).toBe(true);
    expect(window.pwned).toBeUndefined();
    const styles = [
      ...dom.window.document.querySelectorAll("link[rel=stylesheet]"),
    ];
    expect(styles.map((style) => style.getAttribute("href"))).toEqual([
      "/d-assets/v1/kit.css",
      "/d-assets/theme.css",
    ]);
    dom.window.close();
  });

  it("injects the deployment theme into dashboard fragments", () => {
    const html = injectDashboardRuntime("<main>Dashboard</main>", {
      data: {},
      viewer: { email: null, name: null },
      params: {},
      links: {},
      errors: [],
    });
    expect(html).toContain(
      '<link rel="stylesheet" href="/d-assets/theme.css">'
    );
    expect(html.indexOf("/d-assets/theme.css")).toBeLessThan(
      html.indexOf("<main>")
    );
  });

  it("preserves standards mode when a dashboard omits the closing head", () => {
    const html = injectDashboardRuntime(
      "<!doctype html><html><body>Dashboard</body></html>",
      {
        data: {},
        viewer: { email: null, name: null },
        params: {},
        links: {},
        errors: [],
      }
    );
    const dom = new JSDOM(html);
    expect(html).toMatch(/^<!doctype html><link rel="stylesheet"/);
    expect(dom.window.document.compatMode).toBe("CSS1Compat");
    dom.window.close();
  });

  it("stamps data-theme=light on <html> from a light theme cookie", () => {
    const html = injectDashboardRuntime(
      "<html><head></head><body>Dashboard</body></html>",
      { data: {}, viewer: { email: null, name: null }, params: {}, links: {}, errors: [] },
      "light"
    );
    expect(html).toMatch(/<html[^>]*\bdata-theme="light"/);
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("stamps data-theme=dark on <html> from a dark theme cookie", () => {
    const html = injectDashboardRuntime(
      "<html><head></head><body>Dashboard</body></html>",
      { data: {}, viewer: { email: null, name: null }, params: {}, links: {}, errors: [] },
      "dark"
    );
    expect(html).toMatch(/<html[^>]*\bdata-theme="dark"/);
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("does not touch an explicit data-theme already set by the agent", () => {
    const html = injectDashboardRuntime(
      '<html data-theme="dark"><head></head><body>Dashboard</body></html>',
      { data: {}, viewer: { email: null, name: null }, params: {}, links: {}, errors: [] },
      "light"
    );
    expect(html.match(/data-theme="/g)).toHaveLength(1);
    expect(html).toMatch(/<html[^>]*\bdata-theme="dark"/);
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("falls back to a prefers-color-scheme script when the cookie is missing or invalid", () => {
    const missing = injectDashboardRuntime(
      "<html><head></head><body>Dashboard</body></html>",
      { data: {}, viewer: { email: null, name: null }, params: {}, links: {}, errors: [] },
      null
    );
    expect(missing).toContain("prefers-color-scheme: light");
    expect(missing).not.toMatch(/<html[^>]*\bdata-theme=/);

    const invalid = injectDashboardRuntime(
      "<html><head></head><body>Dashboard</body></html>",
      { data: {}, viewer: { email: null, name: null }, params: {}, links: {}, errors: [] },
      "purple" as never
    );
    expect(invalid).toContain("prefers-color-scheme: light");
    expect(invalid).not.toMatch(/<html[^>]*\bdata-theme=/);
  });

  describe("parseThemeCookie", () => {
    it("extracts a valid light/dark value from a Cookie header", () => {
      expect(parseThemeCookie("yoplai-theme=light")).toBe("light");
      expect(parseThemeCookie("foo=bar; yoplai-theme=dark; baz=qux")).toBe(
        "dark"
      );
    });

    it("returns null for missing or invalid cookies", () => {
      expect(parseThemeCookie(undefined)).toBeNull();
      expect(parseThemeCookie("foo=bar")).toBeNull();
      expect(parseThemeCookie("yoplai-theme=purple")).toBeNull();
    });
  });

  it("terminates a query that exceeds its deadline", async () => {
    const databasePath = path.join(workspace, "data", "timeout.db");
    new Database(databasePath).close();
    await expect(
      runDashboardQuery(
        path.dirname(databasePath),
        path.basename(databasePath),
        "with recursive n(x) as (select 1 union all select x + 1 from n) select sum(x) from n",
        {},
        50
      )
    ).rejects.toThrow("timed out");
    await expect(
      runDashboardQuery(
        path.dirname(databasePath),
        path.basename(databasePath),
        "select 42 as answer",
        {}
      )
    ).resolves.toEqual([{ answer: 42 }]);
  });

  it("keeps capture directories outside agent data and removes them", async () => {
    const dataRoot = path.join(workspace, "data");
    const databasePath = path.join(dataRoot, "capture.db");
    new Database(databasePath).close();
    const query = runDashboardQuery(
      dataRoot,
      path.basename(databasePath),
      "with recursive n(x) as (select 1 union all select x + 1 from n) select sum(x) from n",
      {},
      300
    );
    let captures: string[] = [];
    for (let attempt = 0; attempt < 20 && captures.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      captures = (await fs.readdir(workspace)).filter((name) =>
        name.startsWith(".yoplai-sql-")
      );
    }
    expect(captures).toHaveLength(1);
    expect(
      (await fs.readdir(dataRoot)).filter((name) =>
        name.startsWith(".yoplai-sql-")
      )
    ).toEqual([]);
    await expect(query).rejects.toThrow("timed out");
    expect(
      (await fs.readdir(workspace)).filter((name) =>
        name.startsWith(".yoplai-sql-")
      )
    ).toEqual([]);
  });
});
