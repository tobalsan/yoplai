import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { createDashboardRoutes, dashboardCsp } from "./routes.js";
import { DashboardRegistry } from "./store.js";
import type { DashboardActor } from "./policy.js";
import { decodeDashboardEmbedMeta, DASHBOARD_EMBED_HEADERS } from "./embed-contract.js";

let root: string;
let registry: DashboardRegistry;
let agent: AgentConfig;
let canvasEnabled = true;
const config = () => ({ canvas: { enabled: canvasEnabled, baseUrl: "https://remote.example.test" } }) as GatewayConfig;

type User = { id: string; email: string; name: string };
const alice: User = { id: "alice", email: "alice@example.test", name: "Alice Martin" };
const bob: User = { id: "bob", email: "bob@example.test", name: "Bob Durand" };
const root1: User = { id: "root", email: "root@example.test", name: "Root Admin" };

type Viewer = {
  user: User | null;
  impersonating?: boolean;
  eligible?: boolean;
  superadmin?: boolean;
  hasAgentAccess?: boolean;
  existingSessions?: string[];
};

beforeEach(async () => {
  canvasEnabled = true;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-embed-"));
  registry = new DashboardRegistry(path.join(root, "canvas", "registry.json"));
  agent = { id: "agent", name: "Agent", workspace: root } as AgentConfig;
  await fs.mkdir(path.join(root, "data", "dashboards"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function routesFor(viewer: Viewer) {
  return createDashboardRoutes({
    getConfig: config,
    getAgent: (id) => (id === agent.id ? agent : undefined),
    registry,
    authenticate: async () => viewer.user
      ? { user: viewer.user, ...(viewer.impersonating ? { impersonator: { id: "admin" } } : {}) }
      : null,
    resolveActor: async (auth): Promise<DashboardActor> => ({
      userId: (auth as { user: User }).user.id,
      eligible: viewer.eligible ?? true,
      superadmin: viewer.superadmin,
      hasAgentAccess: viewer.hasAgentAccess ?? true,
    }),
    hasAgentAccess: async () => viewer.hasAgentAccess ?? true,
    getOwnerName: async () => "Alice Martin",
    sessionExists: async (_userId, _agentId, sessionId) => viewer.existingSessions?.includes(sessionId) ?? false,
  });
}

const guardedEdit = `<script type="application/json" data-yoplai-edit="actions">${JSON.stringify({
  db: "data/hr.db", table: "actions", key: "id", fields: { done: { type: "bool" } }, guard: "SELECT 1",
})}</script>`;

/** Creates an owned page with a published copy and a live draft, and returns its id. */
async function ownedPage(slug: string, published: string, draft = published, owner = alice.id, createdIn?: { sessionId: string; userId: string }): Promise<string> {
  const entry = await registry.createOwned("agent", `${slug}.html`, owner, published, createdIn);
  await fs.writeFile(path.join(root, "data", "dashboards", `${slug}.html`), draft);
  return entry.id;
}

async function embed(id: string, viewer: Viewer, init: RequestInit & { query?: string } = {}) {
  const { query = "", ...rest } = init;
  const response = await routesFor(viewer).request(`/${id}/embed${query}`, rest);
  const text = await response.text();
  return {
    response,
    text,
    status: response.status,
    meta: decodeDashboardEmbedMeta(response.headers.get(DASHBOARD_EMBED_HEADERS.meta)),
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

/** Runs the page bootstrap as a browser would, inside a document that lives at `documentUrl`. */
function boot(html: string, documentUrl: string, framed = false) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((code) => code.includes("window.YOPLAI"));
  if (!script) throw new Error("No bootstrap script");
  const fetches: Array<{ url: string; body: { token?: string } }> = [];
  const appended: object[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const listeners: Array<{ type: string; handler: (event: object) => void }> = [];
  const scrolled: string[] = [];
  const element = (id: string) => ({ scrollIntoView: () => scrolled.push(id) });
  const sandbox: Record<string, unknown> = {
    document: {
      URL: documentUrl, readyState: "complete", addEventListener: (type: string, handler: (event: object) => void) => listeners.push({ type, handler }), createElement: () => ({}), body: { append: (element: object) => appended.push(element) },
      getElementById: (id: string) => (id === "then" || id === "café" ? element(id) : null),
      getElementsByName: (name: string) => (name === "named" ? [element(name)] : []),
    },
    scrollTo: () => scrolled.push("top"),
    location: { origin: new URL(documentUrl).origin },
    URL, Object, JSON, Promise, Error, console,
    fetch: async (url: string, init: { body: string }) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.top = framed ? {} : sandbox;
  sandbox.parent = { postMessage: (message: Record<string, unknown>, targetOrigin: string) => posted.push({ ...message, targetOrigin }) };
  vm.runInNewContext(script, sandbox);
  return { appended, posted, listeners, scrolled, yoplai: sandbox.YOPLAI as { link(slug: string, params?: Record<string, unknown>): string; edit(o: object): Promise<unknown>; canEdit: boolean; canWrite: boolean }, fetches };
}

const viewerUrl = (_id: string, query = "") => `http://127.0.0.1:3000/api/relay/dashboard-views/${"G".repeat(43)}/frame${query}`;

it("sends the embed marker, the checked metadata and a bounded security policy that the local viewer replaces", async () => {
  const id = await ownedPage("overview", "<title>Overview</title><h1>Hello</h1>");
  const { response, status, meta, text } = await embed(id, { user: alice });
  expect(status).toBe(200);
  expect(response.headers.get("x-yoplai-dashboard-embed")).toBe("1");
  expect(response.headers.get("x-yoplai-dashboard-embed-assets")).toBe("v3");
  expect(response.headers.get("x-yoplai-dashboard-embed-policy")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(dashboardCsp(config()));
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(meta).toEqual({ dashboardId: id, agentId: "agent", canWrite: true, canEdit: true, chat: { sessionId: null }, annotation: true });
  // The edit token reaches the page, never the host metadata.
  const token = /"editToken":"([^"]+)"/.exec(text)![1];
  expect(response.headers.get(DASHBOARD_EMBED_HEADERS.meta)).not.toContain(token);
  expect(JSON.stringify([...response.headers.entries()])).not.toContain(token);
});

it("leaves the ordinary page route compatible: absolute links, absolute edit base, own Chat link and no embed marker", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const sibling = await ownedPage("detail", "<h1>Detail</h1>");
  const response = await routesFor({ user: alice }).request(`/${id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-yoplai-dashboard-embed")).toBeNull();
  const html = await response.text();
  const page = boot(html, `https://remote.example.test/d/${id}`);
  expect(page.yoplai.link("detail.html", { a: "1" })).toBe(`/d/${sibling}?a=1`);
  await page.yoplai.edit({ edit: "x", key: 1, field: "f", value: 1 });
  expect(page.fetches[0].url).toBe(`https://remote.example.test/d/${id}/edit`);
  // The ordinary top-level page still shows its own Chat button.
  expect(page.appended).toHaveLength(1);
  expect(html).toContain(`/chat/agent?dashboard=${id}&new=1`);
});

it("resolves sibling links and edits against the viewer document URL and keeps dashboard query parameters", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const sibling = await ownedPage("detail", "<h1>Detail</h1>");
  const { text } = await embed(id, { user: alice });
  const page = boot(text, viewerUrl(id, "?region=emea"));
  const link = page.yoplai.link("detail.html", { region: "emea", "q & more": "a b" });
  // The target names the sibling. The trusted shell treats a click on it as a request, never as a navigation.
  expect(link).toBe(`/api/relay/dashboard-views/${sibling}/?region=emea&q+%26+more=a+b`);
  await page.yoplai.edit({ edit: "actions", key: 1, field: "done", value: true });
  // The edit URL is relative, so it resolves against the document and keeps the viewer prefix.
  expect(page.fetches[0].url).toBe("./edit");
  expect(new URL(page.fetches[0].url, viewerUrl(id, "?region=emea")).pathname).toBe(`/api/relay/dashboard-views/${"G".repeat(43)}/edit`);
  expect(page.fetches[0].body.token).toBe(/"editToken":"([^"]+)"/.exec(text)![1]);
  // Served straight from the remote, the same links stay on the remote.
  const direct = boot(text, `https://remote.example.test/d/${id}/embed`);
  expect(direct.yoplai.link("detail.html")).toBe(`/d/${sibling}/`);
});

it("tells the parent when the embed page runs and turns a link click into a request instead of a navigation", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const { text } = await embed(id, { user: alice });
  const framed = boot(text, viewerUrl(id), true);
  expect(framed.posted).toEqual([{ channel: "yoplai-embed", type: "ready", targetOrigin: "*" }]);
  const click = framed.listeners.find((listener) => listener.type === "click")!.handler;
  const clickOn = (href: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    click({ defaultPrevented: false, button: 0, preventDefault: () => { prevented = true; }, target: { closest: () => ({ href, hasAttribute: () => false }) }, ...extra });
    return prevented;
  };
  const sibling = `http://127.0.0.1:3000/api/relay/dashboard-views/${"S".repeat(32)}/?region=emea`;
  expect(clickOn(sibling)).toBe(true);
  expect(clickOn("https://example.test/report")).toBe(true);
  expect(framed.posted.slice(1)).toEqual([
    { channel: "yoplai-embed", type: "link", href: sibling, targetOrigin: "*" },
    { channel: "yoplai-embed", type: "link", href: "https://example.test/report", targetOrigin: "*" },
  ]);
  // The page keeps its own behavior for the same document, other schemes, and modified clicks.
  const before = framed.posted.length;
  expect(clickOn(viewerUrl(id))).toBe(false);
  expect(clickOn("#yoplai-no-access")).toBe(false);
  expect(clickOn("mailto:a@example.test")).toBe(false);
  expect(clickOn("javascript:void(0)")).toBe(false);
  expect(clickOn(sibling, { metaKey: true })).toBe(false);
  expect(clickOn(sibling, { button: 1 })).toBe(false);
  expect(clickOn(sibling, { defaultPrevented: true })).toBe(false);
  // A link that is too long is stopped and not sent.
  expect(clickOn(`https://example.test/${"x".repeat(2100)}`)).toBe(true);
  expect(framed.posted).toHaveLength(before);
});

it("scrolls a framed page to a `#` target on the same document instead of navigating", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const { text } = await embed(id, { user: alice });
  const framed = boot(text, viewerUrl(id), true);
  const click = framed.listeners.find((listener) => listener.type === "click")!.handler;
  const clickOn = (href: string) => {
    let prevented = false;
    click({ defaultPrevented: false, button: 0, preventDefault: () => { prevented = true; }, target: { closest: () => ({ href, hasAttribute: () => false }) } });
    return prevented;
  };
  // WebKit fires a false frame load on a fragment navigation, and the shell ends the view on it.
  expect(clickOn(`${viewerUrl(id)}#then`)).toBe(true);
  expect(clickOn(`${viewerUrl(id)}#caf%C3%A9`)).toBe(true);
  expect(clickOn(`${viewerUrl(id)}#named`)).toBe(true);
  expect(clickOn(`${viewerUrl(id)}#`)).toBe(true);
  expect(clickOn(`${viewerUrl(id)}#top`)).toBe(true);
  expect(clickOn(`${viewerUrl(id)}#missing`)).toBe(true);
  expect(framed.scrolled).toEqual(["then", "café", "named", "top", "top"]);
  // A `#` link never becomes a link request.
  expect(framed.posted).toEqual([{ channel: "yoplai-embed", type: "ready", targetOrigin: "*" }]);
});

it("posts nothing from an unframed embed page or from an ordinary page", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const embedded = boot((await embed(id, { user: alice })).text, viewerUrl(id));
  expect(embedded.posted).toEqual([]);
  expect(embedded.listeners.some((listener) => listener.type === "click")).toBe(false);
  const ordinary = await routesFor({ user: alice }).request(`/${id}`);
  const page = boot(await ordinary.text(), `https://remote.example.test/d/${id}`, true);
  expect(page.posted).toEqual([]);
  expect(page.listeners.some((listener) => listener.type === "click")).toBe(false);
});

it("keeps links to dashboards the viewer cannot read disabled and refuses unknown ones", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  await ownedPage("secret", "<h1>Secret</h1>", undefined, alice.id);
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const { text } = await embed(id, { user: bob });
  const page = boot(text, viewerUrl(id));
  expect(page.yoplai.link("secret.html")).toBe("#yoplai-no-access");
  expect(() => page.yoplai.link("missing.html")).toThrow("Unknown dashboard");
});

