// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { NewAgent } from "./NewAgent";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

const model = { provider: "openai", model: "gpt-4.1-mini", name: "GPT 4.1 mini", source: "owned", default: true, ready: true, free: false };
let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let posted: Record<string, unknown> | undefined;

beforeEach(() => {
  posted = undefined;
  history.replaceState({}, "", "/agents/new");
  root = document.createElement("div");
  document.body.appendChild(root);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/model-access/models") return Response.json({ models: [model] });
    if (path === "/api/agents" && init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      return Response.json({ id: "ada" }, { status: 201 });
    }
    return Response.json({});
  }));
});
afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

function mount() {
  dispose = render(() => (
    <Router>
      <Route path="/agents/new" component={NewAgent} />
      <Route path="/agents/:agentId/edit" component={() => <p>Edit page</p>} />
    </Router>
  ), root);
}

describe("New agent", () => {
  it("says creation is off when the gateway refuses it", () => {
    setCapabilitiesForTests({ multiUser: false, agentConfig: { create: false, edit: false } });
    mount();
    expect(root.textContent).toContain("Agent creation is off on this gateway.");
    expect(root.querySelector("form")).toBeNull();
  });

  it("creates the agent and opens its edit page", async () => {
    setCapabilitiesForTests({ multiUser: false, agentConfig: { create: true, edit: true } });
    mount();
    const name = root.querySelector<HTMLInputElement>("input[required]")!;
    name.value = "Ada";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    await vi.waitFor(() => expect(location.pathname).toBe("/agents/ada/edit"));
    expect(posted).toMatchObject({ name: "Ada", model: { provider: "openai", model: "gpt-4.1-mini" }, avatar: expect.any(Number) });
    expect(String(posted?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
