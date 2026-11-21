// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

let darkToLight: (event: { matches: boolean }) => void;
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: (_type: string, listener: typeof darkToLight) => { darkToLight = listener; },
});
localStorage.setItem("aihub-theme", "light");

const { theme, themeChoice, setThemeChoice } = await import("./theme");

function expectResolvedTheme(resolved: "light" | "dark") {
  expect(theme()).toBe(resolved);
  expect(document.documentElement.dataset.theme).toBe(resolved);
  expect(document.cookie.split("; ")).toContain(`yoplai-theme=${resolved}`);
}

describe("Theme", () => {
  it("migrates the choice and resolves System after changes to the system or another tab", () => {
    expect(themeChoice()).toBe("light");
    expect(localStorage.getItem("yoplai-theme")).toBe("light");
    expect(localStorage.getItem("aihub-theme")).toBeNull();
    expectResolvedTheme("light");

    setThemeChoice("system");
    expect(localStorage.getItem("yoplai-theme")).toBe("system");
    expectResolvedTheme("dark");
    darkToLight({ matches: true });
    expectResolvedTheme("light");
    expect(localStorage.getItem("yoplai-theme")).toBe("system");

    localStorage.setItem("yoplai-theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "yoplai-theme", newValue: "dark" }));
    expect(themeChoice()).toBe("dark");
    expectResolvedTheme("dark");
    darkToLight({ matches: false });
    darkToLight({ matches: true });
    expectResolvedTheme("dark");

    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(themeChoice()).toBe("system");
    expect(localStorage.getItem("yoplai-theme")).toBeNull();
    expectResolvedTheme("light");
  });
});
