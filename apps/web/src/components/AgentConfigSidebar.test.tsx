// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { AgentConfigSidebar } from "./AgentConfigSidebar";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let saved: Record<string, unknown> | undefined;

function stubFetch(access: { create: boolean; edit: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/agents/ada/config" && init?.method === "PATCH") {
      saved = JSON.parse(String(init.body));
      return Response.json({ id: "ada", name: "Ada", description: "", globalSkills: false, access });
    }
    if (path === "/api/agents/ada/config") {
      return Response.json({ id: "ada", name: "Ada", description: "", globalSkills: false, instructions: "Be brief.", model: { provider: null, model: "gpt-4.1-mini" }, access });
    }
    if (path === "/api/model-access/models") return Response.json({ models: [] });
    if (path === "/api/skills") return Response.json({ mine: [], sharedWithMe: [], agent: [] });
    return Response.json({});
  }));
}

beforeEach(() => {
  saved = undefined;
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
  vi.unstubAllGlobals();
});

describe("Agent config sidebar", () => {
  it("saves a changed name", async () => {
    stubFetch({ create: true, edit: true });
    dispose = render(() => <Router><Route path="/" component={() => <AgentConfigSidebar agentId="ada" />} /></Router>, root);
    const name = await vi.waitFor(() => {
      const input = root.querySelector<HTMLInputElement>("input[required]");
      expect(input?.value).toBe("Ada");
      return input!;
    });
    const save = root.querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(save.disabled).toBe(true);
    name.value = "Grace";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(save.disabled).toBe(false);
    save.click();
    await vi.waitFor(() => expect(saved).toEqual({ name: "Grace" }));
  });

  it("shows read-only fields when editing is off", async () => {
    stubFetch({ create: false, edit: false });
    dispose = render(() => <Router><Route path="/" component={() => <AgentConfigSidebar agentId="ada" />} /></Router>, root);
    await vi.waitFor(() => expect(root.textContent).toContain("Editing is off on this gateway."));
    expect(root.querySelector<HTMLInputElement>("input[required]")?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  });
});
