import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  ExtensionAgentTool,
  GatewayConfig,
} from "@yoplai/shared";
import { registerSlackPairingLinkProvider } from "@yoplai/shared";
import { canvasExtension } from "./index.js";
import { getDashboardRegistry } from "./store.js";

let root: string;
let agent: AgentConfig;
let tools: ExtensionAgentTool[];
const config = {
  canvas: { enabled: true },
  agents: [],
} as unknown as GatewayConfig;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-tools-"));
  agent = { id: "agent", name: "Agent", workspace: root } as AgentConfig;
  await fs.mkdir(path.join(root, "data", "dashboards"), { recursive: true });
  await canvasExtension.start({ getDataDir: () => root } as never);
  tools = await canvasExtension.getAgentTools!(agent, { config });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await canvasExtension.stop();
  await fs.rm(root, { recursive: true, force: true });
});

it.each(["dashboard_link", "dashboard_update", "dashboard_versions"])(
  "marks an unregistered dashboard requested through %s as invalid input",
  async (name) => {
    await expect(
      tools
        .find((tool) => tool.name === name)!
        .execute({ slug: "missing.html" }, {} as never)
    ).rejects.toMatchObject({
      message: "Dashboard not found",
      code: "invalid_input",
    });
  }
);

it.each(["dashboard_update", "dashboard_versions", "dashboard_delete"])(
  "marks masked access denial through %s as invalid input",
  async (name) => {
    const registry = getDashboardRegistry(
      path.join(root, "canvas", "registry.json")
    );
    await registry.createOwned(
      "agent",
      "private.html",
      "alice",
      "<h1>Private</h1>"
    );
    await expect(
      tools
        .find((tool) => tool.name === name)!
        .execute({ slug: "private.html" }, {
          actorKind: "eval",
          actorUserId: "bob",
        } as never)
    ).rejects.toMatchObject({
      message: "Dashboard not found",
      code: "invalid_input",
    });
  }
);

it("marks a private dashboard link's masked access denial as invalid input", async () => {
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  await registry.createOwned(
    "agent",
    "private.html",
    "alice",
    "<h1>Private</h1>"
  );
  await expect(
    tools
      .find((tool) => tool.name === "dashboard_link")!
      .execute({ slug: "private.html" }, {
        actorKind: "eval",
        actorUserId: "bob",
      } as never)
  ).rejects.toMatchObject({
    message: "Dashboard not found",
    code: "invalid_input",
  });
});

it("marks dashboard links without agent access as invalid input", async () => {
  const restricted = await canvasExtension.getAgentTools!(agent, {
    config: {
      ...config,
      extensions: { multiUser: { enabled: true } },
    } as GatewayConfig,
  });
  await expect(
    restricted
      .find((tool) => tool.name === "dashboard_link")!
      .execute({}, {
        actorUserId: "unknown-user",
      } as never)
  ).rejects.toMatchObject({
    message: "Dashboard not found",
    code: "invalid_input",
  });
});

it("marks dashboard creation without an eligible owner as invalid input", async () => {
  await expect(
    tools
      .find((tool) => tool.name === "dashboard_create")!
      .execute({ slug: "private.html" }, {
        actorKind: "eval",
      } as never)
  ).rejects.toMatchObject({
    message: "Dashboard not found",
    code: "invalid_input",
  });
});

it("marks deletion of a missing dashboard by an ineligible caller as invalid input", async () => {
  await expect(
    tools
      .find((tool) => tool.name === "dashboard_delete")!
      .execute({ slug: "missing.html" }, {
        actorKind: "eval",
      } as never)
  ).rejects.toMatchObject({
    message: "Dashboard not found",
    code: "invalid_input",
  });
});

it("keeps a stopped canvas untagged", async () => {
  await canvasExtension.stop();
  const error = await Promise.resolve(tools
    .find((tool) => tool.name === "dashboard_update")!
    .execute({ slug: "missing.html" }, {} as never))
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ message: "Canvas is not started" });
  expect(error).not.toHaveProperty("code");
});

