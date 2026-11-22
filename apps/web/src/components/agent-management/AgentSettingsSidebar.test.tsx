// @vitest-environment jsdom
import { findByRole, fireEvent, getByRole, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { AgentSettingsSidebar } from "./AgentSettingsSidebar";

it("preserves a legacy Claude choice until the user saves a source for the same model", async () => {
  const model = { provider: "anthropic", model: "claude-haiku-5-5" };
  const row = { ...model, name: "Claude Haiku 5.5", credentialType: "oauth", default: true, free: false, ready: false };
  const patches: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/agent-management/models") return Response.json({ models: [
      { ...row, source: "claude-code" }, { ...row, source: "owned" },
    ] });
    if (path === "/api/agents/fixture/settings" && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (path === "/api/agents/fixture/settings") return Response.json({
      canEditAgent: true, name: "Fixture", model, skills: { global: [], agent: [], user: [] },
    });
    return new Response(null, { status: 404 });
  });
  const root = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <AgentSettingsSidebar agent={{ id: "fixture", name: "Fixture", authMode: "oauth" }}
    onClose={() => {}} onDirty={() => {}} onSaving={() => {}} onAgentChanged={() => {}} onSaved={() => {}} />, root);
  try {
    const trigger = await findByRole(root, "button", { name: /Model: Claude Haiku 5\.5.*Claude · Subscription/ }) as HTMLButtonElement;
    const save = getByRole(root, "button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const choose = (tab: string) => {
      fireEvent.click(trigger);
      fireEvent.click(getByRole(root, "tab", { name: tab }));
      fireEvent.click(getByRole(root, "option", { name: "Claude Haiku 5.5" }));
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
    };
    choose("Claude Code");
    await waitFor(() => expect(trigger.disabled).toBe(false));
    expect(save.disabled).toBe(true);
    choose("Claude");
    await waitFor(() => expect(patches).toEqual([
      { model: { ...model, source: "claude-code" } },
      { model: { ...model, source: "owned" } },
    ]));
  } finally {
    dispose();
    root.remove();
    vi.unstubAllGlobals();
  }
});