it("reports each viewer role: owner and writer edit, readers keep the token and a read-only page", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "write" }]);
  expect((await embed(id, { user: bob })).meta).toMatchObject({ canWrite: true, canEdit: true, annotation: true });
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const reader = await embed(id, { user: bob });
  expect(reader.meta).toMatchObject({ canWrite: false, canEdit: true, annotation: false });
  expect(boot(reader.text, viewerUrl(id)).yoplai).toMatchObject({ canWrite: false, canEdit: true });
});

it("gives a guarded reader the edit token, with adds still refused for writers only", async () => {
  const html = guardedEdit.replace('"guard":"SELECT 1"', '"guard":"SELECT 1","create":true') + "<h1>Hello</h1>";
  const id = await ownedPage("overview", html);
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const reader = await embed(id, { user: bob });
  expect(reader.meta).toMatchObject({ canWrite: false, canEdit: true });
  const token = /"editToken":"([^"]+)"/.exec(reader.text)![1];
  // The edit endpoint keeps its own policy. Row edits for readers are covered by edit-routes.test.ts and the adapter test. Adds stay writer-only.
  const add = await routesFor({ user: bob }).request(`/${id}/add`, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "null" }, body: JSON.stringify({ token, edit: "actions", values: {} }),
  });
  expect(add.status).toBe(403);
  expect(await add.json()).toEqual({ ok: false, error: "Only the owner or a write share can add rows" });
});

