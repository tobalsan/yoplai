import { describe, expect, it, vi } from "vitest";
import { ContainerToolBridge } from "./tool-bridge.js";

const mockGetExtensionSystemPromptContributions = vi.hoisted(() =>
  vi.fn(async () => ["prompt"])
);
const mockGetExtensionAgentTools = vi.hoisted(() =>
  vi.fn(async () => [
    {
      extensionId: "board",
      name: "scratchpad.read",
      description: "Read",
      parameters: { type: "object" },
      execute: vi.fn(),
    },
  ])
);

vi.mock("../../extensions/prompts.js", () => ({
  getExtensionSystemPromptContributions:
    mockGetExtensionSystemPromptContributions,
}));

vi.mock("../../extensions/tools.js", () => ({
  getExtensionAgentTools: mockGetExtensionAgentTools,
}));

describe("container tool bridge", () => {
  it("serializes extension prompts and tool metadata for the container", async () => {
    const bridge = new ContainerToolBridge();
    const params = { agent: { id: "cloud" } };
    const config = { agents: [params.agent], extensions: {} };

    await expect(
      bridge.buildSystemPrompts(params as never, config as never)
    ).resolves.toEqual(["prompt"]);
    await expect(
      bridge.buildTools(params as never, config as never)
    ).resolves.toEqual([
      {
        extensionId: "board",
        name: "scratchpad.read",
        description: "Read",
        parameters: { type: "object" },
      },
      expect.objectContaining({ extensionId: "gateway", name: "extract_document" }),
    ]);
  });
});
