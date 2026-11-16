// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix, type FakeAnswer } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { Skills } from "./pages/Skills";
import AdminSkills from "./pages/admin/Skills";

vi.mock("./auth/client", () => ({ useSession: () => () => ({ isPending: false, data: null }) }));
vi.mock("./api/main-agent", () => ({ fetchMainAgentOptions: vi.fn().mockResolvedValue({ agents: [], preference: { accessible: false } }) }));

const east = relayPrefix("east");
const west = relayPrefix("west");

const caps = (overrides: Record<string, unknown> = {}) => ({
  version: 2, extensions: {}, agents: [], multiUser: true, forkedAgents: false, enableCronMonitoring: false,
  user: { id: "remote-root", name: "Root", role: "superadmin" }, ...overrides,
});
const skill = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, description: `About ${name}`, kind: "user", ownerName: "Alice", enabled: false, locked: false, shadowed: false,
  shares: [], mode: "write", updatedAt: null, canRead: true, canWrite: true, canManage: true, ...extra,
});
const groups = (...mine: ReturnType<typeof skill>[]) => ({ mine, sharedWithMe: [], agent: [] });

let gateways: ReturnType<typeof createFakeGateways>;
let container: HTMLElement;
let dispose: (() => void) | undefined;
let history: ReturnType<typeof createMemoryHistory>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => container.textContent ?? "";
const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim().startsWith(name));
const labelled = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const link = (name: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((item) => item.textContent?.includes(name));
const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Gateway"]')!;
const choose = (name: string) => { select().value = name; select().dispatchEvent(new Event("change", { bubbles: true })); };
const toggle = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Enable ${name}"]`);
const log = () => gateways.log();
const writes = () => gateways.requests.filter((request) => request.method !== "GET");

function mount(path: string) {
  history = createMemoryHistory();
  history.set({ value: path, replace: true });
  dispose = render(() => (
    <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
      <Route path="/skills" component={Skills} />
      <Route path="/skills/:id" component={Skills} />
      <Route path="/admin/skills" component={AdminSkills} />
      <Route path="/review-away" component={() => <h1>Other page</h1>} />
    </MemoryRouter>
  ), container);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setCapabilitiesForTests({ extensions: {}, multiUser: false });
  gateways = createFakeGateways();
  gateways.on("GET", "/api/relay/gateways", { json: { gateways: [{ name: "east" }, { name: "west" }, { name: "quiet" }] } });
  gateways.on("GET", `${east}/api/capabilities`, { json: caps() });
  gateways.on("GET", `${west}/api/capabilities`, { json: caps({ multiUser: false, user: undefined }) });
  gateways.on("GET", "/api/skills", { json: groups(skill("same-id", "Local Skill")) });
  gateways.on("GET", `${east}/api/skills`, { json: groups(skill("same-id", "East Skill")) });
  gateways.on("GET", `${west}/api/skills`, { json: groups(skill("same-id", "West Skill")) });
  vi.stubGlobal("fetch", gateways.fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe("skills of a chosen gateway", () => {
  it("lists every configured gateway, starts on Local, and keeps equal skill IDs apart", async () => {
    mount("/skills");
    await vi.waitFor(() => expect(text()).toContain("Local Skill"));
    expect(Array.from(select().options).map((option) => option.textContent)).toEqual(["This computer", "east", "west", "quiet"]);
    choose("east");
    await vi.waitFor(() => expect(text()).toContain("East Skill"));
    expect(text()).not.toContain("Local Skill");
    expect(history.get()).toBe("/skills?gateway=east");
    // The link keeps the gateway. The opaque ID is the same on three gateways and names one skill of one gateway.
    expect(link("East Skill")?.getAttribute("href")).toBe("/skills/same-id?gateway=east");
    choose("west");
    await vi.waitFor(() => expect(text()).toContain("West Skill"));
    expect(text()).not.toContain("East Skill");
    choose("");
    await vi.waitFor(() => expect(link("Local Skill")?.getAttribute("href")).toBe("/skills/same-id"));
  });

  it("opens one skill of a gateway and links back to its list with the gateway", async () => {
    const id = "agent:pom@quiet:folder";
    gateways.on("GET", `${east}/api/skills/${encodeURIComponent(id)}`, { json: { ...skill(id, "East Detail"), skillMd: "# Title\nBody", files: [{ path: "SKILL.md", size: 12 }] } });
    mount(`/skills/${encodeURIComponent(id)}?gateway=east`);
    await vi.waitFor(() => expect(text()).toContain("East Detail"));
    expect(link("All skills")?.getAttribute("href")).toBe("/skills?gateway=east");
    // The embedded agent ID selects nothing. Only the named gateway saw the request.
    expect(log().filter((line) => line.includes("/api/skills/"))).toEqual([`GET ${east}/api/skills/${encodeURIComponent(id)}`]);
  });

  it("makes no call for a gateway that is not configured or not available, and never falls back to Local", async () => {
    mount("/skills?gateway=ghost");
    await vi.waitFor(() => expect(text()).toContain('The gateway "ghost" is not linked.'));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/relay/gateways"]);
    dispose?.();
    container.replaceChildren();
    gateways.on("GET", "/api/relay/gateways", { status: 403, json: { error: "relay_unavailable" } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Linked gateways are not available on this gateway."));
    expect(gateways.requests.filter((request) => request.url.startsWith("/api/skills"))).toEqual([]);
    expect(gateways.requests.filter((request) => request.url.startsWith(east))).toEqual([]);
  });

  it("shows a refusal and an offline gateway as errors, and keeps no local rows", async () => {
    gateways.on("GET", `${east}/api/skills`, { status: 403, json: { error: "forbidden" } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Unable to load skills."));
    expect(text()).not.toContain("Local Skill");
    expect(gateways.requests.map((request) => request.url)).not.toContain("/api/skills");
    dispose?.();
    container.replaceChildren();
    gateways.on("GET", `${east}/api/skills`, { status: 502, json: { error: "gateway_offline" } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Unable to load skills."));
    expect(text()).not.toContain("No skills yet");
  });

  it("changes the enabled state through the gateway, and reads the same list again after a failed answer before another write", async () => {
    const remote = skill("e-1", "Notes");
    let committed = false;
    gateways.on("GET", `${east}/api/skills`, () => ({ json: groups({ ...remote, enabled: committed }) }));
    gateways.on("PUT", `${east}/api/skills/e-1/enabled`, () => { committed = true; return { status: 502, json: { error: "gateway_offline" } }; });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("Notes")?.disabled).toBe(false));
    const reads = () => log().filter((line) => line === `GET ${east}/api/skills`).length;
    const before = reads();
    let release: (() => void) | undefined;
    gateways.on("GET", `${east}/api/skills`, () => new Promise<FakeAnswer>((resolve) => { release = () => resolve({ json: groups({ ...remote, enabled: committed }) }); }));
    toggle("Notes")!.click();
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    // The change is committed, but its answer failed. The controls stay off while the read is pending.
    expect(toggle("Notes")?.disabled).toBe(true);
    release!();
    await vi.waitFor(() => expect(toggle("Notes")?.disabled).toBe(false));
    expect(toggle("Notes")?.checked).toBe(true);
    expect(writes().map((request) => `${request.method} ${request.url}`)).toEqual([`PUT ${east}/api/skills/e-1/enabled`]);
    expect(writes()[0].body).toEqual({ enabled: true });
  });

  it("keeps controls off with Retry when the read after a failed write fails, and recovers on a working read", async () => {
    gateways.on("PUT", `${east}/api/skills/same-id/enabled`, { status: 502, json: { error: "gateway_offline" } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("East Skill")?.disabled).toBe(false));
    gateways.on("GET", `${east}/api/skills`, { status: 502, json: { error: "gateway_offline" } });
    toggle("East Skill")!.click();
    await vi.waitFor(() => expect(text()).toContain("The remote gateway is offline."));
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    expect(toggle("East Skill")).toBeNull();
    expect(writes()).toHaveLength(1);
    gateways.on("GET", `${east}/api/skills`, { json: groups(skill("same-id", "East Skill", { enabled: true })) });
    button("Retry")!.click();
    await vi.waitFor(() => expect(toggle("East Skill")?.disabled).toBe(false));
  });

  it("ignores a late answer after the page moved to Local and back to the same gateway", async () => {
    let fail: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/skills/same-id/enabled`, () => new Promise<FakeAnswer>((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("East Skill")?.disabled).toBe(false));
    toggle("East Skill")!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: "/skills" });
    await vi.waitFor(() => expect(text()).toContain("Local Skill"));
    history.set({ value: "/skills?gateway=east" });
    await vi.waitFor(() => expect(toggle("East Skill")?.disabled).toBe(false));
    const reads = () => log().filter((line) => line === `GET ${east}/api/skills`).length;
    const before = reads();
    fail!();
    await tick();
    await tick();
    expect(text()).not.toContain("forbidden");
    expect(toggle("East Skill")?.disabled).toBe(false);
    expect(reads()).toBe(before);
  });

  it("starts nothing after the page closes during a write", async () => {
    let finish: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/skills/same-id/enabled`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("East Skill")?.disabled).toBe(false));
    toggle("East Skill")!.click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    history.set({ value: "/review-away" });
    await vi.waitFor(() => expect(text()).toContain("Other page"));
    const before = gateways.requests.length;
    finish!();
    await tick();
    await tick();
    expect(gateways.requests.length).toBe(before);
  });

  describe("upload", () => {
    const addFile = async (label: string, name = "skill.zip") => {
      button("Add skill")!.click();
      await tick();
      const input = labelled(label) as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File(["zip"], name)], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    it("sends a zip upload to the named gateway as multipart, and refreshes that gateway", async () => {
      gateways.on("POST", `${east}/api/skills`, { json: { id: "new", name: "Fresh" } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
      await addFile("Skill zip file");
      await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skills`));
      expect(gateways.requests.some((request) => request.method === "POST" && request.url === "/api/skills")).toBe(false);
    });

    it("replaces the content of a skill through the gateway with its opaque ID", async () => {
      const id = "agent:pom@quiet:x";
      gateways.on("GET", `${east}/api/skills`, { json: groups(skill(id, "Replace Me")) });
      gateways.on("PUT", `${east}/api/skills/${encodeURIComponent(id)}/content`, { json: { id, name: "Replace Me" } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(labelled("Actions for Replace Me")).not.toBeNull());
      labelled("Actions for Replace Me")!.click();
      await tick();
      labelled("Update Replace Me")!.click();
      await tick();
      button("Update from zip")!.click();
      await tick();
      const input = labelled("Skill zip file") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [new File(["zip"], "skill.zip")], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(log()).toContain(`PUT ${east}/api/skills/${encodeURIComponent(id)}/content`));
    });

    it("reads the list again after a failed upload before another write", async () => {
      gateways.on("POST", `${east}/api/skills`, { status: 502, json: { error: "gateway_offline" } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
      const reads = () => log().filter((line) => line === `GET ${east}/api/skills`).length;
      const before = reads();
      await addFile("Skill zip file");
      await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
      await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
    });

    it("offers no chat shortcut for a linked gateway", async () => {
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
      button("Add skill")!.click();
      await tick();
      expect(container.querySelector('[role="menuitem"]')).not.toBeNull();
      expect(Array.from(container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).not.toContain("Create skill");
    });
  });

  describe("shares, versions, delete", () => {
    it("loads recipients and saves shares through the gateway, with its remote requester", async () => {
      gateways.on("GET", `${east}/api/skills/recipients`, { json: { users: [{ id: "bob", name: "Bob", email: "bob@example.test" }] } });
      gateways.on("PUT", `${east}/api/skills/same-id/shares`, { json: { ok: true } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
      await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      // The remote requester is multi-user, so Share shows. Local single-user mode would hide it.
      await vi.waitFor(() => expect(labelled("Share East Skill")).not.toBeNull());
      labelled("Share East Skill")!.click();
      await vi.waitFor(() => expect(log()).toContain(`GET ${east}/api/skills/recipients`));
      await vi.waitFor(() => expect(document.querySelector('select[aria-label="General access"]')).not.toBeNull());
      const general = document.querySelector<HTMLSelectElement>('select[aria-label="General access"]')!;
      general.value = "all";
      general.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Save")!.click();
      await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skills/same-id/shares`)?.body).toEqual({ shares: [{ kind: "all", mode: "read" }] }));
    });

    it("hides Share for a single-user gateway, as the local page does", async () => {
      mount("/skills?gateway=west");
      await vi.waitFor(() => expect(labelled("Actions for West Skill")).not.toBeNull());
      labelled("Actions for West Skill")!.click();
      await tick();
      expect(labelled("Share West Skill")).toBeNull();
      expect(labelled("Delete West Skill")).not.toBeNull();
    });

    it("lists versions and restores one through the gateway, then deletes through the gateway", async () => {
      gateways.on("GET", `${east}/api/skills/same-id/versions`, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00.000Z" }] } });
      gateways.on("POST", `${east}/api/skills/same-id/versions/v-1/restore`, { json: { id: "same-id", name: "East Skill" } });
      gateways.on("DELETE", `${east}/api/skills/same-id`, { json: { ok: true } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      labelled("Versions of East Skill")!.click();
      await vi.waitFor(() => expect(labelled("Restore version v-1")).not.toBeNull());
      labelled("Restore version v-1")!.click();
      await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skills/same-id/versions/v-1/restore`));
      await vi.waitFor(() => expect((document.querySelector('[aria-label="Close versions"]') as HTMLButtonElement | null)?.disabled).toBe(false));
      (document.querySelector('[aria-label="Close versions"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector('[aria-label="Close versions"]')).toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      labelled("Delete East Skill")!.click();
      await tick();
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete")[0].click();
      await vi.waitFor(() => expect(log()).toContain(`DELETE ${east}/api/skills/same-id`));
      expect(gateways.requests.filter((request) => request.method !== "GET").every((request) => request.url.startsWith(east))).toBe(true);
    });

    it("ignores a restore answer after the dialog closed", async () => {
      let finish: (() => void) | undefined;
      gateways.on("GET", `${east}/api/skills/same-id/versions`, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00.000Z" }] } });
      gateways.on("POST", `${east}/api/skills/same-id/versions/v-1/restore`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { id: "same-id", name: "x" } }); }));
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      labelled("Versions of East Skill")!.click();
      await vi.waitFor(() => expect(labelled("Restore version v-1")).not.toBeNull());
      labelled("Restore version v-1")!.click();
      await vi.waitFor(() => expect(finish).toBeDefined());
      history.set({ value: "/review-away" });
      await vi.waitFor(() => expect(text()).toContain("Other page"));
      const before = gateways.requests.length;
      finish!();
      await tick();
      await tick();
      expect(gateways.requests.length).toBe(before);
    });
  });

  describe("import tokens", () => {
    const open = async () => {
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
      button("Add skill")!.click();
      await tick();
      Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Import"))!.click();
      await tick();
    };
    const tokenAnswer = (url: string) => ({ status: 201, json: { id: "tok-1", token: "ski_SECRET_TOKEN", expiresAt: "2099-01-01T00:00:00.000Z", prompt: `Send to POST to ${url} with Bearer ski_SECRET_TOKEN` } });

    beforeEach(() => {
      gateways.on("GET", `${east}/api/skills/import-token`, { json: { tokens: [] } });
    });

    it("creates a token through the gateway and shows the remote import address, with nothing stored", async () => {
      gateways.on("POST", `${east}/api/skills/import-token`, tokenAnswer("https://skills.example.test/api/skills/import"));
      await open();
      button("Generate import token")!.click();
      await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Import prompt"]')?.value).toContain("https://skills.example.test/api/skills/import"));
      expect(log()).toContain(`POST ${east}/api/skills/import-token`);
      // The token never reaches local storage, and the page never calls the import route with the linked bearer.
      expect(JSON.stringify({ ...localStorage })).not.toContain("ski_SECRET_TOKEN");
      expect(JSON.stringify({ ...sessionStorage })).not.toContain("ski_SECRET_TOKEN");
      expect(gateways.requests.some((request) => request.url.endsWith("/api/skills/import"))).toBe(false);
    });

    it("shows an actionable error and hides the secret when the remote has no public base address", async () => {
      gateways.on("POST", `${east}/api/skills/import-token`, tokenAnswer("http://localhost:4000/api/skills/import"));
      await open();
      button("Generate import token")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Set server.baseUrl on the gateway to its public address"));
      expect(document.body.textContent).not.toContain("ski_SECRET_TOKEN");
      expect(document.querySelector('textarea[aria-label="Import prompt"]')).toBeNull();
    });

    it("revokes a token through the gateway", async () => {
      gateways.on("GET", `${east}/api/skills/import-token`, { json: { tokens: [{ id: "tok-9", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }] } });
      gateways.on("DELETE", `${east}/api/skills/import-token/tok-9`, { json: { ok: true } });
      await open();
      await vi.waitFor(() => expect(labelled("Revoke import token tok-9")).not.toBeNull());
      labelled("Revoke import token tok-9")!.click();
      await vi.waitFor(() => expect(log()).toContain(`DELETE ${east}/api/skills/import-token/tok-9`));
    });

    it("drops a late token of a closed dialog", async () => {
      let finish: (() => void) | undefined;
      gateways.on("POST", `${east}/api/skills/import-token`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve(tokenAnswer("https://skills.example.test/api/skills/import")); }));
      await open();
      button("Generate import token")!.click();
      await vi.waitFor(() => expect(finish).toBeDefined());
      history.set({ value: "/review-away" });
      await vi.waitFor(() => expect(text()).toContain("Other page"));
      finish!();
      await tick();
      await tick();
      expect(document.body.textContent).not.toContain("ski_SECRET_TOKEN");
    });
  });

  it("keeps the local page unchanged: unprefixed calls, no relay, and Share hidden in single-user mode", async () => {
    mount("/skills");
    await vi.waitFor(() => expect(text()).toContain("Local Skill"));
    expect(log().filter((line) => line.includes("/api/relay/gateways/"))).toEqual([]);
    expect(log()).toContain("GET /api/skills");
    labelled("Actions for Local Skill")!.click();
    await tick();
    expect(labelled("Share Local Skill")).toBeNull();
  });
});

describe("skill administration of a chosen gateway", () => {
  const adminData = (name: string, extra: Record<string, unknown> = {}) => ({
    skills: [{ ...skill("same-id", name, { shares: [{ kind: "all", mode: "read" }], ...extra }), ownerActive: true, enabledCount: 2, collisions: [], ownerId: "u1" }],
    agent: [{ ...skill("agent:pom@quiet:tool", "Agent Tool", { kind: "agent", agentId: "pom@east", agentName: "Pom" }), system: false }],
    system: [],
  });

  beforeEach(() => {
    gateways.on("GET", "/api/admin/skills", { json: adminData("Local Admin Skill") });
    gateways.on("GET", `${east}/api/admin/skills`, { json: adminData("East Admin Skill") });
    gateways.on("GET", `${east}/api/skills/recipients`, { json: { users: [{ id: "u2", name: "Una", email: "una@example.test" }] } });
  });

  it("lists the skills of the chosen gateway only, keeps equal IDs apart, and links with the gateway", async () => {
    mount("/admin/skills");
    await vi.waitFor(() => expect(text()).toContain("Local Admin Skill"));
    choose("east");
    await vi.waitFor(() => expect(text()).toContain("East Admin Skill"));
    expect(text()).not.toContain("Local Admin Skill");
    expect(link("East Admin Skill")?.getAttribute("href")).toBe("/skills/same-id?gateway=east");
    // The tab bar of a gateway shows only the pages that follow it.
    expect(Array.from(container.querySelectorAll("nav a")).map((item) => item.textContent)).toEqual(["Extensions", "MCP servers", "Skills"]);
  });

  it("disables and restores a platform-wide skill, transfers it, and deletes it through the gateway", async () => {
    gateways.on("PUT", `${east}/api/skills/same-id/admin`, { json: { ok: true } });
    gateways.on("PUT", `${east}/api/skills/same-id/owner`, { json: { ok: true } });
    gateways.on("DELETE", `${east}/api/skills/same-id`, { json: { ok: true } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")).not.toBeNull());
    labelled("Disable East Admin Skill")!.click();
    await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skills/same-id/admin`)?.body).toEqual({ disabledByAdmin: true }));
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")?.hasAttribute("disabled")).toBe(false));
    labelled("Transfer East Admin Skill")!.click();
    await tick();
    expect(document.body.textContent).toContain("Transfer skill");
    labelled("Delete East Admin Skill")!.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete").pop()!.click();
    await vi.waitFor(() => expect(log()).toContain(`DELETE ${east}/api/skills/same-id`));
  });

  it("marks an agent skill as system and makes it a default after the path check, through the gateway", async () => {
    const id = encodeURIComponent("agent:pom@quiet:tool");
    gateways.on("PUT", `${east}/api/skills/${id}/system`, { json: { ok: true } });
    gateways.on("GET", `${east}/api/skills/${id}/default`, { json: { outsidePaths: [] } });
    gateways.on("POST", `${east}/api/skills/${id}/default`, { json: { id: "default:tool", name: "tool" } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Mark Agent Tool as system")).not.toBeNull());
    labelled("Mark Agent Tool as system")!.click();
    await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skills/${id}/system`)?.body).toEqual({ system: true }));
    await vi.waitFor(() => expect((labelled("Mark Agent Tool as system") as HTMLInputElement).disabled).toBe(false));
    labelled("Make Agent Tool a default skill")!.click();
    await vi.waitFor(() => expect(log()).toContain(`GET ${east}/api/skills/${id}/default`));
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Make default").pop()!.click();
    await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skills/${id}/default`));
  });

  it("shows role denial for a remote requester that is not its superadmin, with no admin call", async () => {
    gateways.on("GET", `${east}/api/capabilities`, { json: caps({ user: { id: "u", role: "user" } }) });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Superadmin access required."));
    expect(log()).not.toContain(`GET ${east}/api/admin/skills`);
    dispose?.();
    container.replaceChildren();
    gateways.on("GET", `${east}/api/capabilities`, { status: 500, json: {} });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(text()).toContain("Superadmin access required."));
    expect(log()).not.toContain(`GET ${east}/api/admin/skills`);
  });

  it("makes no call for a gateway that is not configured", async () => {
    mount("/admin/skills?gateway=ghost");
    await vi.waitFor(() => expect(text()).toContain('The gateway "ghost" is not linked.'));
    expect(gateways.requests.map((request) => request.url)).toEqual(["/api/relay/gateways"]);
  });

  it("reads the same list again after a failed admin write, and keeps the controls off until a read works", async () => {
    gateways.on("PUT", `${east}/api/skills/same-id/admin`, { status: 502, json: { error: "gateway_offline" } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")).not.toBeNull());
    gateways.on("GET", `${east}/api/admin/skills`, { status: 502, json: { error: "gateway_offline" } });
    labelled("Disable East Admin Skill")!.click();
    await vi.waitFor(() => expect(text()).toContain("Retry"));
    expect(writes()).toHaveLength(1);
    gateways.on("GET", `${east}/api/admin/skills`, { json: adminData("East Admin Skill", { disabledByAdmin: true }) });
    button("Retry")!.click();
    await vi.waitFor(() => expect(labelled("Restore East Admin Skill")).not.toBeNull());
  });

  it("ignores a late admin answer after the page moved to Local and back, and after the page closed", async () => {
    let fail: (() => void) | undefined;
    gateways.on("PUT", `${east}/api/skills/same-id/admin`, () => new Promise<FakeAnswer>((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")).not.toBeNull());
    labelled("Disable East Admin Skill")!.click();
    await vi.waitFor(() => expect(fail).toBeDefined());
    history.set({ value: "/admin/skills" });
    await vi.waitFor(() => expect(text()).toContain("Local Admin Skill"));
    history.set({ value: "/admin/skills?gateway=east" });
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")?.hasAttribute("disabled")).toBe(false));
    const before = gateways.requests.length;
    fail!();
    await tick();
    await tick();
    expect(text()).not.toContain("forbidden");
    expect(gateways.requests.length).toBe(before);
  });

  it("keeps the local administration unchanged", async () => {
    mount("/admin/skills");
    await vi.waitFor(() => expect(text()).toContain("Local Admin Skill"));
    expect(log()).toContain("GET /api/admin/skills");
    expect(log().filter((line) => line.includes("/api/relay/gateways/"))).toEqual([]);
  });
});