it("gives an ordinary reader the published page and a writer the draft", async () => {
  const id = await ownedPage("overview", "<h1>Published text</h1>", "<h1>Draft text</h1>");
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  expect((await embed(id, { user: bob })).text).toContain("Published text");
  const owner = await embed(id, { user: alice });
  expect(owner.text).toContain("Draft text");
  expect(owner.text).not.toContain("Published text");
});

it("gives a superadmin the published page without write rights", async () => {
  const id = await ownedPage("overview", "<h1>Published text</h1>", "<h1>Draft text</h1>");
  const admin = await embed(id, { user: root1, superadmin: true });
  expect(admin.status).toBe(200);
  expect(admin.text).toContain("Published text");
  expect(admin.text).not.toContain("Draft text");
  expect(admin.meta).toMatchObject({ canWrite: false, annotation: false });
});

it("serves a legacy page to a viewer with agent access, with no edit token", async () => {
  const entry = await registry.link("agent", "legacy.html");
  await fs.writeFile(path.join(root, "data", "dashboards", "legacy.html"), "<h1>Legacy</h1>");
  const allowed = await embed(entry.id, { user: bob });
  expect(allowed.status).toBe(200);
  expect(allowed.meta).toMatchObject({ canEdit: false, canWrite: false });
  expect(allowed.text).toContain("Legacy");
  expect((await embed(entry.id, { user: bob, hasAgentAccess: false })).status).toBe(404);
});