it("creates a private owned publication once and link never publishes a later draft", async () => {
  const file = path.join(root, "data", "dashboards", "page.html");
  await fs.writeFile(file, "<h1>PUBLISHED-1</h1>");
  const create = tools.find((tool) => tool.name === "dashboard_create")!;
  const link = tools.find((tool) => tool.name === "dashboard_link")!;
  const created = await create.execute({ slug: "page.html" }, {} as never);
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  const [entry] = await registry.list("agent");
  expect(entry).toMatchObject({
    ownerUserId: "local",
    shares: [],
    publishedAt: expect.any(String),
  });
  expect(await registry.readPublished(entry.id)).toBe("<h1>PUBLISHED-1</h1>");
  await fs.writeFile(file, "<h1>DRAFT-2</h1>");
  expect(await link.execute({ slug: "page.html" }, {} as never)).toEqual({
    slug: "page.html",
    link: (created as { link: string }).link,
  });
  expect(await registry.readPublished(entry.id)).toBe("<h1>PUBLISHED-1</h1>");
  expect(await registry.listVersions(entry.id)).toHaveLength(1);
  await expect(
    create.execute({ slug: "page.html" }, {} as never)
  ).rejects.toThrow("not found");
  expect(await registry.readPublished(entry.id)).toBe("<h1>PUBLISHED-1</h1>");
});

it("publishes drafts, restores a missing working file, and deletes without losing database files", async () => {
  const file = path.join(root, "data", "dashboards", "page.html");
  const database = path.join(root, "data", "keep.db");
  await fs.writeFile(file, "<h1>ONE</h1>");
  await fs.writeFile(database, "database");
  const create = tools.find((tool) => tool.name === "dashboard_create")!;
  const update = tools.find((tool) => tool.name === "dashboard_update")!;
  const versions = tools.find((tool) => tool.name === "dashboard_versions")!;
  const remove = tools.find((tool) => tool.name === "dashboard_delete")!;
  await create.execute({ slug: "page.html" }, {} as never);
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  const [entry] = await registry.list("agent");
  const original = (await registry.listVersions(entry.id))[0];
  await fs.writeFile(file, "<h1>TWO</h1>");
  await update.execute({ slug: "page.html" }, {} as never);
  expect(await registry.readPublished(entry.id)).toBe("<h1>TWO</h1>");
  await fs.rm(file);
  await versions.execute(
    { slug: "page.html", restore: original.id },
    {} as never
  );
  expect(await fs.readFile(file, "utf8")).toBe("<h1>ONE</h1>");
  expect(await registry.readPublished(entry.id)).toBe("<h1>ONE</h1>");
  expect(await registry.get(entry.id)).toMatchObject({
    ownerUserId: "local",
    shares: [],
  });
  await remove.execute({ slug: "page.html" }, {} as never);
  expect(await registry.get(entry.id)).toBeUndefined();
  await expect(registry.readPublished(entry.id)).rejects.toThrow();
  expect(await fs.readFile(database, "utf8")).toBe("database");
});

it("returns the existing Slack pairing link without registering an unpaired request", async () => {
  const multiUserConfig = {
    ...config,
    extensions: { multiUser: { enabled: true } },
  } as GatewayConfig;
  const unpairedTools = await canvasExtension.getAgentTools!(agent, {
    config: multiUserConfig,
  });
  const create = unpairedTools.find(
    (tool) => tool.name === "dashboard_create"
  )!;
  const unregister = registerSlackPairingLinkProvider(
    async () => "https://test.invalid/pair"
  );
  try {
    const result = await create.execute({ slug: "page.html" }, {
      actorKind: "service",
    } as never);
    expect(result).toEqual({
      isError: true,
      error: "slack_pairing_required",
      link: "https://test.invalid/pair",
      message:
        "Pair your Slack account at https://test.invalid/pair, then ask again. No dashboard was registered.",
    });
    expect(
      await getDashboardRegistry(
        path.join(root, "canvas", "registry.json")
      ).all()
    ).toEqual([]);
  } finally {
    unregister();
  }
});

