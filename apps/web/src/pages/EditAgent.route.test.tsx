// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import type { Agent } from "../api/types";

const { fetchAgentsMock, useSessionMock } = vi.hoisted(() => ({
  fetchAgentsMock: vi.fn(),
  useSessionMock: vi.fn(),
}));

vi.mock("../api/top-extensions", () => ({
  EMPTY_TOP_EXTENSIONS: { extensions: [], mcp: [], system: { extensions: [], mcp: [] } },
  fetchTopExtensions: vi.fn().mockResolvedValue({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } }),
}));
vi.mock("../api", () => ({
  fetchPool: vi.fn().mockResolvedValue([]),
  fetchAgents: fetchAgentsMock,
  fetchAgentDashboards: vi.fn().mockResolvedValue([]),
}));
vi.mock("../api/extensions", () => ({
  fetchAgentExtensions: vi.fn().mockResolvedValue([]),
  patchAgentExtension: vi.fn(),
  detailsPath: (agentId: string, extensionId: string) => `/agents/${agentId}/extensions/${extensionId}`,
}));
vi.mock("../api/mcp-servers", () => ({
  refreshMcpServerIcon: vi.fn(),
  refreshMcpCatalogIcon: vi.fn(),
  cachedMcpServers: () => undefined,
  mcpDisplayName: (name: string) => name,
  fetchMcpServersFast: vi.fn().mockResolvedValue({ servers: [], canConfigureTeam: true }),
  fetchMcpServer: async () => ({ servers: [] }),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  disconnectMcpServer: vi.fn(),
}));
vi.mock("../api/schedules", () => ({ fetchSchedules: vi.fn().mockResolvedValue([]), updateSchedule: vi.fn() }));
vi.mock("../api/teams", () => ({
  fetchTeams: vi.fn().mockResolvedValue([]),
  fetchForks: vi.fn().mockResolvedValue([]),
  fetchPoolActions: vi.fn().mockResolvedValue([]),
  setForkTeams: vi.fn(),
  setForkVisibility: vi.fn(),
}));
vi.mock("../auth/client", () => ({ useSession: useSessionMock }));

import { EditAgent } from "./EditAgent";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

let container: HTMLElement;
let dispose: () => void;

beforeEach(() => {
  setCapabilitiesForTests({ forkedAgents: false });
  useSessionMock.mockReturnValue(() => ({ isPending: false, data: { user: { id: "alice", role: "superadmin" } } }));
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
});

describe("EditAgent with the real router", () => {
  it("shows the remote agent at /agents/pom%40ams/edit", async () => {
    fetchAgentsMock.mockResolvedValue([{ id: "pom@ams", name: "Pom (remote)", gateway: "ams" } as Agent]);
    const history = createMemoryHistory();
    history.set({ value: "/agents/pom%40ams/edit", replace: true });
    dispose = render(
      () => (
        <MemoryRouter history={history}>
          <Route path="/agents/:agentId/edit" component={EditAgent} />
        </MemoryRouter>
      ),
      container,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toContain("Pom (remote)");
    expect(container.textContent).not.toContain("Agent not found.");
  });
});
