// @vitest-environment jsdom
import { within } from "@testing-library/dom";
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

vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => <div>Activity feed</div> }));
vi.mock("./AgentDirectory", () => ({ AgentDirectory: () => null }));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({ pathname: "/projects/PRO-1" }),
}));

describe("ContextPanel", () => {
  it.each(["chat", "unknown"])("opens saved %s mode on Agents with recent project links", async (mode) => {
    localStorage.clear();
    localStorage.setItem("yoplai:context-panel:mode", mode);
    localStorage.setItem(
      "yoplai:recent-project-views",
      JSON.stringify([{ id: "PRO-1", title: "Alpha", viewedAt: Date.now() }])
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => (
      <ContextPanel
        collapsed={() => false}
        onToggleCollapse={() => {}}
        onSelectAgent={() => {}}
        onOpenProject={() => {}}
      />
    ), container);
    await flushAsync();

    expect(within(container).queryByRole("button", { name: "Chat" })).toBeNull();
    expect(within(container).getByRole("link", { name: /PRO-1: Alpha/ }).getAttribute("href")).toBe("/projects/PRO-1");

    dispose();
    container.remove();
    localStorage.clear();
  });
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
          onSelectAgent={() => {}}
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
          onSelectAgent={() => {}}
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
          onSelectAgent={() => {}}
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

  it("restores Feed mode without recent project links", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "feed");
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
          onSelectAgent={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(within(container).queryByRole("link", { name: /PRO-1/ })).toBeNull();
    expect(within(container).getByText("Activity feed")).toBeTruthy();

    dispose();
    localStorage.removeItem("yoplai:context-panel:mode");
    localStorage.removeItem("yoplai:recent-project-views");
  });

  it("restores Agents mode with recent project links", async () => {
    localStorage.clear();
    localStorage.setItem("yoplai:context-panel:mode", "agents");
    localStorage.setItem("yoplai:recent-project-views", JSON.stringify([
      { id: "PRO-1", title: "Alpha", viewedAt: Date.now() },
    ]));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => (
      <ContextPanel
        collapsed={() => false}
        onToggleCollapse={() => {}}
        onSelectAgent={() => {}}
        onOpenProject={() => {}}
      />
    ), container);
    await flushAsync();

    expect(within(container).getByRole("link", { name: /PRO-1: Alpha/ })).toBeTruthy();

    dispose();
    container.remove();
    localStorage.clear();
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
          onSelectAgent={() => {}}
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
    localStorage.setItem("yoplai:context-panel:mode", "feed");
    localStorage.setItem("aihub:context-panel:mode", "agents");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ContextPanel
          collapsed={() => false}
          onToggleCollapse={() => {}}
          onSelectAgent={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await flushAsync();

    expect(within(container).getByText("Activity feed")).toBeTruthy();

    dispose();
    localStorage.clear();
  });
});