it.each([false, true])(
  "keeps publication after history pruning and identical updates (Git: %s)",
  async (git) => {
    if (git) await fs.mkdir(path.join(root, ".git"));
    const file = path.join(root, "data", "dashboards", "page.html");
    const create = tools.find((tool) => tool.name === "dashboard_create")!;
    const update = tools.find((tool) => tool.name === "dashboard_update")!;
    const versions = tools.find((tool) => tool.name === "dashboard_versions")!;
    await fs.writeFile(file, "<h1>0</h1>");
    await create.execute({ slug: "page.html" }, {} as never);
    const registry = getDashboardRegistry(
      path.join(root, "canvas", "registry.json")
    );
    const [entry] = await registry.list("agent");
    for (let version = 1; version <= 22; version++) {
      await fs.writeFile(file, `<h1>${version}</h1>`);
      await update.execute({ slug: "page.html" }, {} as never);
    }
    await update.execute({ slug: "page.html" }, {} as never);
    expect(await registry.readPublished(entry.id)).toBe("<h1>22</h1>");
    const result = (await versions.execute(
      { slug: "page.html" },
      {} as never
    )) as { managed: boolean; versions: { id: string }[] };
    expect(result.managed).toBe(!git);
    expect(result.versions).toHaveLength(git ? 0 : 20);
    if (!git)
      expect(
        await registry.readVersion(entry.id, result.versions.at(-1)!.id)
      ).toBe("<h1>3</h1>");
  }
);

it("does not register a dashboard when durable publication cannot be written", async () => {
  const file = path.join(root, "data", "dashboards", "page.html");
  await fs.writeFile(file, "<h1>SAFE</h1>");
  await fs.mkdir(path.join(root, "canvas"), { recursive: true });
  await fs.writeFile(path.join(root, "canvas", "published"), "not a directory");
  const create = tools.find((tool) => tool.name === "dashboard_create")!;
  await expect(
    create.execute({ slug: "page.html" }, {} as never)
  ).rejects.toThrow();
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  expect(await registry.all()).toEqual([]);
  expect(await fs.readFile(file, "utf8")).toBe("<h1>SAFE</h1>");
  await fs.rm(path.join(root, "canvas", "published"));
  await create.execute({ slug: "page.html" }, {} as never);
  const [entry] = await registry.list("agent");
  expect(await registry.readPublished(entry.id)).toBe("<h1>SAFE</h1>");
});

it("keeps the previous publication intact when atomic replacement fails", async () => {
  const file = path.join(root, "data", "dashboards", "page.html");
  await fs.writeFile(file, "<h1>PREVIOUS</h1>");
  const create = tools.find((tool) => tool.name === "dashboard_create")!;
  const update = tools.find((tool) => tool.name === "dashboard_update")!;
  await create.execute({ slug: "page.html" }, {} as never);
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  const [entry] = await registry.list("agent");
  await fs.writeFile(file, "<h1>NEXT</h1>");
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValueOnce(new Error("disk full"));
  await expect(
    update.execute({ slug: "page.html" }, {} as never)
  ).rejects.toThrow("disk full");
  rename.mockRestore();
  expect(await registry.readPublished(entry.id)).toBe("<h1>PREVIOUS</h1>");
  await update.execute({ slug: "page.html" }, {} as never);
  expect(await registry.readPublished(entry.id)).toBe("<h1>NEXT</h1>");
});

