// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findByLabelText, findByRole, fireEvent, getByRole, queryByLabelText } from "@testing-library/dom";
import { render } from "solid-js/web";
import { AgentConfigPanel } from "./AgentConfigPanel";

const detail = { id: "helper", name: "Helper", description: "", role: "", avatar: "default-2.webp", model: { provider: "anthropic", model: "claude-haiku-5-5" }, reasoning: null, instructions: "Be kind.\n", disabledSkills: [] as string[] };
const models = [{ provider: "anthropic", model: "claude-haiku-5-5", name: "Haiku", source: "owned", default: true, ready: true }];
const skills: Array<Record<string, unknown>> = [
  { level: "gateway", name: "company-style", description: "Style", enabled: true, locked: true },
  { level: "agent", name: "triage", description: "Triage", enabled: true, locked: false },
  { level: "user", id: "u-1", name: "my-notes", description: "Notes", enabled: false, locked: false },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let container: HTMLDivElement;
let dispose: () => void;
let patches: unknown[];
let userSkillWrites: unknown[];
let canEditAgent: boolean;
beforeEach(() => {
  patches = [];
  userSkillWrites = [];
  canEditAgent = true;
  container = document.createElement("div");
  document.body.append(container);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return json({ ok: true }); }
    if (init?.method === "PUT") { userSkillWrites.push(JSON.parse(String(init.body))); return json({ ok: true }); }
    if (url.endsWith("/models")) return json({ models });
    if (url.endsWith("/skills")) return json({ canEditAgent, skills });
    return json(detail);
  }));
});
afterEach(() => { dispose?.(); container.remove(); vi.unstubAllGlobals(); });

describe("AgentConfigPanel", () => {
  it("lists gateway, workspace and user skills and saves each kind to its own place", async () => {
    dispose = render(() => <AgentConfigPanel agentId="helper" onClose={() => undefined} onSaved={() => undefined} />, container);
    const name = await findByLabelText(container, "Name") as HTMLInputElement;
    expect(name.value).toBe("Helper");
    for (const heading of ["Gateway skills", "Agent workspace skills", "Your skills"]) expect(await findByRole(container, "heading", { name: heading })).toBeTruthy();
    expect((getByRole(container, "checkbox", { name: "company-style" }) as HTMLInputElement).disabled).toBe(true);
    expect((getByRole(container, "checkbox", { name: "triage" }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole(container, "checkbox", { name: "my-notes" }) as HTMLInputElement).checked).toBe(false);
    expect(getByRole(container, "button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.input(name, { target: { value: "Helper 2" } });
    fireEvent.click(getByRole(container, "checkbox", { name: "triage" }));
    fireEvent.click(getByRole(container, "checkbox", { name: "my-notes" }));
    fireEvent.click(getByRole(container, "button", { name: "Save" }));

    await vi.waitFor(() => expect(patches).toEqual([{ name: "Helper 2", skills: { disabled: ["triage"] } }]));
    await vi.waitFor(() => expect(userSkillWrites).toEqual([{ enabled: ["u-1"] }]));
  });

  it("shows only the skills to a user who cannot edit the agent", async () => {
    canEditAgent = false;
    skills[1] = { ...skills[1], locked: true };
    dispose = render(() => <AgentConfigPanel agentId="helper" onClose={() => undefined} onSaved={() => undefined} />, container);
    fireEvent.click(await findByRole(container, "checkbox", { name: "my-notes" }));
    expect(queryByLabelText(container, "Name")).toBeNull();
    expect((getByRole(container, "checkbox", { name: "triage" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(getByRole(container, "button", { name: "Save" }));
    await vi.waitFor(() => expect(userSkillWrites).toEqual([{ enabled: ["u-1"] }]));
    expect(patches).toEqual([]);
  });

  it("tells the user when the settings cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "agent_not_found" }), { status: 404 })));
    dispose = render(() => <AgentConfigPanel agentId="helper" onClose={() => undefined} onSaved={() => undefined} />, container);
    expect(await findByRole(container, "alert")).toBeTruthy();
  });
});
