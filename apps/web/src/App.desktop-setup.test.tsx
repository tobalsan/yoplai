// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, fireEvent, getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { loadCapabilities, resetCapabilitiesForTests } from "./lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let mode: boolean | undefined;
let auth: boolean;
let available: boolean;
let wizardExited: boolean;
let firstChat: object | null;
let setupReads: number;
let setupWrites: unknown[];
let overrides: (path: string, method: string, body: Record<string, unknown>) => Response | undefined;

const models = [
  { provider: "google", model: "environment", name: "Environment", source: "environment", default: true, ready: false },
  { provider: "openai-codex", model: "external", name: "External", source: "codex", default: true, ready: false },
  { provider: "openai", model: "owned", name: "Owned", source: "owned", default: true, ready: true },
];
const response = (body: unknown, status = 200) => Response.json(body, { status });
const heading = (name: string) => findByRole(root, "heading", { name });
const button = (name: string, scope: HTMLElement = root) => findByRole(scope, "button", { name });
const click = async (name: string, scope?: HTMLElement) => {
  const control = await button(name, scope) as HTMLButtonElement;
  await waitFor(() => expect(control.disabled).toBe(false));
  fireEvent.click(control);
};

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  mode = true; auth = false; available = true; wizardExited = false; firstChat = null;
  setupReads = 0; setupWrites = []; overrides = () => undefined;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("open", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/api/capabilities") return auth ? response({}, 401) : response({ desktopSetup: mode, multiUser: false, extensions: {}, agents: [], version: 2, relayLink: { available } });
    if (path === "/api/desktop-setup") {
      if (method === "PUT") { setupWrites.push(body); wizardExited = body.wizardExited; }
      else setupReads += 1;
      return response({ version: 1, wizardExited, skipped: body.skipped ?? [], firstChat, completed: false });
    }
    const overridden = overrides(path, method, body);
    if (overridden) return overridden;
    if (path === "/api/model-access") return response({
      owned: [{ providerId: "openai", type: "api_key" }], external: [{ source: "codex", detected: true, enabled: true, denied: false }],
      attempts: [], apiKeyProviders: [{ id: "openai", name: "OpenAI" }, { id: "mistral", name: "Mistral" }],
    });
    if (path === "/api/model-access/models") return response({ models });
    if (path === "/api/agents") return response([]);
    if (path === "/api/agents/alpha") return response({ id: "alpha", name: "Alpha", model: { provider: "openai", model: "owned" } });
    if (path.endsWith("/history")) return response({ messages: [] });
    if (path === "/api/me/main-agent") return response({});
    return response({}, 404);
  }));
  root = document.body.appendChild(document.createElement("div"));
});
afterEach(() => { dispose?.(); dispose = undefined; root.remove(); resetCapabilitiesForTests(); vi.unstubAllGlobals(); });

function boot(path: string) { history.replaceState({}, "", path); dispose = render(() => <App />, root); }
async function modelScreen() { await click("Get started"); await click("Continue"); await heading("Give your agents a model."); }
async function linkScreen() { await click("Get started"); await click("Connect to a Yoplai server"); await click("Continue"); }

it("redirects to setup, shows Back after welcome, and saves a skipped screen", async () => {
  boot("/agents");
  await heading("All your agents. One app.");
  expect(location.pathname).toBe("/setup");
  expect(queryByRole(root, "button", { name: "Back" })).toBeNull();
  await click("Get started");
  await heading("Where do your agents run?");
  await click("Back");
  await heading("All your agents. One app.");
  await click("Get started");
  await click("Skip");
  await waitFor(() => expect(location.pathname).toBe("/agents"));
  expect(setupWrites).toEqual([expect.objectContaining({ wizardExited: true, skipped: ["choice"] })]);
});

it.each([false, undefined])("does not read setup when the capability is %s", async (flag) => {
  mode = flag;
  boot("/setup");
  await waitFor(() => expect(location.pathname).toBe("/"));
  expect(setupReads).toBe(0);
});

it.each(["omission", "401"])("stops setup after a capability %s", async (change) => {
  boot("/setup");
  await heading("All your agents. One app.");
  expect(location.pathname).toBe("/setup");
  mode = undefined; auth = change === "401";
  await loadCapabilities();
  await waitFor(() => expect(location.pathname).toBe(auth ? "/login" : "/"));
  expect(setupReads).toBe(1);
});

it("sends no setup request on the multi-user login", async () => {
  auth = true;
  boot("/login");
  await waitFor(() => expect(location.pathname).toBe("/login"));
  expect(setupReads).toBe(0);
});

it("keeps the pending first chat open without starting the wizard", async () => {
  firstChat = { agentId: "alpha", sessionId: "first", turnId: "turn" };
  boot("/chat/alpha?session=first");
  await waitFor(() => expect(setupReads).toBe(1));
  expect(location.pathname).toBe("/chat/alpha");
  expect(queryByRole(root, "heading", { name: "All your agents. One app." })).toBeNull();
});

