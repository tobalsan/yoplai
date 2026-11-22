// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const fetchAgentModels = vi.fn();
const createAgent = vi.fn();
vi.mock("../../api/agent-config", () => ({
  fetchAgentModels: (...args: unknown[]) => fetchAgentModels(...args),
  createAgent: (...args: unknown[]) => createAgent(...args),
}));

import { CreateAgentModal } from "./CreateAgentModal";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const dispose = render(
    () => <CreateAgentModal onClose={onClose} onCreated={onCreated} />,
    container
  );
  const type = (el: Element, value: string) => {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const create = () =>
    Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Create agent")
    )!;
  return { dispose, onClose, onCreated, type, create };
}

describe("CreateAgentModal", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("creates an agent with the chosen model", async () => {
    fetchAgentModels.mockResolvedValue([
      { provider: "openai", model: "gpt-4.1-mini", name: "GPT 4.1 Mini", source: "environment", ready: true },
    ]);
    createAgent.mockResolvedValue({ id: "helper", instructions: "template" });
    const { dispose, type, create, onClose, onCreated } = setup();
    await tick();
    type(document.querySelector("input")!, "Helper");
    create().click();
    await tick();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Helper",
        avatar: 1,
        model: { provider: "openai", model: "gpt-4.1-mini" },
        requestId: expect.any(String),
      })
    );
    expect(onCreated).toHaveBeenCalledWith("helper");
    expect(onClose).toHaveBeenCalled();
    dispose();
  });

  it("shows an error and keeps the modal open when creation fails", async () => {
    fetchAgentModels.mockResolvedValue([
      { provider: "openai", model: "gpt-4.1-mini" },
    ]);
    createAgent.mockRejectedValue(new Error("nope"));
    const { dispose, type, create, onClose } = setup();
    await tick();
    type(document.querySelector("input")!, "Helper");
    create().click();
    await tick();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not create"
    );
    expect(onClose).not.toHaveBeenCalled();
    dispose();
  });
});