it("answers a viewer without a share with a bounded 403 that names the owner and returns no page", async () => {
  const id = await ownedPage("overview", "<h1>Hidden</h1>");
  const refused = await embed(id, { user: bob });
  expect(refused.status).toBe(403);
  expect(refused.response.headers.get("content-type")).toContain("application/json");
  expect(refused.json()).toEqual({ error: "forbidden", ownerName: "Alice Martin" });
  expect(refused.response.headers.get("x-yoplai-dashboard-embed")).toBe("1");
  expect(refused.text).not.toContain("Hidden");
});

it("hides the page from an ineligible account and from a missing, malformed or version identifier", async () => {
  const id = await ownedPage("overview", "<h1>Hidden</h1>");
  await registry.replaceShares(id, [{ kind: "all", mode: "read" }]);
  expect((await embed(id, { user: bob, eligible: false })).status).toBe(404);
  for (const bad of ["abc-0123456789ab", "short", `${id}x`, "A".repeat(32)]) {
    const missing = await embed(bad, { user: alice });
    expect(missing.status).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
    expect(missing.response.headers.get("x-yoplai-dashboard-embed")).toBe("1");
  }
});

it("answers an unauthenticated request with 401 JSON, never a login redirect", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const result = await embed(id, { user: null });
  expect(result.status).toBe(401);
  expect(result.json()).toEqual({ error: "unauthorized" });
  expect(result.response.headers.get("location")).toBeNull();
});