it.each(["linked", "pending", "unavailable"])("handles a %s server link", async (outcome) => {
  available = outcome !== "unavailable";
  overrides = (path) => {
    if (path.endsWith("/start")) return response(outcome === "linked" ? { status: "linked", name: "work" } : {
      attemptId: "test", controlToken: "fake-control", expiresAt: "later", consentUrl: "https://remote.example.test/consent",
    });
    if (path.endsWith("/status/test")) return response({ status: "linked", name: "work", remote: "https://remote.example.test" });
  };
  boot("/setup");
  await linkScreen();
  if (!available) {
    expect((await findByRole(root, "alert")).textContent).toContain("linked gateways turned on");
    expect(setupWrites).toHaveLength(0);
    return;
  }
  fireEvent.input(await findByRole(root, "textbox", { name: "Remote gateway address" }), { target: { value: "https://remote.example.test" } });
  await click("Link gateway");
  if (outcome === "pending") {
    expect((await findByRole(root, "link", { name: "Open the sign-in page" })).getAttribute("href")).toBe("https://remote.example.test/consent");
    expect(window.open).toHaveBeenCalledWith("https://remote.example.test/consent", "_blank", "noopener,noreferrer");
  }
  await waitFor(() => expect(location.pathname).toBe("/agents"), { timeout: 3000 });
  expect(setupWrites).toEqual([expect.objectContaining({ wizardExited: true })]);
});

it("resumes sign-in after reload, submits a code, and cancels a waiting attempt", async () => {
  let state: string | undefined;
  let sentCode: unknown;
  const attempt = () => ({ provider: "openai-codex", handle: "fake-attempt", state });
  overrides = (path, method, body) => {
    if (path === "/api/model-access") return response({ owned: [], external: [], attempts: state ? [attempt()] : [], apiKeyProviders: [] });
    if (path.endsWith("/oauth/openai-codex")) { state = "waiting-browser"; return response(attempt()); }
    if (path.endsWith("/cancel")) { state = undefined; return response({ ...attempt(), state: "cancelled" }); }
    if (path.endsWith("/answer")) { sentCode = body.code; state = undefined; return response({ ...attempt(), state: "done" }); }
    if (method === "GET" && path.endsWith("/fake-attempt")) return response(attempt());
  };
  boot("/setup");
  await modelScreen();
  const chatgpt = () => getByRole(root, "region", { name: "ChatGPT subscription" });
  await click("Sign in", chatgpt());
  expect((await within(chatgpt()).findByRole("status")).textContent).toBe("Finish the sign-in in your browser.");
  await click("Cancel", chatgpt());
  await click("Sign in", chatgpt());
  state = "waiting-code";
  dispose?.(); boot("/setup");
  const code = await findByRole(root, "textbox", { name: "Sign-in code" });
  fireEvent.input(code, { target: { value: "test-code" } });
  await click("Submit code");
  await waitFor(() => expect(sentCode).toBe("test-code"));
  await button("Sign in", chatgpt());
});

it("shows the gateway warning and confirms key replacement", async () => {
  const attempts: unknown[] = []; const keys: unknown[] = [];
  overrides = (path, _method, body) => {
    if (path.endsWith("/oauth/anthropic")) {
      attempts.push(body.warningAccepted);
      return body.warningAccepted ? response({ provider: "anthropic", handle: "fake-claude", state: "waiting-browser" })
        : response({ error: "warning_required", message: "Test Claude warning." }, 409);
    }
    if (path.endsWith("/api-key")) { keys.push(body.replace); return body.replace ? response({ saved: true }) : response({ error: "replacement_required" }, 409); }
  };
  boot("/setup");
  await modelScreen();
  await click("Sign in", getByRole(root, "region", { name: "Claude subscription" }));
  let dialog = await findByRole(root, "alertdialog");
  expect(dialog.textContent).toContain("Test Claude warning.");
  await click("Confirm", dialog);
  await waitFor(() => expect(attempts).toEqual([false, true]));
  await click("Add a key");
  const form = await findByRole(root, "form", { name: "Add an API key" });
  fireEvent.input(within(form).getByRole("textbox", { name: "Search providers" }), { target: { value: "mistral" } });
  fireEvent.change(within(form).getByRole("combobox"), { target: { value: "mistral" } });
  fireEvent.input(within(form).getByLabelText("API key"), { target: { value: "fake-api-key" } });
  await click("Save key", form);
  dialog = await findByRole(root, "alertdialog");
  expect(dialog.textContent).toContain("Replace the current credential");
  await click("Confirm", dialog);
  await waitFor(() => expect(keys).toEqual([false, true]));
});

it("creates the agent after retry with the same request ID and does not send a greeting", async () => {
  const drafts: Record<string, unknown>[] = [];
  overrides = (path, method, body) => {
    if (path === "/api/agents" && method === "POST") {
      drafts.push(body);
      return drafts.length === 1 ? response({ error: "reserved_prefix", message: "Remove the $env: or $secret: prefix." }, 400) : response({ id: "alpha" }, 201);
    }
  };
  boot("/setup");
  await modelScreen();
  await waitFor(() => expect((getByRole(root, "button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false));
  await click("Continue");
  await heading("Create your first agent.");
  const name = await findByRole(root, "textbox", { name: "Name" }) as HTMLInputElement;
  const original = name.value;
  await click("Inbox helper");
  expect(name.value).toBe(original);
  expect((getByRole(root, "textbox", { name: "Purpose" }) as HTMLInputElement).value).toBe("Sort my inbox and draft my replies.");
  expect((getByRole(root, "option", { name: /Owned.*Ready/ }) as HTMLOptionElement).selected).toBe(true);
  await click("Shuffle face");
  await click("Create agent");
  expect((await findByRole(root, "alert")).textContent).toBe("Remove the $env: or $secret: prefix.");
  await click("Retry");
  await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
  expect(location.search).toBe("");
  expect(drafts).toEqual([drafts[0], drafts[0]]);
  expect(drafts[0]).toMatchObject({ model: { provider: "openai", model: "owned" }, name: original });
  expect(setupWrites).toEqual([expect.objectContaining({ wizardExited: true })]);
});