it.each(["revoke", "replace"] as const)(
  "rechecks queued writes after %s instead of applying stale authorization",
  async (change) => {
    const file = path.join(root, "data", "dashboards", "page.html");
    await fs.writeFile(file, "<h1>ORIGINAL</h1>");
    const create = tools.find((tool) => tool.name === "dashboard_create")!;
    const update = tools.find((tool) => tool.name === "dashboard_update")!;
    await create.execute({ slug: "page.html" }, {} as never);
    const registry = getDashboardRegistry(
      path.join(root, "canvas", "registry.json")
    );
    const [entry] = await registry.list("agent");
    await registry.replaceShares(entry.id, [
      { kind: "user", id: "bob", mode: "write" },
    ]);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const changeAccess = registry.withRegistration(entry.id, async () => {
      entered();
      await blocked;
      if (change === "revoke") await registry.replaceShares(entry.id, []);
      else {
        await registry.deleteId(entry.id);
        await registry.createOwned(
          "agent",
          "page.html",
          "carol",
          "<h1>REPLACEMENT</h1>"
        );
      }
    });
    await started;
    let found!: () => void;
    const lookedUp = new Promise<void>((resolve) => {
      found = resolve;
    });
    const find = registry.find.bind(registry);
    vi.spyOn(registry, "find").mockImplementationOnce(async (...args) => {
      const result = await find(...args);
      found();
      return result;
    });
    const queuedWrite = update.execute({ slug: "page.html" }, {
      actorKind: "eval",
      actorUserId: "bob",
    } as never);
    await lookedUp;
    const denied = expect(queuedWrite).rejects.toThrow("not found");
    release();
    await changeAccess;
    await denied;
    const current = await registry.find("agent", "page.html");
    expect(await registry.readPublished(current!.id)).toBe(
      change === "revoke" ? "<h1>ORIGINAL</h1>" : "<h1>REPLACEMENT</h1>"
    );
    expect(current!.ownerUserId).toBe(change === "revoke" ? "local" : "carol");
  }
);

it("enforces writer, reader and Team publication modes through actual tools", async () => {
  const file = path.join(root, "data", "dashboards", "page.html");
  await fs.writeFile(file, "<h1>ORIGINAL</h1>");
  await tools
    .find((tool) => tool.name === "dashboard_create")!
    .execute({ slug: "page.html" }, {} as never);
  const registry = getDashboardRegistry(
    path.join(root, "canvas", "registry.json")
  );
  const [entry] = await registry.list("agent");
  const multiUserConfig = {
    ...config,
    extensions: { multiUser: { enabled: true } },
  } as GatewayConfig;
  const sharedTools = await canvasExtension.getAgentTools!(agent, {
    config: multiUserConfig,
  });
  const update = sharedTools.find((tool) => tool.name === "dashboard_update")!;
  const remove = sharedTools.find((tool) => tool.name === "dashboard_delete")!;
  const history = sharedTools.find(
    (tool) => tool.name === "dashboard_versions"
  )!;
  const bob = { actorKind: "eval", actorUserId: "bob" } as never;
  const service = { actorKind: "service" } as never;
  await registry.replaceShares(entry.id, [
    { kind: "user", id: "bob", mode: "read" },
  ]);
  await expect(update.execute({ slug: "page.html" }, bob)).rejects.toThrow(
    "not found"
  );
  await expect(history.execute({ slug: "page.html" }, bob)).rejects.toThrow(
    "not found"
  );
  await registry.replaceShares(entry.id, [
    { kind: "user", id: "bob", mode: "write" },
  ]);
  await fs.writeFile(file, "<h1>WRITER</h1>");
  await update.execute({ slug: "page.html" }, bob);
  expect(await registry.readPublished(entry.id)).toBe("<h1>WRITER</h1>");
  await expect(remove.execute({ slug: "page.html" }, bob)).rejects.toThrow(
    "not found"
  );
  await expect(update.execute({ slug: "page.html" }, service)).rejects.toThrow(
    "not found"
  );
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "read" }]);
  await expect(update.execute({ slug: "page.html" }, service)).rejects.toThrow(
    "not found"
  );
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "write" }]);
  await fs.writeFile(file, "<h1>TEAM</h1>");
  await update.execute({ slug: "page.html" }, service);
  expect(await registry.readPublished(entry.id)).toBe("<h1>TEAM</h1>");
  expect(await registry.get(entry.id)).toMatchObject({
    ownerUserId: "local",
    shares: [{ kind: "all", mode: "write" }],
  });
});
