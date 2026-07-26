// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

async function importLayout() {
  vi.resetModules();
  return await import("./layout");
}

describe("layout persistence after the aihub -> yoplai rename", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("adopts legacy collapse and zen preferences", async () => {
    localStorage.setItem("aihub:sidebar-collapsed", "true");
    localStorage.setItem("aihub:right-panel-collapsed", "true");
    localStorage.setItem("aihub:zen-mode", "true");

    const layout = await importLayout();

    expect(layout.sidebarCollapsed()).toBe(true);
    expect(layout.rightPanelCollapsed()).toBe(true);
    expect(layout.zenMode()).toBe(true);
    expect(localStorage.getItem("yoplai:sidebar-collapsed")).toBe("true");
    expect(localStorage.getItem("yoplai:right-panel-collapsed")).toBe("true");
    expect(localStorage.getItem("yoplai:zen-mode")).toBe("true");
  });

  it("keeps the value stored under the new key", async () => {
    localStorage.setItem("yoplai:zen-mode", "false");
    localStorage.setItem("aihub:zen-mode", "true");

    const layout = await importLayout();

    expect(layout.zenMode()).toBe(false);
    expect(localStorage.getItem("yoplai:zen-mode")).toBe("false");
  });

  it("defaults to false with nothing stored", async () => {
    const layout = await importLayout();

    expect(layout.sidebarCollapsed()).toBe(false);
    expect(layout.rightPanelCollapsed()).toBe(false);
    expect(layout.zenMode()).toBe(false);
  });
});
