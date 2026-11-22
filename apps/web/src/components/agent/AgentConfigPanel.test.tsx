// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const fetchAgentConfig = vi.fn();
const fetchAgentModels = vi.fn();
const saveAgentConfig = vi.fn();
vi.mock("../../api/agent-config", () => ({
  fetchAgentConfig: (...args: unknown[]) => fetchAgentConfig(...args),
  fetchAgentModels: (...args: unknown[]) => fetchAgentModels(...args),
  saveAgentConfig: (...args: unknown[]) => saveAgentConfig(...args),
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));

import { AgentConfigPanel } from "./AgentConfigPanel";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const dispose = render(
    () => (
      <AgentConfigPanel
        agentId="helper"
        agentName="Helper"
        onClose={onClose}
        onSaved={onSaved}
      />
    ),
    container
  );
  return { dispose, onClose, onSaved };
}

describe("AgentConfigPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows core fields and saves edits", async () => {
    fetchAgentModels.mockResolvedValue([
      { provider: "openai", model: "gpt-4.1-mini" },
    ]);
    fetchAgentConfig.mockResolvedValue({
      id: "helper",
      name: "Helper",
      description: "Helps",
      avatar: null,
      model: { provider: "openai", model: "gpt-4.1-mini" },
      reasoning: null,
      queueMode: "queue",
      globalSkills: false,
      instructions: "Be helpful.\n",
      skills: [{ name: "notes", description: "Take notes" }],
      canEdit: true,
    });
    saveAgentConfig.mockResolvedValue(undefined);
    const { dispose, onSaved } = setup();
    await tick();
    expect(document.body.textContent).toContain("notes");
    expect(document.body.textContent).toContain("Take notes");
    const name = document.querySelector("input")!;
    (name as HTMLInputElement).value = "Helper 2";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Save config"))!
      .click();
    await tick();
    expect(saveAgentConfig).toHaveBeenCalledWith(
      "helper",
      expect.objectContaining({ name: "Helper 2" })
    );
    expect(onSaved).toHaveBeenCalled();
    dispose();
  });

  it("shows a read-only notice when the user cannot edit", async () => {
    fetchAgentModels.mockResolvedValue([]);
    fetchAgentConfig.mockResolvedValue({
      id: "helper",
      name: "Helper",
      description: null,
      avatar: null,
      model: null,
      reasoning: null,
      queueMode: "queue",
      globalSkills: false,
      instructions: "",
      skills: [],
      canEdit: false,
    });
    const { dispose } = setup();
    await tick();
    expect(document.body.textContent).toContain("You can view this config");
    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Save config")
      )
    ).toBe(false);
    dispose();
  });
});
