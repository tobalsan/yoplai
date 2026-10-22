// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ErrorBoundary, Suspense } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { Skills } from "./Skills";
import { ToastHost } from "../lib/toast";
import AdminSkills from "./admin/Skills";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
const requests: Array<{ path: string; method: string; body?: unknown }> = [];
const row = (id: string, name: string, extra = {}) => ({ id, name, description: `${name} guidance`, kind: "user", ownerName: "Ada", enabled: false, locked: false, shadowed: false, shares: [], mode: "write", updatedAt: null, canRead: true, canWrite: true, canManage: true, ...extra });
let mine: ReturnType<typeof row>[];
let respond: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;

beforeEach(() => {
  mine = [row("s1", "meeting-notes")];
  requests.length = 0;
  respond = () => undefined;
  setCapabilitiesForTests({ multiUser: true, user: { id: "u1", name: "Ada", role: "user" } });
  history.replaceState({}, "", "/skills");
  root = document.createElement("div"); document.body.appendChild(root);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const custom = await respond(path, init); if (custom) return custom;
    if (path === "/api/skills" && method === "GET") return Response.json({ mine, sharedWithMe: [], agent: [] });
    if (path === "/api/agents") return Response.json([{ id: "hr", name: "HR", avatar: "🦊" }, { id: "sales", name: "Sales" }]);
    if (path.endsWith("/enabled")) { mine = mine.map((skill) => ({ ...skill, enabled: true })); return Response.json({ ok: true }); }
    return Response.json({});
  }));
});
afterEach(() => { dispose?.(); root.remove(); resetCapabilitiesForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function control<T extends HTMLElement>(role: string, label: string): T {
  const candidate = Array.from(document.body.querySelectorAll<T>(`[role="${role}"], ${role === "button" ? "button" : role === "link" ? "a" : "input, select, textarea"}`)).find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  expect(candidate, `${role}: ${label}`).toBeDefined(); return candidate!;
}
const click = (name: string) => control<HTMLButtonElement>("button", name).click();
const actions = () => click("Actions for meeting-notes");
async function mount() { dispose = render(() => <Router><Route path="/skills" component={Skills} /><Route path="/skills/:id" component={Skills} /></Router>, root); await vi.waitFor(() => expect(root.textContent).toContain("meeting-notes guidance")); }

describe("Skills", () => {
  it("groups skills, locks built-ins, searches and enables the user's skill", async () => {
    await mount();
    expect(Array.from(root.querySelectorAll("h2"), (heading) => heading.textContent)).toEqual(["Your skills", "Agent skills"]);
    expect(control("img", "Skills you upload, create or import.")).toBeDefined();
    const toggle = control<HTMLInputElement>("switch", "Enable meeting-notes"); toggle.click();
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/s1/enabled", method: "PUT", body: { enabled: true } }));
    const search = control<HTMLInputElement>("searchbox", "Search skills"); search.value = "dashboard"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).not.toContain("meeting-notes guidance"));
  });
  it("asks before replacing an owned skill after a zip upload conflicts", async () => {
    respond = (path, init) => path === "/api/skills" && init?.method === "POST" ? Response.json({ error: "skill_exists", id: "s1" }, { status: 409 }) : undefined;
    await mount(); click("Add skill"); click("Upload zip");
    const file = control<HTMLInputElement>("file", "Skill zip file");
    Object.defineProperty(file, "files", { value: [new File(["zip-data"], "notes.zip", { type: "application/zip" })], configurable: true });
    file.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Replace existing skill"));
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    click("Replace");
    await vi.waitFor(() => expect(requests.some((request) => request.path === "/api/skills/s1/content" && request.method === "PUT")).toBe(true));
  });
  it("shares with a named writer and offers platform access only for reading", async () => {
    respond = (path) => path === "/api/skills/recipients" ? Response.json({ users: [{ id: "bob", name: "Bob", email: "bob@example.com" }] }) : undefined;
    await mount(); actions(); click("Share meeting-notes");
    await vi.waitFor(() => expect(document.body.textContent).toContain("People with access"));
    const picker = control<HTMLInputElement>("combobox", "Select a user"); await vi.waitFor(() => expect(picker.disabled).toBe(false)); picker.focus(); picker.value = "Bob"; picker.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Bob (bob@example.com)"));
    control<HTMLElement>("option", "BBob (bob@example.com)").click(); click("Add");
    const permission = control<HTMLSelectElement>("combobox", "Permission for Bob"); permission.value = "write"; permission.dispatchEvent(new Event("change", { bubbles: true }));
    const general = control<HTMLSelectElement>("combobox", "General access"); general.value = "all"; general.dispatchEvent(new Event("change", { bubbles: true }));
    expect(control<HTMLSelectElement>("combobox", "Everyone permission").textContent).not.toContain("Can edit");
    click("Save");
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/s1/shares", method: "PUT", body: { shares: [{ kind: "user", id: "bob", mode: "write" }, { kind: "all", mode: "read" }] } }));
  });
  it("shows a one-time import prompt and revokes an active token", async () => {
    respond = (path, init) => {
      if (path === "/api/skills/import-token") return Response.json(init?.method === "POST" ? { id: "t1", token: "test-import-only", expiresAt: "2026-10-20T12:00:00Z", prompt: "Send only skill files to https://example.test/api/skills/import" } : { tokens: [{ id: "t1", createdAt: "2026-10-19T12:00:00Z", expiresAt: "2026-10-20T12:00:00Z" }] });
    };
    await mount(); click("Add skill"); click("Import from Claude or ChatGPT");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Active import tokens"));
    click("Generate import token");
    await vi.waitFor(() => expect(control<HTMLTextAreaElement>("textbox", "Import prompt").value).toContain("Send only skill files"));
    expect(control<HTMLInputElement>("textbox", "Import token").value).toBe("test-import-only");
    click("Revoke import token t1");
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/import-token/t1", method: "DELETE", body: undefined }));
  });
  it("rolls back a saved version and confirms deletion", async () => {
    respond = (path) => path === "/api/skills/s1/versions" ? Response.json({ versions: [{ id: "v1", createdAt: "2026-10-18T12:00:00Z" }] }) : undefined;
    await mount(); actions(); click("Versions of meeting-notes");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Version history"));
    await vi.waitFor(() => expect(control<HTMLButtonElement>("button", "Restore version v1").disabled).toBe(false)); click("Restore version v1");
    await vi.waitFor(() => expect(requests.some((request) => request.path === "/api/skills/s1/versions/v1/restore" && request.method === "POST")).toBe(true));
    await vi.waitFor(() => expect(control<HTMLButtonElement>("button", "Close versions").disabled).toBe(false)); click("Close versions"); actions(); click("Delete meeting-notes");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete")!.click();
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/s1", method: "DELETE", body: undefined }));
  });
  it("opens read-only skill instructions and file sizes without edit controls for readers", async () => {
    respond = (path) => path === "/api/skills/shared1" ? Response.json({ ...row("shared1", "meeting-notes", { canManage: false, canWrite: false, mode: "read" }), skillMd: "---\nname: meeting-notes\ndescription: meeting-notes guidance\n---\n# Minutes\nRecord decisions and owners.", files: [{ path: "SKILL.md", size: 122 }, { path: "references/example.md", size: 44 }] }) : undefined;
    history.replaceState({}, "", "/skills/shared1"); await mount();
    expect(root.textContent).toContain("Record decisions and owners.");
    expect(root.textContent).toContain("references/example.md"); expect(root.textContent).toContain("44 bytes");
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent?.includes("Update"))).toBe(false);
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent?.includes("Share"))).toBe(false);
  });
  it("lets a superadmin inspect collisions and disable a platform-wide skill", async () => {
    setCapabilitiesForTests({ multiUser: true, user: { id: "admin", name: "Admin", role: "superadmin" } });
    respond = (path) => path === "/api/skills/recipients" ? Response.json({ users: [{ id: "bob", name: "Bob", email: "bob@example.com" }] }) : path === "/api/admin/skills" ? Response.json({ skills: [{ ...row("s1", "meeting-notes", { shares: [{ kind: "all", mode: "read" }, { kind: "user", id: "bob", mode: "write" }] }), enabledCount: 3, collisions: ["default:meeting-notes"] }], agent: [], system: [row("builtin:dashboard", "dashboard", { kind: "builtin", locked: true }), row("default:hr-writing", "hr-writing", { kind: "default", locked: true, agents: ["hr"] })] }) : undefined;
    history.replaceState({}, "", "/admin/skills");
    dispose = render(() => <Router><Route path="/admin/skills" component={AdminSkills} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("default:meeting-notes"));
    expect(root.textContent).toContain("Ada"); expect(root.textContent).toContain("3 users");
    expect(root.textContent).toContain("System skills"); expect(control<HTMLAnchorElement>("link", "dashboard").getAttribute("href")).toBe("/skills/builtin%3Adashboard");
    expect(root.textContent).toContain("All agents"); expect(root.textContent).toContain("hr-writing");
    await vi.waitFor(() => expect(root.textContent).toContain("Bob · edit")); expect(root.textContent).not.toContain("bob · edit");
    click("Disable meeting-notes");
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/s1/admin", method: "PUT", body: { disabledByAdmin: true } }));
  });
  it("lets a superadmin mark an agent skill as system on the admin page", async () => {
    setCapabilitiesForTests({ multiUser: true, user: { id: "admin", name: "Admin", role: "superadmin" } });
    const onboarding = row("agent:hr:skills/onboarding", "onboarding", { kind: "agent", agentId: "hr", agentName: "HR", locked: true, canWrite: false, canManage: false, system: false });
    respond = (path) => path === "/api/skills/recipients" ? Response.json({ users: [] }) : path === "/api/admin/skills" ? Response.json({ skills: [], agent: [onboarding], system: [] }) : undefined;
    history.replaceState({}, "", "/admin/skills");
    dispose = render(() => <Router><Route path="/admin/skills" component={AdminSkills} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("onboarding guidance"));
    expect(root.querySelector("[role=tabpanel]")?.getAttribute("aria-label")).toBe("HR");
    expect(control<HTMLAnchorElement>("link", "onboarding").getAttribute("href")).toBe("/skills/agent%3Ahr%3Askills%2Fonboarding");
    control<HTMLInputElement>("switch", "Mark onboarding as system").click();
    await vi.waitFor(() => expect(requests).toContainEqual({ path: "/api/skills/agent%3Ahr%3Askills%2Fonboarding/system", method: "PUT", body: { system: true } }));
  });
  it("refreshes on focus and discovers a newly imported skill through polling", async () => {
    vi.useFakeTimers();
    await mount();
    mine.push(row("s2", "inbox-summary")); window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(root.textContent).toContain("inbox-summary guidance"));
    mine.push(row("s3", "weekly-review"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(root.textContent).toContain("weekly-review guidance");
  });
  it("closes the Add skill menu when the user clicks elsewhere on the page", async () => {
    await mount(); click("Add skill");
    expect(document.body.textContent).toContain("Upload zip");
    control<HTMLInputElement>("searchbox", "Search skills").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Upload zip"));
  });
  it("closes a skill actions menu when the user clicks elsewhere on the page", async () => {
    await mount(); actions();
    await vi.waitFor(() => expect(control<HTMLElement>("button", "Actions for meeting-notes").getAttribute("aria-expanded")).toBe("true"));
    control<HTMLInputElement>("searchbox", "Search skills").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(control<HTMLElement>("button", "Actions for meeting-notes").getAttribute("aria-expanded")).toBe("false"));
  });
  it("opens the detail page of a skill whose id needs URL encoding", async () => {
    const notes = row("agent:hr:notes", "notes", { kind: "agent", agentName: "HR", locked: true, canWrite: false, canManage: false });
    respond = (path) => path === "/api/skills" ? Response.json({ mine, sharedWithMe: [], agent: [notes] }) : path === "/api/skills/agent%3Ahr%3Anotes" ? Response.json({ ...notes, skillMd: "Notes instructions", files: [{ path: "SKILL.md", size: 18 }] }) : undefined;
    await mount(); control<HTMLAnchorElement>("link", "notes").click();
    await vi.waitFor(() => expect(root.textContent).toContain("Notes instructions"));
    expect(root.textContent).not.toContain("Unable to load skills");
  });
  it("shows agent skills in one tab for each agent", async () => {
    const agentRow = (agentId: string, agentName: string, name: string) => row(`agent:${agentId}:${name}`, name, { kind: "agent", agentId, agentName, locked: true, canWrite: false, canManage: false });
    respond = (path) => path === "/api/skills" ? Response.json({ mine, sharedWithMe: [], agent: [agentRow("sales", "Sales", "pitch"), agentRow("hr", "HR", "onboarding"), agentRow("hr", "HR", "leave")] }) : undefined;
    await mount();
    const tabs = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs().map((tab) => tab.textContent)).toEqual(["🦊HR2", "SSales1"]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(root.textContent).toContain("onboarding guidance");
    expect(root.textContent).not.toContain("pitch guidance");
    expect(root.textContent).not.toContain("HR workspace");
    tabs()[1].click();
    await vi.waitFor(() => expect(root.textContent).toContain("pitch guidance"));
    expect(root.textContent).not.toContain("onboarding guidance");
    expect(control("tabpanel", "Sales")).toBeDefined();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(requests.filter((request) => request.path === "/api/skills").length).toBeGreaterThan(1));
    const search = control<HTMLInputElement>("searchbox", "Search skills");
    search.value = "nothing-matches"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).not.toContain("pitch guidance"));
    search.value = ""; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain("pitch guidance"));
    expect(root.textContent).not.toContain("onboarding guidance");
  });
  it("keeps the page on screen while a background refresh is in flight", async () => {
    dispose = render(() => <Router><Route path="/skills" component={() => <Suspense fallback={<p>Booting</p>}><Skills /></Suspense>} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("meeting-notes guidance"));
    let release!: () => void;
    respond = (path, init) => path === "/api/skills" && (init?.method ?? "GET") === "GET" ? new Promise<Response>((resolve) => { release = () => resolve(Response.json({ mine, sharedWithMe: [], agent: [] })); }) : undefined;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(requests.filter((request) => request.path === "/api/skills").length).toBe(2));
    expect(root.textContent).toContain("meeting-notes guidance");
    expect(root.textContent).not.toContain("Booting");
    expect(root.textContent).not.toContain("Loading skills");
    release();
  });
  it("shows a toast after a successful or failed zip upload", async () => {
    let fail = false;
    respond = (path, init) => path === "/api/skills" && init?.method === "POST" ? (fail ? Response.json({ error: "missing_skill_md" }, { status: 400 }) : Response.json({ id: "s9", name: "notes" }, { status: 201 })) : undefined;
    dispose = render(() => <><ToastHost /><Router><Route path="/skills" component={Skills} /></Router></>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("meeting-notes guidance"));
    const send = () => {
      const file = control<HTMLInputElement>("file", "Skill zip file");
      Object.defineProperty(file, "files", { value: [new File(["zip-data"], "notes.zip", { type: "application/zip" })], configurable: true });
      file.dispatchEvent(new Event("change", { bubbles: true }));
    };
    send();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Skill "notes" added. Turn it on to use it.'));
    fail = true; send();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Upload failed: Add a SKILL.md file at the top level of the skill."));
  });
  it("strips the browser folder root in multipart paths", async () => {
    await mount(); click("Add skill"); click("Upload folder");
    const skill = new File(["skill content"], "SKILL.md"); Object.defineProperty(skill, "webkitRelativePath", { value: "my-folder/SKILL.md" });
    const reference = new File(["reference"], "example.txt"); Object.defineProperty(reference, "webkitRelativePath", { value: "my-folder/references/example.txt" });
    const input = control<HTMLInputElement>("file", "Skill folder files"); Object.defineProperty(input, "files", { value: [skill, reference], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(requests.some((request) => request.path === "/api/skills" && request.method === "POST")).toBe(true));
    const body = requests.find((request) => request.path === "/api/skills" && request.method === "POST")!.body as FormData;
    expect(body.getAll("files").map((file) => (file as File).name)).toEqual(["SKILL.md", "references/example.txt"]);
  });
  it("recovers from a hung enable request while background refresh continues", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Skill request timed out", "TimeoutError")), milliseconds); return controller.signal;
    });
    await mount();
    respond = (path, init) => path.endsWith("/enabled") ? new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })) : undefined;
    control<HTMLInputElement>("switch", "Enable meeting-notes").click();
    mine.push(row("s4", "new-import"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(root.textContent).toContain("Skill request timed out"); expect(root.textContent).toContain("new-import guidance");
    expect(control<HTMLInputElement>("switch", "Enable meeting-notes").disabled).toBe(false);
    respond = () => undefined; control<HTMLInputElement>("switch", "Enable meeting-notes").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(control<HTMLInputElement>("switch", "Enable meeting-notes").checked).toBe(true);
  });
  it("keeps the actions menu available while focus refresh updates the list", async () => {
    await mount(); actions();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(requests.filter((request) => request.path === "/api/skills").length).toBe(2));
    await vi.waitFor(() => expect(control<HTMLElement>("button", "Actions for meeting-notes").getAttribute("aria-expanded")).toBe("true"));
    click("Versions of meeting-notes");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Version history"));
  });
  it("shows a recoverable list error when the server is unavailable", async () => {
    respond = (path) => path === "/api/skills" ? Response.json({ error: "unavailable" }, { status: 503 }) : undefined;
    dispose = render(() => <Router><Route path="/skills" component={() => <ErrorBoundary fallback={<p role="alert">Page crashed</p>}><Skills /></ErrorBoundary>} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("Unable to load skills."));
    respond = () => undefined; click("Retry");
    await vi.waitFor(() => expect(root.textContent).toContain("meeting-notes guidance"));
  });
  it("lets a named writer replace by id without offering ownership actions", async () => {
    respond = (path) => path === "/api/skills" ? Response.json({ mine: [], sharedWithMe: [row("shared1", "meeting-notes", { canManage: false, ownerName: "Bob" })], agent: [] }) : undefined;
    await mount(); actions();
    expect(root.textContent).toContain("No skills yet. Use Add skill to upload, create or import one.");
    expect(Array.from(root.querySelectorAll("h2"), (heading) => heading.textContent)).toContain("Shared with me");
    expect(root.textContent).toContain("Can edit");
    expect(Array.from(root.querySelectorAll("button")).some((button) => button.textContent === "Share" || button.textContent === "Delete")).toBe(false);
    click("Update meeting-notes"); click("Update from folder");
    const skill = new File(["replacement"], "SKILL.md"); Object.defineProperty(skill, "webkitRelativePath", { value: "replacement/SKILL.md" });
    const input = control<HTMLInputElement>("file", "Skill folder files"); Object.defineProperty(input, "files", { value: [skill], configurable: true }); input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(requests.some((request) => request.path === "/api/skills/shared1/content" && request.method === "PUT")).toBe(true));
  });
});
