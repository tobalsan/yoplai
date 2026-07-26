// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { BoardView } from "./BoardView";

const [pathSignal, setPathSignal] = createSignal("/");
const locationProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      if (key === "pathname") return pathSignal();
      return undefined;
    },
  }
) as { pathname: string };

const {
  fetchAgentsMock,
  fetchFullHistoryMock,
  fetchBoardProjectsMock,
  fetchAreaSummariesMock,
  getSessionKeyMock,
  streamMessageMock,
  subscribeToSessionMock,
  subscribeToFileChangesMock,
  subscribeToSubagentChangesMock,
  subscribeToRealtimeMock,
  uploadFilesMock,
} = vi.hoisted(() => ({
  fetchAgentsMock: vi.fn(),
  fetchFullHistoryMock: vi.fn(),
  fetchBoardProjectsMock: vi.fn(),
  fetchAreaSummariesMock: vi.fn(),
  getSessionKeyMock: vi.fn(),
  streamMessageMock: vi.fn(),
  subscribeToSessionMock: vi.fn(),
  subscribeToFileChangesMock: vi.fn(),
  subscribeToSubagentChangesMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(),
  uploadFilesMock: vi.fn(),
}));

vi.mock("@solidjs/router", () => ({
  useLocation: () => locationProxy,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [{}, vi.fn()],
}));

vi.mock("./board/BoardLifecycleListPage", () => ({
  BoardLifecycleListPage: () => <div data-testid="projects" />,
}));

vi.mock("./board/BoardProjectDetailPage", () => ({
  BoardProjectDetailPage: () => <div data-testid="project-detail" />,
}));

vi.mock("./ScratchpadEditor", () => ({
  ScratchpadEditor: () => <div data-testid="scratchpad" />,
}));

vi.mock("../api", async () => {
  const actualAgents =
    await vi.importActual<typeof import("../api/agents")>("../api/agents");
  return {
    fetchAgents: fetchAgentsMock,
    fetchAreaSummaries: fetchAreaSummariesMock,
    fetchBoardProjects: fetchBoardProjectsMock,
    fetchFullHistory: fetchFullHistoryMock,
    getSessionKey: getSessionKeyMock,
    postAbort: vi.fn(),
    selectDefaultProjectManagerAgent:
      actualAgents.selectDefaultProjectManagerAgent,
    streamMessage: streamMessageMock,
    subscribeToFileChanges: subscribeToFileChangesMock,
    subscribeToRealtime: subscribeToRealtimeMock,
    subscribeToSession: subscribeToSessionMock,
    subscribeToSubagentChanges: subscribeToSubagentChangesMock,
    uploadFiles: uploadFilesMock,
  };
});

vi.mock("../api/agents", () => ({
  fetchFullHistory: fetchFullHistoryMock,
}));

vi.mock("../api/chat", () => ({
  getSessionKey: getSessionKeyMock,
  postAbort: vi.fn(),
  streamMessage: streamMessageMock,
}));

vi.mock("../api/media", () => ({
  uploadFiles: uploadFilesMock,
}));

vi.mock("../api/realtime", () => ({
  subscribeToSession: subscribeToSessionMock,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function agents() {
  return [
    {
      id: "alpha",
      name: "Alpha",
      model: { provider: "openai", model: "gpt-5" },
      queueMode: "queue",
    },
    {
      id: "pom",
      name: "Pom",
      model: { provider: "openai", model: "gpt-5" },
      queueMode: "queue",
      isDefaultProjectManager: true,
    },
  ];
}

function renderView() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(() => <BoardView />, container);
  return { container, dispose };
}

describe("BoardView default project manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setPathSignal("/");
    delegateEvents(["change", "click", "input", "keydown"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ panel: "overview" })))
    );
    fetchAgentsMock.mockResolvedValue(agents());
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    fetchBoardProjectsMock.mockResolvedValue([]);
    fetchAreaSummariesMock.mockResolvedValue([]);
    getSessionKeyMock.mockReturnValue("main");
    streamMessageMock.mockImplementation(() => () => {});
    subscribeToSessionMock.mockImplementation(() => () => {});
    subscribeToFileChangesMock.mockReturnValue(() => {});
    subscribeToSubagentChangesMock.mockReturnValue(() => {});
    subscribeToRealtimeMock.mockReturnValue(() => {});
    uploadFilesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps a valid localStorage preference over the configured default", async () => {
    localStorage.setItem("yoplai:board:selected-agent", "alpha");
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(
      container.querySelector<HTMLSelectElement>(".board-agent-select")?.value
    ).toBe("alpha");

    dispose();
  });

  it("adopts a selection stored under the legacy aihub key", async () => {
    localStorage.setItem("aihub:board:selected-agent", "alpha");
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(
      container.querySelector<HTMLSelectElement>(".board-agent-select")?.value
    ).toBe("alpha");
    expect(localStorage.getItem("yoplai:board:selected-agent")).toBe("alpha");

    dispose();
  });

  it("keeps the new-key selection when a legacy key also exists", async () => {
    localStorage.setItem("yoplai:board:selected-agent", "pom");
    localStorage.setItem("aihub:board:selected-agent", "alpha");
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(
      container.querySelector<HTMLSelectElement>(".board-agent-select")?.value
    ).toBe("pom");

    dispose();
  });

  it("uses the configured default project manager without localStorage", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(
      container.querySelector<HTMLSelectElement>(".board-agent-select")?.value
    ).toBe("pom");

    dispose();
  });

  it("falls back to the first agent when no configured default is marked", async () => {
    fetchAgentsMock.mockResolvedValue(
      agents().map(({ isDefaultProjectManager: _unused, ...agent }) => agent)
    );
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(
      container.querySelector<HTMLSelectElement>(".board-agent-select")?.value
    ).toBe("alpha");

    dispose();
  });
});
