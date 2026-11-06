import { describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@yoplai/shared";
import type { OrchestratorConfig } from "./config.js";
import type { OrchestratorDispatcherDeps } from "./dispatcher.js";
import { startOrchestratorDaemon } from "./index.js";

const { notify, dispatchOrchestratorTick } = vi.hoisted(() => ({
  notify: vi.fn(async () => ({ ok: true, results: [] })),
  dispatchOrchestratorTick: vi.fn(),
}));

vi.mock("@yoplai/shared", async (original) => ({
  ...await original<typeof import("@yoplai/shared")>(), notify,
}));

vi.mock("./dispatcher.js", async (original) => ({
  ...await original<typeof import("./dispatcher.js")>(), dispatchOrchestratorTick,
}));

describe("orchestrator HITL notifications", () => {
  it("forwards the root Mattermost pair and all surfaces when flushing a HITL event", async () => {
    dispatchOrchestratorTick.mockImplementation(async (
      _config: GatewayConfig,
      _orchestratorConfig: OrchestratorConfig,
      deps: OrchestratorDispatcherDeps
    ) => {
      deps.hitl?.add({
        kind: "blocked",
        projectId: "fake-project",
        sliceId: "fake-slice",
        summary: "Operator input needed",
      });
      return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
    });
    const config = GatewayConfigSchema.parse({
      agents: [],
      notifications: { channels: { ops: { mattermost: "fake-hitl-channel" } } },
      extensions: {
        projects: { orchestrator: { enabled: true, hitl_channel: "ops" } },
        mattermost: { url: "https://mattermost.example.com", token: "fake-hitl-token" },
      },
    });

    const daemon = startOrchestratorDaemon(config);
    expect(daemon).not.toBeNull();
    await daemon?.stop();

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      channel: "ops",
      surface: "all",
      mattermostUrl: "https://mattermost.example.com",
      mattermostToken: "fake-hitl-token",
      message: "HITL check-in\n\nfake-project:\n- [blocked] fake-slice: Operator input needed",
    }));
  });
});