it("tells a disabled Canvas apart from a missing dashboard", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  canvasEnabled = false;
  const disabled = await embed(id, { user: alice });
  expect(disabled.status).toBe(404);
  expect(disabled.response.headers.get(DASHBOARD_EMBED_HEADERS.reason)).toBe("canvas_disabled");
  canvasEnabled = true;
  const missing = await embed("B".repeat(32), { user: alice });
  expect(missing.response.headers.get(DASHBOARD_EMBED_HEADERS.reason)).toBeNull();
});

it("withholds edit rights, the token and annotation from an impersonated viewer", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const result = await embed(id, { user: alice, impersonating: true });
  expect(result.status).toBe(200);
  expect(result.text).not.toContain('"editToken":"');
  expect(result.meta).toMatchObject({ canWrite: false, canEdit: false, annotation: false });
  expect(result.text).not.toContain("data-annotation");
});

it("offers annotation only to a writer with agent access, and keeps the page script out of the host metadata", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const writer = await embed(id, { user: alice });
  expect(writer.meta?.annotation).toBe(true);
  expect(writer.text).toContain("data-annotation");
  const noAgent = await embed(id, { user: alice, hasAgentAccess: false });
  expect(noAgent.meta).toMatchObject({ annotation: false, chat: null });
  expect(noAgent.text).not.toContain("data-annotation");
});

it("reports the creating chat session only for its creator, and a new chat otherwise", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>", undefined, alice.id, { sessionId: "session-1", userId: alice.id });
  expect((await embed(id, { user: alice, existingSessions: ["session-1"] })).meta?.chat).toEqual({ sessionId: "session-1" });
  expect((await embed(id, { user: alice, existingSessions: [] })).meta?.chat).toEqual({ sessionId: null });
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  expect((await embed(id, { user: bob, existingSessions: ["session-1"] })).meta?.chat).toEqual({ sessionId: null });
});

it("does not render a Chat button for the embed page, which the trusted host owns", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const { text } = await embed(id, { user: alice });
  expect(boot(text, viewerUrl(id)).appended).toHaveLength(0);
  expect(text).not.toContain("/chat/agent");
});

it("applies only a checked theme value from the host and defaults to the system theme", async () => {
  const id = await ownedPage("overview", "<html><body>Hello</body></html>");
  expect((await embed(id, { user: alice }, { headers: { [DASHBOARD_EMBED_HEADERS.theme]: "light" } })).text).toContain('data-theme="light"');
  expect((await embed(id, { user: alice }, { headers: { [DASHBOARD_EMBED_HEADERS.theme]: "dark" } })).text).toContain('data-theme="dark"');
  const unchecked = await embed(id, { user: alice }, { headers: { [DASHBOARD_EMBED_HEADERS.theme]: "<script>" , Cookie: "yoplai-theme=dark" } });
  expect(unchecked.text).not.toContain('data-theme="dark"');
  expect(unchecked.text).toContain("prefers-color-scheme");
  // An explicit theme in the dashboard stays.
  const explicit = await ownedPage("explicit", '<html data-theme="dark"><body>Dark</body></html>');
  expect((await embed(explicit, { user: alice }, { headers: { [DASHBOARD_EMBED_HEADERS.theme]: "light" } })).text).not.toContain('data-theme="light"');
});

it("passes dashboard query parameters to the page", async () => {
  const id = await ownedPage("overview", "<h1>Hello</h1>");
  const { text } = await embed(id, { user: alice }, { query: "?region=emea" });
  expect(text).toContain('"params":{"region":"emea"}');
});
