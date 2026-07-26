// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Area, ProjectListItem } from "../api/types";
import { AreasOverview } from "./AreasOverview";

const {
  createAreaMock,
  fetchAreasMock,
  fetchProjectsMock,
  updateAreaMock,
  navigateMock,
} = vi.hoisted(() => ({
  createAreaMock: vi.fn<(payload: Area) => Promise<Area>>(),
  fetchAreasMock: vi.fn<() => Promise<Area[]>>(),
  fetchProjectsMock: vi.fn<() => Promise<ProjectListItem[]>>(),
  updateAreaMock: vi.fn<(id: string, patch: Partial<Area>) => Promise<Area>>(),
  navigateMock: vi.fn(),
}));

vi.mock("../api", () => ({
  createArea: createAreaMock,
  fetchAreas: fetchAreasMock,
  fetchProjects: fetchProjectsMock,
  updateArea: updateAreaMock,
}));

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigateMock,
  A: (props: Record<string, unknown>) => <a {...props} />,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AreasOverview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    createAreaMock.mockReset();
    fetchAreasMock.mockReset();
    fetchProjectsMock.mockReset();
    updateAreaMock.mockReset();
    navigateMock.mockReset();
    vi.clearAllMocks();
  });

  it("creates a new area from the homepage with an id derived from title", async () => {
    fetchAreasMock.mockResolvedValue([
      { id: "yoplai", title: "Yoplai", color: "#3b82f6" },
    ]);
    fetchProjectsMock.mockResolvedValue([]);
    createAreaMock.mockImplementation(async (payload) => payload);

    const container = document.createElement("div");
    document.body.appendChild(container);

    const dispose = render(() => <AreasOverview />, container);

    await tick();
    await tick();

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Add area"
    ) as HTMLButtonElement | undefined;
    expect(openButton).toBeDefined();
    openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await tick();

    const titleInput = container.querySelector(
      '.area-create-card input[type="text"][placeholder="Yoplai"]'
    ) as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();
    titleInput!.value = "Ops Platform";
    titleInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const repoInput = container.querySelector(
      '.area-create-card input[type="text"][placeholder="~/code/repo"]'
    ) as HTMLInputElement | null;
    expect(repoInput).not.toBeNull();
    repoInput!.value = "~/code/ops";
    repoInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const colorInput = container.querySelector(
      '.area-create-card input[type="color"]'
    ) as HTMLInputElement | null;
    expect(colorInput).not.toBeNull();
    colorInput!.value = "#123456";
    colorInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const form = container.querySelector(".area-create-card") as HTMLFormElement;
    expect(form).not.toBeNull();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await tick();
    await tick();

    expect(createAreaMock).toHaveBeenCalledWith({
      id: "ops-platform",
      title: "Ops Platform",
      color: "#123456",
      repo: "~/code/ops",
    });
    expect(container.textContent).toContain("Ops Platform");

    dispose();
  });
});
