// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, type JSX } from "solid-js";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { createFakeGateways, relayPrefix, type FakeAnswer } from "./remote-gateway.fixture";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "./lib/capabilities";
import { encodeSkillId as wire } from "@yoplai/shared/skill-id-wire";
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
    gateways.on("GET", `${east}/api/skill-ids/${wire(id)}`, { json: { ...skill(id, "East Detail"), skillMd: "# Title\nBody", files: [{ path: "SKILL.md", size: 12 }] } });
    mount(`/skills/${encodeURIComponent(id)}?gateway=east`);
    await vi.waitFor(() => expect(text()).toContain("East Detail"));
    expect(link("All skills")?.getAttribute("href")).toBe("/skills?gateway=east");
    // The embedded agent ID selects nothing. Only the named gateway saw the request.
    expect(log().filter((line) => line.includes("/api/skill"))).toEqual([`GET ${east}/api/skill-ids/${wire(id)}`]);
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("e-1")}/enabled`, () => { committed = true; return { status: 502, json: { error: "gateway_offline" } }; });
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
    expect(writes().map((request) => `${request.method} ${request.url}`)).toEqual([`PUT ${east}/api/skill-ids/${wire("e-1")}/enabled`]);
    expect(writes()[0].body).toEqual({ enabled: true });
  });

  it("keeps controls off with Retry when the read after a failed write fails, and recovers on a working read", async () => {
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/enabled`, { status: 502, json: { error: "gateway_offline" } });
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/enabled`, () => new Promise<FakeAnswer>((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/enabled`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { ok: true } }); }));
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
      gateways.on("PUT", `${east}/api/skill-ids/${wire(id)}/content`, { json: { id, name: "Replace Me" } });
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
      await vi.waitFor(() => expect(log()).toContain(`PUT ${east}/api/skill-ids/${wire(id)}/content`));
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
      gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { json: { ok: true } });
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
      await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skill-ids/${wire("same-id")}/shares`)?.body).toEqual({ shares: [{ kind: "all", mode: "read" }] }));
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
      gateways.on("GET", `${east}/api/skill-ids/${wire("same-id")}/versions`, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00.000Z" }] } });
      gateways.on("POST", `${east}/api/skill-ids/${wire("same-id")}/versions/v-1/restore`, { json: { id: "same-id", name: "East Skill" } });
      gateways.on("DELETE", `${east}/api/skill-ids/${wire("same-id")}`, { json: { ok: true } });
      mount("/skills?gateway=east");
      await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      labelled("Versions of East Skill")!.click();
      await vi.waitFor(() => expect(labelled("Restore version v-1")).not.toBeNull());
      labelled("Restore version v-1")!.click();
      await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skill-ids/${wire("same-id")}/versions/v-1/restore`));
      await vi.waitFor(() => expect((document.querySelector('[aria-label="Close versions"]') as HTMLButtonElement | null)?.disabled).toBe(false));
      (document.querySelector('[aria-label="Close versions"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector('[aria-label="Close versions"]')).toBeNull());
      labelled("Actions for East Skill")!.click();
      await tick();
      labelled("Delete East Skill")!.click();
      await tick();
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete")[0].click();
      await vi.waitFor(() => expect(log()).toContain(`DELETE ${east}/api/skill-ids/${wire("same-id")}`));
      expect(gateways.requests.filter((request) => request.method !== "GET").every((request) => request.url.startsWith(east))).toBe(true);
    });

    it("ignores a restore answer after the dialog closed", async () => {
      let finish: (() => void) | undefined;
      gateways.on("GET", `${east}/api/skill-ids/${wire("same-id")}/versions`, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00.000Z" }] } });
      gateways.on("POST", `${east}/api/skill-ids/${wire("same-id")}/versions/v-1/restore`, () => new Promise<FakeAnswer>((resolve) => { finish = () => resolve({ json: { id: "same-id", name: "x" } }); }));
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
      gateways.on("POST", `${east}/api/skills/import-token`, tokenAnswer("https://localhost:4000/api/skills/import"));
      await open();
      button("Generate import token")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Set server.baseUrl on the gateway to an address that the importing client can reach"));
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/admin`, { json: { ok: true } });
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/owner`, { json: { ok: true } });
    gateways.on("DELETE", `${east}/api/skill-ids/${wire("same-id")}`, { json: { ok: true } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")).not.toBeNull());
    labelled("Disable East Admin Skill")!.click();
    await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skill-ids/${wire("same-id")}/admin`)?.body).toEqual({ disabledByAdmin: true }));
    await vi.waitFor(() => expect(labelled("Disable East Admin Skill")?.hasAttribute("disabled")).toBe(false));
    labelled("Transfer East Admin Skill")!.click();
    await tick();
    expect(document.body.textContent).toContain("Transfer skill");
    labelled("Delete East Admin Skill")!.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Delete").pop()!.click();
    await vi.waitFor(() => expect(log()).toContain(`DELETE ${east}/api/skill-ids/${wire("same-id")}`));
  });

  it("marks an agent skill as system and makes it a default after the path check, through the gateway", async () => {
    const id = "agent:pom@quiet:tool";
    gateways.on("PUT", `${east}/api/skill-ids/${wire(id)}/system`, { json: { ok: true } });
    gateways.on("GET", `${east}/api/skill-ids/${wire(id)}/default`, { json: { outsidePaths: [] } });
    gateways.on("POST", `${east}/api/skill-ids/${wire(id)}/default`, { json: { id: "default:tool", name: "tool" } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Mark Agent Tool as system")).not.toBeNull());
    labelled("Mark Agent Tool as system")!.click();
    await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skill-ids/${wire(id)}/system`)?.body).toEqual({ system: true }));
    await vi.waitFor(() => expect((labelled("Mark Agent Tool as system") as HTMLInputElement).disabled).toBe(false));
    labelled("Make Agent Tool a default skill")!.click();
    await vi.waitFor(() => expect(log()).toContain(`GET ${east}/api/skill-ids/${wire(id)}/default`));
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Make default").pop()!.click();
    await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skill-ids/${wire(id)}/default`));
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/admin`, { status: 502, json: { error: "gateway_offline" } });
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
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/admin`, () => new Promise<FakeAnswer>((resolve) => { fail = () => resolve({ status: 403, json: { error: "forbidden" } }); }));
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

it("reads versions after an uncertain restore before retry", async () => {
  const path = `${east}/api/skill-ids/${wire("same-id")}/versions`;
  gateways.on("GET", path, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00Z" }] } });
  gateways.on("POST", `${path}/v-1/restore`, { status: 502, json: { error: "gateway_offline" } });
  mount("/skills?gateway=east");
  await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
  labelled("Actions for East Skill")!.click(); await tick();
  labelled("Versions of East Skill")!.click();
  await vi.waitFor(() => expect(labelled("Restore version v-1")).not.toBeNull());
  labelled("Restore version v-1")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("The remote gateway is offline."));
  await tick();
  expect(log().filter(x => x === `GET ${path}`).length).toBeGreaterThan(1);
});
it("reads tokens after uncertain creation before retry", async () => {
  const path = `${east}/api/skills/import-token`;
  gateways.on("GET", path, { json: { tokens: [] } });
  gateways.on("POST", path, { status: 502, json: { error: "gateway_offline" } });
  mount("/skills?gateway=east");
  await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
  button("Add skill")!.click(); await tick();
  Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(x => x.textContent?.includes("Import"))!.click();
  await tick(); button("Generate import token")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("The remote gateway is offline."));
  await tick();
  expect(log().filter(x => x === `GET ${path}`).length).toBeGreaterThan(1);
});
it("reads shares after an uncertain save before retry", async () => {
  gateways.on("GET", `${east}/api/skills/recipients`, { json: { users: [] } });
  gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { status: 502, json: { error: "gateway_offline" } });
  mount("/skills?gateway=east");
  await vi.waitFor(() => expect(labelled("Share East Skill")).not.toBeNull());
  labelled("Share East Skill")!.click();
  await vi.waitFor(() => expect(document.querySelector('[aria-label="General access"]')).not.toBeNull());
  const general = document.querySelector<HTMLSelectElement>('[aria-label="General access"]')!;
  general.value = "all"; general.dispatchEvent(new Event("change", { bubbles: true })); await tick();
  const save = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(x => x.textContent?.trim() === "Save")!;
  await vi.waitFor(() => expect(save().disabled).toBe(false)); save().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("The remote gateway is offline.")); await tick();
  expect(log().filter(x => x === `GET ${east}/api/skills`).length).toBeGreaterThan(1);
});
it("rejects a public HTTP import address", async () => {
  const { importAddressProblem } = await import("./lib/skill-import-url");
  expect(importAddressProblem("POST http://skills.example.test/api/skills/import")).toBeDefined();
});
it.each([undefined, "east"])("keeps local HTTP but refuses remote HTTP for %s", async (gateway) => {
  const scope = gateway ? east : "";
  gateways.on("GET", `${scope}/api/skills/import-token`, { json: { tokens: [] } });
  gateways.on("POST", `${scope}/api/skills/import-token`, { status: 201, json: { id: "synthetic", token: "synthetic", expiresAt: "2099-01-01T00:00:00Z", prompt: "POST http://skills.example.test/api/skills/import" } });
  mount(gateway ? "/skills?gateway=east" : "/skills");
  await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
  button("Add skill")!.click(); await tick();
  Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(x => x.textContent?.includes("Import"))!.click();
  await tick(); button("Generate import token")!.click();
  await vi.waitFor(() => expect(log()).toContain(`POST ${scope}/api/skills/import-token`));
  await tick(); await tick();
  const prompt = document.querySelector('[aria-label="Import prompt"]');
  if (gateway) expect(prompt).toBeNull();
  else expect(prompt).not.toBeNull();
});
it("blocks delete after failed recovery", async () => {
  gateways.on("DELETE", `${east}/api/skill-ids/${wire("same-id")}`, { status: 502, json: { error: "gateway_offline" } });
  mount("/skills?gateway=east");
  await vi.waitFor(() => expect(labelled("Delete East Skill")).not.toBeNull());
  labelled("Delete East Skill")!.click(); await tick();
  gateways.on("GET", `${east}/api/skills`, { status: 502, json: { error: "gateway_offline" } });
  const confirm = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(x => x.textContent?.trim() === "Delete")!;
  confirm().click();
  await vi.waitFor(() => expect(log().filter(x => x === `GET ${east}/api/skills`).length).toBe(2));
  await tick(); await tick();
  confirm().click(); await tick(); await tick();
  expect(writes()).toHaveLength(1);
});

describe("recovery of uncertain dialog writes", () => {
  const dialogButton = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === name);
  const versionsPath = `${east}/api/skill-ids/${wire("same-id")}/versions`;
  const openVersions = async () => {
    gateways.on("GET", versionsPath, { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00Z" }] } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Actions for East Skill")).not.toBeNull());
    labelled("Actions for East Skill")!.click(); await tick();
    labelled("Versions of East Skill")!.click();
    await vi.waitFor(() => expect(labelled("Restore version v-1")).not.toBeNull());
  };
  const restoreButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Restore version v-1"]')!;

  it("keeps Restore off after a failed restore and a failed read, and repeats nothing", async () => {
    await openVersions();
    gateways.on("POST", `${versionsPath}/v-1/restore`, { status: 502, json: { error: "gateway_offline" } });
    gateways.on("GET", versionsPath, { status: 502, json: { error: "gateway_offline" } });
    restoreButton().click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("The remote gateway is offline."));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Retry"));
    await tick();
    expect(writes().filter((request) => request.url.endsWith("/restore"))).toHaveLength(1);
    // No restore button shows while the list is unreadable, so no click can repeat the restore.
    expect(document.querySelector('[aria-label="Restore version v-1"]')).toBeNull();
    expect(writes().filter((request) => request.url.endsWith("/restore"))).toHaveLength(1);
  });

  it("turns Restore on again after the same list reads again", async () => {
    await openVersions();
    gateways.on("POST", `${versionsPath}/v-1/restore`, { status: 502, json: { error: "gateway_offline" } });
    let failing = true;
    gateways.on("GET", versionsPath, () => failing ? { status: 502, json: { error: "gateway_offline" } } : { json: { versions: [{ id: "v-1", createdAt: "2026-01-01T00:00:00Z" }, { id: "v-2", createdAt: "2026-01-02T00:00:00Z" }] } });
    restoreButton().click();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll("button")).some((item) => item.textContent?.trim() === "Retry")).toBe(true));
    failing = false;
    dialogButton("Retry")!.click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Restore version v-2"]')).not.toBeNull());
    expect(restoreButton().disabled).toBe(false);
  });

  it("keeps token creation off after a failed creation and a failed read, then recovers with Retry", async () => {
    const path = `${east}/api/skills/import-token`;
    gateways.on("GET", path, { json: { tokens: [] } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
    button("Add skill")!.click(); await tick();
    Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Import"))!.click();
    await tick();
    gateways.on("POST", path, { status: 502, json: { error: "gateway_offline" } });
    let failing = true;
    gateways.on("GET", path, () => failing ? { status: 502, json: { error: "gateway_offline" } } : { json: { tokens: [] } });
    const generate = () => dialogButton("Generate import token")!;
    generate().click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Unable to load tokens."));
    expect(generate().disabled).toBe(true);
    generate().click(); await tick();
    expect(writes().filter((request) => request.url.endsWith("/import-token"))).toHaveLength(1);
    failing = false;
    dialogButton("Retry")!.click();
    await vi.waitFor(() => expect(generate().disabled).toBe(false));
  });

  it("keeps revoke off after a failed revoke and a failed read", async () => {
    const path = `${east}/api/skills/import-token`;
    gateways.on("GET", path, { json: { tokens: [{ id: "t-1", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }] } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
    button("Add skill")!.click(); await tick();
    Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Import"))!.click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Revoke import token t-1"]')).not.toBeNull());
    gateways.on("DELETE", `${path}/t-1`, { status: 502, json: { error: "gateway_offline" } });
    gateways.on("GET", path, { status: 502, json: { error: "gateway_offline" } });
    document.querySelector<HTMLButtonElement>('[aria-label="Revoke import token t-1"]')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Unable to load tokens."));
    expect(writes().filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(dialogButton("Generate import token")!.disabled).toBe(true);
  });

  const openShare = async (shares: unknown[] = []) => {
    gateways.on("GET", `${east}/api/skills`, { json: groups(skill("same-id", "East Skill", { shares })) });
    gateways.on("GET", `${east}/api/skills/recipients`, { json: { users: [{ id: "u-1", name: "Una", email: "una@example.test" }] } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Share East Skill")).not.toBeNull());
    labelled("Share East Skill")!.click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="General access"]')).not.toBeNull());
  };
  const setGeneral = async (value: string) => {
    const general = document.querySelector<HTMLSelectElement>('[aria-label="General access"]')!;
    general.value = value; general.dispatchEvent(new Event("change", { bubbles: true })); await tick();
  };

  it("replaces the share draft with the shares that the recovery read returns", async () => {
    await openShare();
    await setGeneral("all");
    // The remote saved the change but the answer failed. The read shows the saved shares.
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { status: 502, json: { error: "gateway_offline" } });
    gateways.on("GET", `${east}/api/skills`, { json: groups(skill("same-id", "East Skill", { shares: [{ kind: "all", mode: "read" }] })) });
    const readsBefore = log().filter((entry) => entry === `GET ${east}/api/skills`).length;
    dialogButton("Save")!.click();
    await vi.waitFor(() => expect(log().filter((entry) => entry === `GET ${east}/api/skills`).length).toBeGreaterThan(readsBefore));
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="General access"]')!.value).toBe("all"));
    // The draft now equals the saved state, so a second Save has nothing to send.
    await vi.waitFor(() => expect(dialogButton("Save")!.disabled).toBe(true));
    dialogButton("Save")!.click(); await tick();
    expect(writes().filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("drops a draft change that the recovery read does not show", async () => {
    await openShare();
    await setGeneral("all");
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { status: 502, json: { error: "gateway_offline" } });
    const readsBefore = log().filter((entry) => entry === `GET ${east}/api/skills`).length;
    dialogButton("Save")!.click();
    await vi.waitFor(() => expect(log().filter((entry) => entry === `GET ${east}/api/skills`).length).toBeGreaterThan(readsBefore));
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="General access"]')!.value).toBe("restricted"));
  });

  it("keeps Save off after a failed save and a failed read, then turns it on after Read shares works", async () => {
    await openShare();
    await setGeneral("all");
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { status: 502, json: { error: "gateway_offline" } });
    let failing = true;
    gateways.on("GET", `${east}/api/skills`, () => failing ? { status: 502, json: { error: "gateway_offline" } } : { json: groups(skill("same-id", "East Skill")) });
    dialogButton("Save")!.click();
    await vi.waitFor(() => expect(dialogButton("Read shares")).toBeDefined());
    expect(dialogButton("Save")!.disabled).toBe(true);
    dialogButton("Save")!.click(); await tick();
    expect(writes().filter((request) => request.method === "PUT")).toHaveLength(1);
    failing = false;
    dialogButton("Read shares")!.click();
    await vi.waitFor(() => expect(dialogButton("Read shares")).toBeUndefined());
    await setGeneral("all");
    await vi.waitFor(() => expect(dialogButton("Save")!.disabled).toBe(false));
  });

  it("ignores a recovery read that ends after the share dialog closes", async () => {
    await openShare();
    await setGeneral("all");
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/shares`, { status: 502, json: { error: "gateway_offline" } });
    let release: (() => void) | undefined;
    gateways.on("GET", `${east}/api/skills`, () => new Promise<FakeAnswer>((resolve) => { release = () => resolve({ json: groups(skill("same-id", "East Skill")) }); }));
    dialogButton("Save")!.click();
    await vi.waitFor(() => expect(release).toBeDefined());
    dispose?.(); dispose = undefined;
    expect(() => release!()).not.toThrow();
    await tick();
    expect(writes().filter((request) => request.method === "PUT")).toHaveLength(1);
  });
});

