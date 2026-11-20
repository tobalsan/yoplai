// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findByRole, fireEvent, getByRole, queryByRole, waitFor, within } from "@testing-library/dom";
import { render } from "solid-js/web";
import App from "./App";
import { FIRST_GREETING } from "./desktop-setup/first-chat";
import { loadCapabilities, resetCapabilitiesForTests } from "./lib/capabilities";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let mode: boolean | undefined;
let auth: boolean;
let available: boolean;
let wizardExited: boolean;
let firstChat: { agentId: string; sessionId: string; turnId: string } | null;
let completed: boolean;
let setupReads: number;
let setupWrites: unknown[];
let overrides: (path: string, method: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined;

const models = [
  { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron Lightning", source: "owned", default: false, ready: false, free: true },
  { provider: "google", model: "environment", name: "Environment", source: "environment", default: true, ready: false, free: false },
  { provider: "openai-codex", model: "external", name: "External", source: "codex", default: true, ready: false, free: false },
  { provider: "openai", model: "owned", name: "Owned", source: "owned", default: true, ready: true, free: false },
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
  mode = true; auth = false; available = true; wizardExited = false; firstChat = null; completed = false;
  setupReads = 0; setupWrites = []; overrides = () => undefined;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("open", vi.fn());
  GreetingSocket.openSends = false;
  GreetingSocket.failConnect = false;
  vi.stubGlobal("WebSocket", GreetingSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/api/capabilities") return auth ? response({}, 401) : response({ desktopSetup: mode, multiUser: false, extensions: {}, agents: [], version: 2, relayLink: { available } });
    const overridden = overrides(path, method, body);
    if (path === "/api/desktop-setup") {
      if (method === "GET") setupReads += 1;
      if (overridden) return overridden;
      if (method === "PUT") {
        setupWrites.push(body);
        if (typeof body.wizardExited === "boolean") wizardExited = body.wizardExited;
        if ("firstChat" in body) firstChat = body.firstChat as typeof firstChat;
        if (typeof body.completed === "boolean") completed = body.completed;
      }
      return response({ version: 1, wizardExited, skipped: body.skipped ?? [], firstChat, completed });
    }
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
async function modelScreen() { await click("Get started"); await click("Continue"); await heading("Choose a model provider"); }
async function linkScreen() { await click("Get started"); await click("Connect to a Yoplai server"); await click("Continue"); }

it("redirects to setup, shows Back after welcome, and saves a skipped screen", async () => {
  boot("/agents");
  await heading("All your agents. One app.");
  expect(location.pathname).toBe("/setup");
  expect(getByRole(root, "img", { name: /^Yoplai$/i })).toBeTruthy();
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
  await click("Provider: Select a provider", form);
  const search = within(form).getByRole("combobox", { name: "Search providers" });
  fireEvent.input(search, { target: { value: "mistral" } });
  fireEvent.click(within(form).getByRole("option", { name: "Mistral" }));
  fireEvent.input(within(form).getByLabelText("API key"), { target: { value: "fake-api-key" } });
  await click("Save key", form);
  dialog = await findByRole(root, "alertdialog");
  expect(dialog.textContent).toContain("Replace the current credential");
  await click("Confirm", dialog);
  await waitFor(() => expect(keys).toEqual([false, true]));
});

it("filters providers and returns focus after Escape or a keyboard choice", async () => {
  boot("/setup?step=model");
  await click("Add a key");
  const form = getByRole(root, "form", { name: "Add an API key" });
  const trigger = await button("Provider: Select a provider", form);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  let search = within(form).getByRole("combobox", { name: "Search providers" });
  expect(document.activeElement).toBe(search);
  fireEvent.input(search, { target: { value: "mistral" } });
  expect(within(form).getAllByRole("option").map((option) => option.textContent)).toEqual(["Mistral"]);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(within(form).queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await click("Provider: Select a provider", form);
  search = within(form).getByRole("combobox", { name: "Search providers" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(await button("Provider: Mistral", form)).toBe(document.activeElement);
});

it("shows suggested models, expands a provider, and selects a free match", async () => {
  boot("/setup?step=agent");
  await click("Model: Owned OpenAI Ready");
  const search = getByRole(root, "combobox", { name: "Search models" });
  expect(document.activeElement).toBe(search);
  expect(within(getByRole(root, "group", { name: "Suggested" })).getByRole("option", { name: /Owned/ })).toBeTruthy();
  expect(queryByRole(root, "option", { name: /Nemotron/ })).toBeNull();
  fireEvent.click(getByRole(root, "option", { name: /OpenRouter.*Expand/ }));
  expect(getByRole(root, "option", { name: /Nemotron Lightning.*Free/ })).toBeTruthy();
  fireEvent.input(search, { target: { value: "openrouter 3.5 free" } });
  expect(queryByRole(root, "group", { name: "Suggested" })).toBeNull();
  expect(within(getByRole(root, "group", { name: "OpenRouter" })).getByRole("option", { name: /Nemotron Lightning.*Free/ })).toBeTruthy();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(await button("Model: Nemotron Lightning OpenRouter Free")).toBe(document.activeElement);
  expect(queryByRole(root, "listbox")).toBeNull();
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
  expect(await button("Model: Owned OpenAI Ready")).toBeTruthy();
  await click("Shuffle face");
  await click("Create agent");
  expect((await findByRole(root, "alert")).textContent).toBe("Remove the $env: or $secret: prefix.");
  await click("Retry");
  await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
  expect(new URLSearchParams(location.search).get("session")).toBe(firstChat?.sessionId);
  expect(drafts).toEqual([drafts[0], drafts[0]]);
  expect(drafts[0]).toMatchObject({ model: { provider: "openai", model: "owned" }, name: original });
  expect(setupWrites).toEqual([expect.objectContaining({ wizardExited: true })]);
});

function holdReply() {
  let reply!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { reply = resolve; });
  return { pending, reply };
}

it("retries the same submission after a reload with no models", async () => {
  const lost = holdReply();
  const drafts: Record<string, unknown>[] = [];
  overrides = (path, method, body) => {
    if (path.endsWith("/model-access/models") && drafts.length) return response({ models: [] });
    if (path === "/api/agents" && method === "POST") {
      drafts.push(body);
      return drafts.length === 1 ? lost.pending : response({ id: "alpha" }, 200);
    }
  };
  boot("/setup");
  await modelScreen();
  await click("Continue");
  const name = await findByRole(root, "textbox", { name: "Name" });
  fireEvent.input(name, { target: { value: "Saved agent" } });
  await click("Create agent");
  await waitFor(() => expect(drafts).toHaveLength(1));
  dispose?.();
  boot("/setup");
  expect((await findByRole(root, "textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Saved agent");
  await click("Retry");
  await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
  expect(drafts).toEqual([drafts[0], drafts[0]]);
  lost.reply(response({ id: "alpha" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(setupWrites).toHaveLength(1);
});

const pendingLink = () => response({
  attemptId: "test", controlToken: "fake-control", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  consentUrl: "https://remote.example.test/consent",
});
const linked = () => response({ status: "linked", name: "work", remote: "https://remote.example.test" });
async function startServerLink() {
  boot("/setup");
  await linkScreen();
  fireEvent.input(await findByRole(root, "textbox", { name: "Remote gateway address" }), { target: { value: "https://remote.example.test" } });
  await click("Link gateway");
}

it.each(["pending start", "linked start", "linked status"])("ignores a late %s reply after Back", async (step) => {
  const { pending, reply } = holdReply();
  const requested = vi.fn();
  overrides = (path) => {
    if (path.endsWith("/start")) {
      if (step === "linked status") return pendingLink();
      requested();
      return pending;
    }
    if (path.endsWith("/status/test")) { requested(); return pending; }
    if (path.endsWith("/cancel")) return response({ status: "cancelled" });
  };
  await startServerLink();
  await waitFor(() => expect(requested).toHaveBeenCalled(), { timeout: 2500 });
  await click("Back");
  reply(step === "pending start" ? pendingLink() : linked());
  await new Promise((resolve) => setTimeout(resolve, 0));
  await heading("Where do your agents run?");
  expect(window.open).toHaveBeenCalledTimes(step === "linked status" ? 1 : 0);
  expect(setupWrites).toHaveLength(0);
  expect(location.pathname).toBe("/setup");
});

it("resumes the link in the same tab without opening consent twice", async () => {
  overrides = (path) => {
    if (path.endsWith("/start")) return pendingLink();
    if (path.endsWith("/status/test")) return linked();
  };
  await startServerLink();
  await findByRole(root, "link", { name: "Open the sign-in page" });
  dispose?.();
  boot("/setup");
  await heading("Connect to a Yoplai server");
  expect(queryByRole(root, "link", { name: "Open the sign-in page" })).toBeNull();
  await waitFor(() => expect(location.pathname).toBe("/agents"), { timeout: 2500 });
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(setupWrites).toEqual([expect.objectContaining({ wizardExited: true })]);
});

it.each(["Cancel", "Edit key", "Edit provider", "Edit provider before reply", "Edit before reply", "Cancel before reply", "Search", "Search before reply"])("discards a key confirmation after %s", async (action) => {
  const old = holdReply();
  const calls: unknown[] = [];
  const replacement = () => response({ error: "replacement_required" }, 409);
  overrides = (path, _method, body) => {
    if (path.endsWith("/api-key")) { calls.push(body.replace); return action.endsWith("before reply") ? old.pending : replacement(); }
  };
  boot("/setup");
  await modelScreen();
  await click("Add a key");
  const form = await findByRole(root, "form", { name: "Add an API key" });
  const key = within(form).getByLabelText("API key");
  await click("Provider: Select a provider", form);
  fireEvent.click(within(form).getByRole("option", { name: "OpenAI" }));
  fireEvent.input(key, { target: { value: "fake-old-key" } });
  await click("Save key", form);
  if (!action.endsWith("before reply")) await findByRole(root, "alertdialog");
  if (action.startsWith("Cancel")) await click("Cancel", form);
  else if (action.startsWith("Search") || action.startsWith("Edit provider")) {
    await click("Provider: OpenAI", form);
    const search = within(form).getByRole("combobox", { name: "Search providers" });
    if (action.startsWith("Search")) {
      fireEvent.input(search, { target: { value: "mistral" } });
      expect((await button("Save key", form) as HTMLButtonElement).disabled).toBe(true);
    } else fireEvent.click(within(form).getByRole("option", { name: "Mistral" }));
  } else fireEvent.input(key, { target: { value: "fake-new-key" } });
  old.reply(replacement());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(queryByRole(root, "alertdialog")).toBeNull();
  expect(calls).toEqual([false]);
});

it.each(["/setup", "/agents"])("blocks %s until setup read succeeds", async (path) => {
  overrides = (url) => url === "/api/desktop-setup" ? response({ message: "Internal error detail." }, 500) : undefined;
  boot(path);
  expect((await findByRole(root, "alert")).textContent).toBe("Yoplai could not read the setup state.");
  expect(queryByRole(root, "heading", { name: "All your agents. One app." })).toBeNull();
  expect(queryByRole(root, "navigation")).toBeNull();
  overrides = () => undefined;
  await click("Retry");
  await heading("All your agents. One app.");
  expect(setupReads).toBe(2);
});

it.each(["Back", "Skip"])("waits for a late start and cancels it before %s", async (action) => {
  const start = holdReply();
  const cancel = holdReply();
  const cancelRequests = vi.fn();
  overrides = (path, _method, body) => {
    if (path.endsWith("/start")) return start.pending;
    if (path.endsWith("/cancel")) { cancelRequests(body.attemptId); return cancel.pending; }
  };
  await startServerLink();
  await click(action);
  expect((await findByRole(root, "status", { name: "" })).textContent).toContain("Wait for the gateway");
  start.reply(pendingLink());
  await waitFor(() => expect(cancelRequests).toHaveBeenCalledWith("test"));
  expect(window.open).not.toHaveBeenCalled();
  expect((await button("Link gateway") as HTMLButtonElement).disabled).toBe(true);
  expect(location.pathname).toBe("/setup");
  cancel.reply(response({ status: "cancelled" }));
  if (action === "Back") await heading("Where do your agents run?");
  else await waitFor(() => expect(location.pathname).toBe("/agents"));
});

it("keeps a pending link if Back cannot cancel it and lets the same gateway link after retry", async () => {
  let pending = false;
  let starts = 0;
  let cancels = 0;
  overrides = (path, _method, body) => {
    if (path.endsWith("/start")) {
      expect(body.remote).toBe("https://remote.example.test");
      starts += 1;
      if (pending) return response({ error: "name_in_use" }, 409);
      if (starts === 2) return linked();
      pending = true;
      return pendingLink();
    }
    if (path.endsWith("/cancel")) {
      cancels += 1;
      if (cancels === 1) return response({ message: "Try to cancel again." }, 503);
      expect(body.attemptId).toBe("test");
      pending = false;
      return response({ status: "cancelled" });
    }
  };
  await startServerLink();
  await findByRole(root, "link", { name: "Open the sign-in page" });
  await click("Back");
  expect((await findByRole(root, "alert")).textContent).toBe("Try to cancel again.");
  await click("Back");
  await heading("Where do your agents run?");
  await click("Continue");
  fireEvent.input(await findByRole(root, "textbox", { name: "Remote gateway address" }), { target: { value: "https://remote.example.test" } });
  await click("Link gateway");
  await waitFor(() => expect(location.pathname).toBe("/agents"));
  expect(starts).toBe(2);
  expect(cancels).toBe(2);
});

it.each(["Resume status checks", "Cancel"])("lets the user choose %s after a temporary status error", async (action) => {
  let reads = 0;
  const cancelled = vi.fn();
  overrides = (path) => {
    if (path.endsWith("/start")) return pendingLink();
    if (path.endsWith("/status/test")) return ++reads === 1 ? response({ message: "Try to read the status again." }, 503) : linked();
    if (path.endsWith("/cancel")) { cancelled(); return response({ status: "cancelled" }); }
  };
  await startServerLink();
  expect((await findByRole(root, "alert", {}, { timeout: 2500 })).textContent).toBe("Try to read the status again.");
  await click(action);
  if (action === "Cancel") {
    await waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(setupWrites).toHaveLength(0);
  } else await waitFor(() => expect(location.pathname).toBe("/agents"), { timeout: 2500 });
  expect(window.open).toHaveBeenCalledTimes(1);
});

it("opens the original chat after create succeeds but the setup exit save fails", async () => {
  const drafts: Record<string, unknown>[] = [];
  let exits = 0;
  overrides = (path, method, draft) => {
    if (path === "/api/desktop-setup" && method === "PUT" && ++exits === 1) return response({ message: "Could not save setup." }, 500);
    if (path === "/api/agents" && method === "POST") {
      drafts.push(draft);
      return response({ id: draft.requestId === drafts[0].requestId ? "alpha" : "another-agent" });
    }
    if (path.endsWith("/model-access/models") && drafts.length) return response({ models: [] });
  };
  boot("/setup");
  await modelScreen();
  await click("Continue");
  await click("Create agent");
  await button("Retry");
  expect(location.pathname).toBe("/setup");
  expect(exits).toBe(1);
  dispose?.();
  boot("/setup");
  await click("Retry");
  await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
  expect(drafts).toEqual([drafts[0], drafts[0]]);
  expect(exits).toBe(2);
});

it.each(["Back", "Skip"])("sends a new cancellation after a timeout on %s", async (action) => {
  const requests: ReturnType<typeof holdReply>[] = [];
  overrides = (path) => {
    if (path.endsWith("/start")) return pendingLink();
    if (path.endsWith("/cancel")) {
      const request = holdReply();
      requests.push(request);
      return request.pending;
    }
  };
  await startServerLink();
  await findByRole(root, "link", { name: "Open the sign-in page" });
  const exit = await button(action);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(exit);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(getByRole(root, "alert").textContent).toBe("The gateway did not reply. Try again.");
    fireEvent.click(exit);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    requests[0].reply(linked());
    await vi.advanceTimersByTimeAsync(0);
    expect(getByRole(root, "heading", { name: "Connect to a Yoplai server" })).toBeTruthy();
    expect(setupWrites).toHaveLength(0);
    requests[1].reply(response({ status: "cancelled" }));
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
  if (action === "Back") await heading("Where do your agents run?");
  else await waitFor(() => expect(location.pathname).toBe("/agents"));
});

it("shows the late consent link when cancellation fails without opening a tab", async () => {
  const start = holdReply();
  overrides = (path) => {
    if (path.endsWith("/start")) return start.pending;
    if (path.endsWith("/cancel")) return response({ message: "Try to cancel again." }, 503);
  };
  await startServerLink();
  await click("Back");
  start.reply(pendingLink());
  expect((await findByRole(root, "alert")).textContent).toBe("Try to cancel again.");
  const link = await findByRole(root, "link", { name: "Open the sign-in page" });
  expect(link.getAttribute("href")).toBe("https://remote.example.test/consent");
  expect(window.open).not.toHaveBeenCalled();
  expect(setupWrites).toHaveLength(0);
});

class GreetingSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static wires: { socket: GreetingSocket; payload: Record<string, unknown> }[] = [];
  static openSends = true;
  static failConnect = false;
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { queueMicrotask(() => {
    if (GreetingSocket.failConnect) this.onerror?.();
    else if (GreetingSocket.openSends) this.open();
  }); }
  open() { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }
  send(data: string) {
    const payload = JSON.parse(data);
    if (payload.type === "send") GreetingSocket.wires.push({ socket: this, payload });
  }
  close() { this.readyState = 3; }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const oldChat = { agentId: "alpha", sessionId: "old-session", turnId: "old-turn" };
const answer = "I am your agent. I can sort your tasks.";
const unrelatedAnswer = "This answer belongs to another turn.";
const message = (role: "user" | "assistant", text: string, timestamp: number) => ({
  role, content: [{ type: "text", text }], timestamp,
});
const transcript = () => within(getByRole(root, "region", { name: "Chat transcript" }));
const activeGreeting = {
  userText: FIRST_GREETING, userTimestamp: 1, startedAt: 2, text: "", thinking: "", toolCalls: [], toolResults: [],
};
function enableGreetingSocket() {
  GreetingSocket.wires = [];
  GreetingSocket.openSends = true;
  vi.stubGlobal("WebSocket", GreetingSocket);

}

it("starts again, saves new chat IDs, and sends one greeting after a reload before the send", async () => {
  enableGreetingSocket();
  wizardExited = true; completed = true; firstChat = oldChat;
  sessionStorage.setItem("yoplai:desktop-setup-step", "agent");
  let checks = 0;
  overrides = (path, method) => {
    if (path === "/api/agents" && method === "POST") return response({ id: "alpha" });
    if (path.startsWith("/api/desktop-setup/turns/")) { checks += 1; return response({ state: "none" }); }
  };
  boot("/setup?restart=1");
  await heading("All your agents. One app.");
  expect(wizardExited).toBe(false);
  await modelScreen();
  await click("Continue");
  GreetingSocket.openSends = false;
  await click("Create agent");
  await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
  expect(firstChat).not.toEqual(oldChat);
  expect(completed).toBe(false);
  expect(setupWrites.at(-1)).toMatchObject({ wizardExited: true, completed: false, firstChat });
  await waitFor(() => expect(checks).toBeGreaterThan(0));
  const path = location.pathname + location.search;
  dispose?.();
  GreetingSocket.openSends = true;
  boot(path);
  await waitFor(() => expect(GreetingSocket.wires).toHaveLength(1), { timeout: 2000 });
  expect(GreetingSocket.wires[0].payload).toMatchObject({ ...firstChat, message: FIRST_GREETING });
  expect(transcript().getAllByText(FIRST_GREETING)).toHaveLength(1);
  expect(completed).toBe(false);
});

it.each(["answered", "failed"] as const)("resumes an active greeting and reloads after it is %s", async (outcome) => {
  enableGreetingSocket();
  wizardExited = true; firstChat = oldChat;
  let turn = "running";
  let checks = 0;
  overrides = (path) => {
    if (path === "/api/desktop-setup/turns/alpha/old-session/old-turn") { checks++; return response({ state: turn }); }
    if (path.endsWith("/history")) return response(turn === "running" ? {
      messages: [message("assistant", unrelatedAnswer, 0)], isStreaming: true, activeTurn: activeGreeting,
    } : { messages: [message("user", FIRST_GREETING, 1), ...(turn === "answered" ? [message("assistant", answer, 3)] : [])] });
  };
  const path = "/chat/alpha?session=old-session";
  boot(path);
  await waitFor(() => expect(transcript().getAllByText(FIRST_GREETING)).toHaveLength(1));
  expect(transcript().getByText(unrelatedAnswer)).toBeDefined();
  await waitFor(() => expect(checks).toBeGreaterThan(0));
  expect(completed).toBe(false);
  expect(GreetingSocket.wires).toHaveLength(0);
  turn = outcome;
  dispose?.();
  boot(path);
  await waitFor(() => expect(transcript().getAllByText(FIRST_GREETING)).toHaveLength(1));
  if (outcome === "answered") {
    expect(transcript().getAllByText(answer)).toHaveLength(1);
    await waitFor(() => expect(completed).toBe(true));
  } else {
    await button("Fix model access");
    expect(completed).toBe(false);
    await click("Fix model access");
    await heading("Choose a model provider");
    expect(new URLSearchParams(location.search).get("return")).toBe(path);
    await click("Continue");
    await waitFor(() => expect(location.pathname + location.search).toBe(path));
    await button("Fix model access");
    await waitFor(() => expect(transcript().getAllByText(FIRST_GREETING)).toHaveLength(1));
  }
  expect(GreetingSocket.wires).toHaveLength(0);
});

it.each([false, true])("stops the old turn after a completion conflict (refresh fails: %s)", async (refreshFails) => {
  enableGreetingSocket();
  wizardExited = true; firstChat = oldChat;
  const conflict = holdReply();
  const refresh = holdReply();
  const writes: unknown[] = [];
  const oldTurnPath = "/api/desktop-setup/turns/alpha/old-session/old-turn";
  let oldChecks = 0;
  overrides = (path, method, body) => {
    if (path === oldTurnPath) { oldChecks++; return response({ state: "answered" }); }
    if (path === "/api/desktop-setup" && method === "PUT") { writes.push(body); return conflict.pending; }
    if (path === "/api/desktop-setup" && method === "GET" && setupReads === 1) return refresh.pending;
    if (path.endsWith("/history")) return response({ messages: [message("user", FIRST_GREETING, 1), message("assistant", answer, 3)] });
  };
  boot("/chat/alpha?session=old-session");
  await waitFor(() => expect(writes).toEqual([{ completed: true, firstChat: oldChat }]));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    conflict.reply(response({ error: "turn_conflict" }, 409));
    await vi.advanceTimersByTimeAsync(0);
    expect(setupReads).toBe(2);
    const nextChat = { ...oldChat, sessionId: "new-session", turnId: "new-turn" };
    refresh.reply(refreshFails ? response({}, 500) : response({ wizardExited: true, firstChat: nextChat, completed: false }));
    await vi.advanceTimersByTimeAsync(1500);
    if (refreshFails) {
      expect(within(root).getAllByRole("alert").map((alert) => alert.textContent)).toContain("Yoplai could not refresh the setup state.");
      fireEvent.click(getByRole(root, "button", { name: "Retry setup refresh" }));
      await vi.advanceTimersByTimeAsync(1500);
      expect(setupReads).toBe(3);
      expect(root.textContent).not.toContain("Yoplai could not refresh the setup state.");
    }
    expect(transcript().getByText(answer)).toBeDefined();
    expect(root.textContent).not.toContain("Yoplai could not check the first turn.");
    expect(oldChecks).toBe(1);
    expect(writes).toHaveLength(1);
    expect(GreetingSocket.wires).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not show a raw error from the tagged socket", async () => {
  enableGreetingSocket();
  wizardExited = true; firstChat = oldChat;
  let failed = false;
  overrides = (path) => {
    if (path.includes("desktop-setup/turns/")) return response({ state: failed ? "failed" : "none" });
    if (path.endsWith("/history") && failed) return response({ messages: [message("user", FIRST_GREETING, 1)] });
  };
  boot("/chat/alpha?session=old-session");
  await waitFor(() => expect(GreetingSocket.wires).toHaveLength(1), { timeout: 2000 });
  failed = true;
  GreetingSocket.wires[0].socket.receive({ type: "error", message: "Private provider error fixture" });
  await button("Fix model access");
  expect(root.textContent).toContain("Yoplai could not complete the first turn.");
  expect(root.textContent).not.toContain("Private provider error fixture");
  expect(transcript().getAllByText(FIRST_GREETING)).toHaveLength(1);
  expect(completed).toBe(false);
});

it("retries a failed first greeting with a fresh turn in the same session, and a reload never resends", async () => {
  enableGreetingSocket();
  wizardExited = true; firstChat = oldChat;
  let answeredTurn: unknown = null;
  let repaired = false;
  overrides = (path, method, body) => {
    const turn = path.match(/desktop-setup\/turns\/alpha\/old-session\/(.+)$/)?.[1];
    if (turn) return response({ state: turn === oldChat.turnId ? "failed" : turn === answeredTurn ? "answered" : "none" });
    if (path === "/api/desktop-setup" && method === "PUT" && body.firstChat) {
      const next = body.firstChat as typeof firstChat;
      if (body.completed ? next?.turnId !== answeredTurn : body.retryOf !== oldChat.turnId || !repaired) {
        return response({ error: body.completed ? "turn_conflict" : "retry_conflict" }, 409);
      }
    }
    if (path.endsWith("/api-key") && method === "POST") {
      repaired = body.key === "fake-replacement-key";
      return response({ saved: true });
    }
    if (path.endsWith("/history")) return response({ messages: [message("user", FIRST_GREETING, 1)] });
  };
  const path = "/chat/alpha?session=old-session";
  boot(path);
  await button("Fix model access");
  expect(GreetingSocket.wires).toHaveLength(0);
  dispose?.();
  boot(path);
  await button("Try again");
  expect(GreetingSocket.wires).toHaveLength(0);
  await click("Fix model access");
  await heading("Choose a model provider");
  await click("Add a key");
  const form = await findByRole(root, "form", { name: "Add an API key" });
  await click("Provider: Select a provider", form);
  fireEvent.click(within(form).getByRole("option", { name: "OpenAI" }));
  fireEvent.input(within(form).getByLabelText("API key"), { target: { value: "fake-replacement-key" } });
  await click("Save key", form);
  await waitFor(() => expect(repaired).toBe(true));
  await click("Continue");
  await waitFor(() => expect(location.pathname + location.search).toBe(path));
  expect(GreetingSocket.wires).toHaveLength(0);
  await click("Try again");
  await waitFor(() => expect(GreetingSocket.wires).toHaveLength(1), { timeout: 2000 });
  expect(firstChat).toMatchObject({ agentId: "alpha", sessionId: "old-session" });
  expect(firstChat?.turnId).not.toBe("old-turn");
  const { payload, socket } = GreetingSocket.wires[0];
  expect(payload).toMatchObject({ ...firstChat, message: FIRST_GREETING });
  expect(setupWrites).toContainEqual({ firstChat, retryOf: oldChat.turnId });
  expect(completed).toBe(false);
  answeredTurn = payload.turnId;
  socket.receive({ type: "done", response: answer });
  await waitFor(() => expect(completed).toBe(true), { timeout: 2000 });
  expect(setupWrites.at(-1)).toEqual({ completed: true, firstChat: { ...oldChat, turnId: answeredTurn } });
  expect(GreetingSocket.wires).toHaveLength(1);
});

it("resends an unclaimed greeting with its original ID after a connection error", async () => {
  enableGreetingSocket();
  GreetingSocket.failConnect = true;
  wizardExited = true; firstChat = oldChat;
  overrides = (path, method, body) => {
    if (path.includes("desktop-setup/turns/")) return response({ state: "none" });
    if (path === "/api/desktop-setup" && method === "PUT" && body.retryOf) {
      return response({ error: "retry_conflict" }, 409);
    }
  };
  boot("/chat/alpha?session=old-session");
  await findByRole(root, "button", { name: "Try again" }, { timeout: 3000 });
  expect(GreetingSocket.wires).toHaveLength(0);
  GreetingSocket.failConnect = false;
  await click("Try again");
  await waitFor(() => expect(GreetingSocket.wires).toHaveLength(1), { timeout: 2000 });
  expect(GreetingSocket.wires[0].payload).toMatchObject({ ...oldChat, message: FIRST_GREETING });
  expect(firstChat).toEqual(oldChat);
  expect(setupWrites).toHaveLength(0);
});

it("does not resend a superseded greeting when the setup refresh fails", async () => {
  enableGreetingSocket();
  GreetingSocket.failConnect = true;
  wizardExited = true; firstChat = oldChat;
  overrides = (path, method) => {
    if (path.includes("desktop-setup/turns/")) return response({ state: "none" });
    if (path === "/api/desktop-setup" && method === "GET" && setupReads > 0) return response({ error: "boom" }, 500);
  };
  boot("/chat/alpha?session=old-session");
  await findByRole(root, "button", { name: "Try again" }, { timeout: 3000 });
  GreetingSocket.failConnect = false;
  firstChat = { ...oldChat, turnId: "other-turn" };
  await click("Try again");
  await findByRole(root, "button", { name: "Retry setup refresh" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(GreetingSocket.wires).toHaveLength(0);
});

it("does not retry when the failed first chat is no longer current", async () => {
  enableGreetingSocket();
  wizardExited = true; firstChat = oldChat;
  overrides = (path, method) => {
    if (path.includes("desktop-setup/turns/")) return response({ state: "failed" });
    if (path === "/api/desktop-setup" && method === "GET" && setupReads > 1) return response({ wizardExited: true, firstChat: { ...oldChat, turnId: "other-turn" }, completed: false });
    if (path.endsWith("/history")) return response({ messages: [message("user", FIRST_GREETING, 1)] });
  };
  boot("/chat/alpha?session=old-session");
  const retry = await button("Try again") as HTMLButtonElement;
  firstChat = { ...oldChat, turnId: "other-turn" };
  fireEvent.click(retry);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(GreetingSocket.wires).toHaveLength(0);
  expect(setupWrites.filter((write) => (write as { firstChat?: { turnId: string } }).firstChat?.turnId !== "other-turn")).toHaveLength(0);
});

it("lists missing local items, and keeps the bar closed until a new app start", async () => {
  wizardExited = true;
  overrides = (path) => {
    if (path === "/api/model-access/models") return response({ models: [] });
    if (path === "/api/agents") return response([{ id: "alpha@relay", name: "Remote Alpha", gateway: "relay" }]);
  };
  boot("/agents?filter=local");
  const bar = () => findByRole(root, "complementary", { name: "Missing setup items" });
  const scope = within(await bar());
  for (const [name, step] of [["Model access", "model"], ["First agent", "agent"]]) {
    const link = await scope.findByRole("link", { name }) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get("step")).toBe(step);
    expect(new URL(link.href).searchParams.get("return")).toBe("/agents?filter=local");
  }
  await click("Close missing setup items");
  dispose?.();
  boot("/agents?filter=local");
  await waitFor(() => expect(setupReads).toBe(2));
  expect(queryByRole(root, "complementary", { name: "Missing setup items" })).toBeNull();
  dispose?.();
  sessionStorage.clear();
  boot("/agents?filter=local");
  await bar();
});

it("keeps the desktop setup links on a page without a sidebar", async () => {
  const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Electron/45");
  try {
    wizardExited = true;
    overrides = (path) => path === "/api/model-access/models" ? response({ models: [] }) : undefined;
    boot("/gateway-link");
    await heading("Link a device");
    expect(queryByRole(root, "navigation", { name: "Primary" })).toBeNull();
    const items = await findByRole(root, "complementary", { name: "Missing setup items" });
    for (const [name, step] of [["Model access", "model"], ["First agent", "agent"]]) {
      const link = await within(items).findByRole("link", { name }) as HTMLAnchorElement;
      const params = new URL(link.href).searchParams;
      expect(params.get("step")).toBe(step);
      expect(params.get("return")).toBe("/gateway-link");
    }
    await click("Close missing setup items", items);
    await heading("Link a device");
    expect(queryByRole(root, "complementary", { name: "Missing setup items" })).toBeNull();
  } finally {
    userAgent.mockRestore();
  }
});

it.each([true, false])("shows the empty list action only in desktop mode (%s)", async (flag) => {
  mode = flag; wizardExited = true;
  if (flag) overrides = (path, method) => path === "/api/agents" && method === "POST" ? response({ id: "alpha" }) : undefined;
  boot("/agents");
  if (flag) {
    await heading("Create your first agent");
    await click("Create agent");
    await heading("Create your first agent.");
    expect(new URLSearchParams(location.search).get("return")).toBe("/agents");
    await click("Create agent");
    await waitFor(() => expect(location.pathname).toBe("/chat/alpha"));
    expect(new URLSearchParams(location.search).get("session")).toBe(firstChat?.sessionId);
  } else {
    await heading("Agents");
    expect(queryByRole(root, "heading", { name: "Create your first agent" })).toBeNull();
  }
});

it("offers model repair for an agent whose exact model is missing", async () => {
  wizardExited = true;
  overrides = (path) => path === "/api/model-access/models" ? response({ models: [models[1]] }) : undefined;
  boot("/chat/alpha?session=unrelated");
  await click("Fix model access");
  await heading("Choose a model provider");
  expect(new URLSearchParams(location.search).get("return")).toBe("/chat/alpha?session=unrelated");
});

it.each(["//elsewhere.test/", "/\\elsewhere.test/", "https://elsewhere.test/", "/.//elsewhere.test/"])("refuses the repair return %s", async (path) => {
  wizardExited = true;
  boot(`/setup?${new URLSearchParams({ step: "model", return: path })}`);
  await click("Continue");
  await heading("Create your first agent.");
  expect(location.pathname).toBe("/setup");
});
