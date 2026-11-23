// @vitest-environment jsdom
import { findByRole, fireEvent, getByRole, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { resolveModelChoice, type Model } from "../../desktop-setup/api";
import { AgentSettingsSidebar } from "./AgentSettingsSidebar";

it("uses the shared picker and saves only the fallback provider and model", async () => {
  const model = { provider: "anthropic", model: "claude-haiku-5-5" };
  const row = { ...model, name: "Claude Haiku 5.5", credentialType: "oauth", default: true, free: false, ready: false } as const;
  const models: Model[] = [{ ...row, source: "claude-code" }, { ...row, source: "owned" }];
  const authMode = "oauth";
  const patches: unknown[] = [];
  let fallbackModel: typeof model | null = null;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/agent-management/models") return Response.json({ models });
    if (path === "/api/agents/fixture/settings" && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      fallbackModel = patch.fallbackModel;
      return Response.json({ ok: true });
    }
    if (path === "/api/agents/fixture/settings") return Response.json({
      canEditAgent: true, name: "Fixture", fallbackModel, skills: { global: [], agent: [], user: [] },
    });
    return new Response(null, { status: 404 });
  });

  const root = document.body.appendChild(document.createElement("div"));
  const mount = () => render(() => <AgentSettingsSidebar agent={{ id: "fixture", name: "Fixture", authMode }}
    onClose={() => {}} onDirty={() => {}} onSaving={() => {}} onAgentChanged={() => {}} onSaved={() => {}} />, root);
  let dispose = mount();
  try {
    fireEvent.click(await findByRole(root, "checkbox", { name: "Use a fallback model" }));
    const trigger = await findByRole(root, "button", { name: /^Fallback model:/ }) as HTMLButtonElement;
    await waitFor(() => expect(trigger.disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(getByRole(root, "tab", { name: "Claude Code" }));
    const search = getByRole(root, "combobox", { name: "Search models" });
    fireEvent.input(search, { target: { value: "haiku" } });
    fireEvent.click(getByRole(root, "option", { name: "Claude Haiku 5.5" }));
    const chosen = () => getByRole(root, "button", { name: /Fallback model: Claude Haiku 5\.5.*Claude Code/ });
    expect(chosen()).toBe(trigger);
    fireEvent.click(getByRole(root, "button", { name: "Save" }));
    await waitFor(() => expect(patches).toEqual([{ fallbackModel: model }]));
    expect(chosen()).toBe(trigger);

    dispose();
    dispose = mount();
    const resolved = resolveModelChoice(models, model, authMode);
    expect(resolved?.source).toBe("owned");
    await findByRole(root, "button", { name: /Fallback model: Claude Haiku 5\.5.*Claude · Subscription/ });
    fireEvent.click(getByRole(root, "checkbox", { name: "Use a fallback model" }));
    fireEvent.click(getByRole(root, "button", { name: "Save" }));
    await waitFor(() => expect(patches).toEqual([{ fallbackModel: model }, { fallbackModel: null }]));
  } finally {
    dispose();
    root.remove();
    vi.unstubAllGlobals();
  }
});

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