describe("remote import prompt address", () => {
  const openImport = async (prompt: string) => {
    gateways.on("GET", `${east}/api/skills/import-token`, { json: { tokens: [] } });
    gateways.on("POST", `${east}/api/skills/import-token`, { status: 201, json: { id: "synthetic", token: "synthetic-token", expiresAt: "2099-01-01T00:00:00Z", prompt } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(button("Add skill")?.disabled).toBe(false));
    button("Add skill")!.click(); await tick();
    Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Import"))!.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Generate import token")!.click();
    await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skills/import-token`));
    await tick(); await tick();
  };

  it("shows the prompt for a public HTTPS address", async () => {
    await openImport("POST https://skills.example.test/api/skills/import");
    expect(document.querySelector('[aria-label="Import prompt"]')).not.toBeNull();
  });

  it("shows a configuration error and no secret for a public HTTP address", async () => {
    await openImport("POST http://skills.example.test/api/skills/import");
    expect(document.querySelector('[aria-label="Import prompt"]')).toBeNull();
    expect(document.querySelector('[aria-label="Import token"]')).toBeNull();
    expect(document.body.textContent).toContain("server.baseUrl");
    expect(document.body.textContent).toContain("HTTPS");
    expect(document.body.textContent).not.toContain("synthetic-token");
  });
});

describe("nested skill IDs through the alias", () => {
  const nestedId = "agent:hr:category/folder-name";
  const encodedNested = encodeURIComponent(nestedId);
  const detail = (name: string) => ({ ...skill(nestedId, name, { kind: "agent", locked: true, agentId: "hr", agentName: "HR", canWrite: false, canManage: false }), skillMd: `Instructions of ${name}`, files: [{ path: "SKILL.md", size: 8 }] });
  const listOf = (name: string) => ({ mine: [], sharedWithMe: [], agent: [skill(nestedId, name, { kind: "agent", locked: true, agentId: "hr", agentName: "HR", canWrite: false, canManage: false })] });
  const apiRequests = () => log().filter((line) => line.includes("/api/skill"));

  beforeEach(() => {
    gateways.on("GET", "/api/skills", { json: listOf("Local Nested") });
    gateways.on("GET", `${east}/api/skills`, { json: listOf("East Nested") });
    gateways.on("GET", `${west}/api/skills`, { json: listOf("West Nested") });
    gateways.on("GET", `/api/skills/${encodeURIComponent(nestedId)}`, { json: detail("Local Nested") });
    gateways.on("GET", `${east}/api/skill-ids/${wire(nestedId)}`, { json: detail("East Nested") });
    gateways.on("GET", `${west}/api/skill-ids/${wire(nestedId)}`, { json: detail("West Nested") });
  });

  it("links to the encoded ID with its gateway, and opens the same ID on Local, east, and west apart", async () => {
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(link("East Nested")?.getAttribute("href")).toBe(`/skills/${encodedNested}?gateway=east`));
    link("East Nested")!.click();
    await vi.waitFor(() => expect(text()).toContain("Instructions of East Nested"));
    // Only the alias of the named gateway saw the request, and no legacy object path went out.
    expect(apiRequests().filter((line) => !line.endsWith("/api/skills"))).toEqual([`GET ${east}/api/skill-ids/${wire(nestedId)}`]);
    history.set({ value: `/skills/${encodedNested}?gateway=west` });
    await vi.waitFor(() => expect(text()).toContain("Instructions of West Nested"));
    expect(text()).not.toContain("East Nested");
    history.set({ value: `/skills/${encodedNested}` });
    await vi.waitFor(() => expect(text()).toContain("Instructions of Local Nested"));
    expect(log()).toContain(`GET /api/skills/${encodedNested}`);
    expect(log().filter((line) => line.includes("/api/skill-ids/"))).toEqual([`GET ${east}/api/skill-ids/${wire(nestedId)}`, `GET ${west}/api/skill-ids/${wire(nestedId)}`]);
  });

  it("opens the page again on reload and returns with Back to the same gateway and ID", async () => {
    mount(`/skills/${encodedNested}?gateway=east`);
    await vi.waitFor(() => expect(text()).toContain("Instructions of East Nested"));
    expect(link("All skills")?.getAttribute("href")).toBe("/skills?gateway=east");
    history.set({ value: "/skills?gateway=west" });
    await vi.waitFor(() => expect(text()).toContain("West Nested"));
    history.back();
    await vi.waitFor(() => expect(text()).toContain("Instructions of East Nested"));
    expect(history.get()).toBe(`/skills/${encodedNested}?gateway=east`);
  });

  it("shows an error and makes no request for a malformed address escape", async () => {
    mount("/skills/%E0%A4%A?gateway=east");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("The skill address is not valid."));
    expect(apiRequests()).toEqual([]);
    expect(gateways.localConfigurationRequests()).toEqual([]);
  });

  it("makes no request for a gateway that is not configured, and never falls back to Local", async () => {
    mount(`/skills/${encodedNested}?gateway=nowhere`);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(apiRequests()).toEqual([]);
  });

  it("uses the alias for system, the default check, and Make default of a nested agent skill, and keeps returned IDs canonical", async () => {
    gateways.on("GET", `${east}/api/admin/skills`, { json: { skills: [], agent: [{ ...skill(nestedId, "East Nested", { kind: "agent", agentId: "hr", agentName: "HR" }), system: false }], system: [] } });
    gateways.on("PUT", `${east}/api/skill-ids/${wire(nestedId)}/system`, { json: { ok: true } });
    gateways.on("GET", `${east}/api/skill-ids/${wire(nestedId)}/default`, { json: { outsidePaths: [] } });
    gateways.on("POST", `${east}/api/skill-ids/${wire(nestedId)}/default`, { json: { id: "default:nested", name: "nested" } });
    mount("/admin/skills?gateway=east");
    await vi.waitFor(() => expect(labelled("Mark East Nested as system")).not.toBeNull());
    expect(link("East Nested")?.getAttribute("href")).toBe(`/skills/${encodedNested}?gateway=east`);
    labelled("Mark East Nested as system")!.click();
    await vi.waitFor(() => expect(writes().find((request) => request.url === `${east}/api/skill-ids/${wire(nestedId)}/system`)?.body).toEqual({ system: true }));
    await vi.waitFor(() => expect((labelled("Mark East Nested as system") as HTMLInputElement).disabled).toBe(false));
    labelled("Make East Nested a default skill")!.click();
    await vi.waitFor(() => expect(log()).toContain(`GET ${east}/api/skill-ids/${wire(nestedId)}/default`));
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "Make default").pop()!.click();
    await vi.waitFor(() => expect(log()).toContain(`POST ${east}/api/skill-ids/${wire(nestedId)}/default`));
    expect(log().some((line) => line.includes("/api/skills/agent"))).toBe(false);
  });
});

describe("a remote peer without the alias", () => {
  const nestedId = "agent:hr:category/folder-name";
  const row = skill(nestedId, "Old Nested", { kind: "agent", locked: true, agentId: "hr", agentName: "HR", canWrite: false, canManage: false });

  it("shows an explicit upgrade error for a read, with one request and no Local fallback", async () => {
    gateways.on("GET", `${east}/api/skills`, { json: { mine: [], sharedWithMe: [], agent: [row] } });
    gateways.on("GET", `${east}/api/skill-ids/${wire(nestedId)}`, new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
    mount(`/skills/${encodeURIComponent(nestedId)}?gateway=east`);
    await vi.waitFor(() => expect(text()).toContain("too old for this skill action"));
    expect(log().filter((line) => line.includes("/skill-ids/"))).toHaveLength(1);
    expect(gateways.localConfigurationRequests()).toEqual([]);
    expect(log().some((line) => line.includes("/api/skills/agent"))).toBe(false);
  });

  it("shows the upgrade error for a refused alias route of the local relay", async () => {
    gateways.on("GET", `${east}/api/skills`, { json: groups(skill("same-id", "East Skill")) });
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/enabled`, { status: 405, json: { error: "relay_route_not_allowed" } });
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("East Skill")).not.toBeNull());
    toggle("East Skill")!.click();
    await vi.waitFor(() => expect(text()).toContain("too old for this skill action"));
  });

  it("never repeats an uncertain write on a legacy route, and reads the same gateway before another write", async () => {
    gateways.on("PUT", `${east}/api/skill-ids/${wire("same-id")}/enabled`, new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
    mount("/skills?gateway=east");
    await vi.waitFor(() => expect(toggle("East Skill")).not.toBeNull());
    toggle("East Skill")!.click();
    await vi.waitFor(() => expect(text()).toContain("too old for this skill action"));
    await vi.waitFor(() => expect(log().filter((line) => line === `GET ${east}/api/skills`).length).toBeGreaterThan(1));
    expect(writes().map((request) => request.url)).toEqual([`${east}/api/skill-ids/${wire("same-id")}/enabled`]);
  });

  it("keeps a real missing skill (JSON 404) apart from a missing route", async () => {
    gateways.on("GET", `${east}/api/skills`, { json: { mine: [], sharedWithMe: [], agent: [row] } });
    gateways.on("GET", `${east}/api/skill-ids/${wire(nestedId)}`, { status: 404, json: { error: "not_found" } });
    mount(`/skills/${encodeURIComponent(nestedId)}?gateway=east`);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(text()).not.toContain("too old for this skill action");
  });
});
