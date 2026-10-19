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
  it("exposes skill_save for every Pi run", async () => {
    const bridge = new ContainerToolBridge();
    const tools = await bridge.buildTools({ agent: { id: "cloud" } } as never, { extensions: {} } as never);
    expect(tools.map((tool) => tool.name)).toContain("skill_save");
  });
  it("exposes project memory tools only for resolved project chats", async () => {
    const bridge = new ContainerToolBridge();
    const params = { agent: { id: "cloud" } };
    const config = { agents: [params.agent], extensions: {} };
    const plain = await bridge.buildTools(params as never, config as never);
    expect(plain.map((tool) => tool.name)).not.toContain("project_references_add");
    expect(plain.map((tool) => tool.name)).not.toContain("project_notes_append");
    const project = await bridge.buildTools({ ...params, context: { kind: "web", project: { id: "research", instructions: "" } } } as never, config as never);
    expect(project.map((tool) => tool.name)).toContain("project_references_add");
    expect(project.map((tool) => tool.name)).toContain("project_notes_append");
  });
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
        canonicalName: "scratchpad.read",
        description: "Read",
        parameters: { type: "object" },
      },
      expect.objectContaining({ extensionId: "gateway", name: "extract_document" }),
      expect.objectContaining({ extensionId: "gateway", name: "skill_save" }),
    ]);
  });

  it("only exposes describe_image when the resolved agent model lacks vision", async () => {
    const bridge = new ContainerToolBridge();
    const params = { agent: { id: "cloud" } };
    const config = { agents: [params.agent], extensions: {} };
    await expect(bridge.buildTools(params as never, config as never, true)).resolves.toContainEqual(
      expect.objectContaining({ extensionId: "gateway", name: "describe_image" })
    );
    await expect(bridge.buildTools(params as never, config as never, false)).resolves.not.toContainEqual(
      expect.objectContaining({ extensionId: "gateway", name: "describe_image" })
    );
  });
});
