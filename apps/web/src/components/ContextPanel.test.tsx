// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ContextPanel } from "./ContextPanel";
import * as api from "../api";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("../api", () => ({
  fetchAgents: vi.fn(async () => []),
  fetchAllSubagents: vi.fn(async () => ({ items: [] })),
  fetchProjects: vi.fn(async () => [
    {
      id: "PRO-1",
      title: "Alpha",
      path: "/tmp/PRO-1",
      absolutePath: "/tmp/PRO-1",
      repoValid: true,
      frontmatter: {},
    },
  ]),
}));

vi.mock("../lib/capabilities", () => ({
  isExtensionEnabled: () => true,
}));

vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => null }));
vi.mock("./AgentChat", () => ({ AgentChat: () => null }));
vi.mock("./AgentDirectory", () => ({ AgentDirectory: () => null }));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({ pathname: "/projects/PRO-1" }),
}));

describe("ContextPanel", () => {
  it("renders recent projects at the bottom", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "agents");
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([{ id: "PRO-1", viewedAt: Date.now() }])
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(container.querySelector(".panel-recent-label")?.textContent).toBe(
      "Recent"
    );
    expect(
      (container.querySelector(".recent-project-link") as HTMLAnchorElement)
        ?.getAttribute("href")
    ).toBe("/projects/PRO-1");

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
    localStorage.removeItem("yoplai:recent-project-views");
  });

  it("persists recent project titles across refresh", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([]);
    localStorage.setItem("yoplai:context-panel:mode", "agents");
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([
        { id: "PRO-1", title: "Alpha", viewedAt: Date.now() - 1_000 },
      ])
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(container.textContent).toContain("PRO-1: Alpha");

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
    localStorage.removeItem("yoplai:recent-project-views");
  });

  it("backfills stored recent project titles from project data", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([
      {
        id: "PRO-1",
        title: "Alpha",
        path: "/tmp/PRO-1",
        absolutePath: "/tmp/PRO-1",
        repoValid: true,
        frontmatter: {},
      },
    ]);
    localStorage.setItem("yoplai:context-panel:mode", "agents");
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([{ id: "PRO-1", viewedAt: Date.now() - 1_000 }])
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(container.textContent).toContain("PRO-1: Alpha");
    expect(localStorage.getItem("yoplai:recent-project-views")).toContain(
      "\"title\":\"Alpha\""
    );

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
    localStorage.removeItem("yoplai:recent-project-views");
  });

  it("hides recent projects outside the Agents tab", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "chat");
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([{ id: "PRO-1", viewedAt: Date.now() }])
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(container.querySelector(".panel-recent")).toBeNull();

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
    localStorage.removeItem("yoplai:recent-project-views");
  });

  it("does not force-switch back to chat when reopening Agents for the same selection", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "chat");
    const [selectedAgent] = createSignal("lead-1");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={selectedAgent}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    const agentsTab = Array.from(
      container.querySelectorAll(".panel-tabs button")
    ).find((button) => button.textContent === "Agents") as HTMLButtonElement;
    agentsTab.click();
    await Promise.resolve();

    expect(agentsTab.classList.contains("active")).toBe(true);
    expect(container.querySelector(".panel-recent")).not.toBeNull();

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
  });

  it("adopts panel mode and recent projects stored under the legacy aihub keys", async () => {
    localStorage.clear();
    localStorage.setItem("aihub:context-panel:mode", "agents");
    localStorage.setItem(
      "aihub:recent-project-views",
      JSON.stringify([{ id: "PRO-1", viewedAt: Date.now() }])
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(
      (container.querySelector(".recent-project-link") as HTMLAnchorElement)
        ?.getAttribute("href")
    ).toBe("/projects/PRO-1");
    expect(localStorage.getItem("yoplai:context-panel:mode")).toBe("agents");
    expect(localStorage.getItem("yoplai:recent-project-views")).toContain(
      "PRO-1"
    );

    dispose();
    localStorage.clear();
  });

  it("keeps the new panel mode when a legacy value also exists", async () => {
    localStorage.clear();
    localStorage.setItem("yoplai:context-panel:mode", "chat");
    localStorage.setItem("aihub:context-panel:mode", "agents");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          selectedAgent={() => null}
          onSelectAgent={() => {}}
          onClearSelection={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    const activeTab = Array.from(
      container.querySelectorAll(".panel-tabs button")
    ).find((button) => button.classList.contains("active"));
    expect(activeTab?.textContent).toBe("Chat");

    dispose();
    localStorage.clear();
  });
});
