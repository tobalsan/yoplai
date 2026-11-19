// @vitest-environment jsdom
import fs from "node:fs";
import { getByRole } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import { fadeInDesktopWindow } from "../../web/src/lib/desktop-window.js";

const index = fs.readFileSync("apps/web/index.html", "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.yoplaiDesktopTheme;
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-desktop-first-screen");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function loadPage(userAgent: string, reducedMotion = false, choice = "light") {
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
  localStorage.setItem("yoplai-theme", choice);
  const page = new DOMParser().parseFromString(index, "text/html");
  document.head.replaceChildren(...page.querySelectorAll("style"));
  document.body.replaceChildren(...page.body.children);
  for (const script of page.head.querySelectorAll("script:not([src])")) {
    window.eval(script.textContent!);
  }
  const root = document.getElementById("root")!;
  const animation = Promise.withResolvers<void>();
  root.animate = vi.fn().mockReturnValue({ finished: animation.promise });
  Object.defineProperty(root, "innerText", { get: () => root.textContent });
  return { root, animation };
}

function renderScreen(root: HTMLElement) {
  const heading = document.createElement("h1");
  heading.textContent = "Welcome to Yoplai";
  root.append(heading);
  expect(getByRole(root, "heading", { name: "Welcome to Yoplai" })).toBeTruthy();
}

it.each([
  ["light", "rgb(255, 255, 255)"],
  ["dark", "rgb(0, 0, 0)"],
])("keeps the %s backdrop until the first screen fades in", async (choice, backdrop) => {
  const { root, animation } = loadPage("Electron/45", false, choice);
  const background = () => window.getComputedStyle(document.body).backgroundColor;
  expect(background()).toBe(backdrop);
  fadeInDesktopWindow(root);
  root.append(document.createElement("div"));
  await Promise.resolve();
  expect(root.animate).not.toHaveBeenCalled();
  expect(background()).toBe(backdrop);

  renderScreen(root);
  await vi.waitFor(() => expect(root.animate).toHaveBeenCalledWith([
    { opacity: 0 }, { opacity: 1 },
  ], expect.objectContaining({ duration: 200 })));
  expect(background()).toBe(backdrop);
  animation.resolve();
  await animation.promise;
  expect(background()).not.toBe(backdrop);
});

it("does not fade again after a reload or menu navigation", async () => {
  const first = loadPage("Electron/45");
  fadeInDesktopWindow(first.root);
  renderScreen(first.root);
  await vi.waitFor(() => expect(first.root.animate).toHaveBeenCalledTimes(1));
  first.animation.resolve();
  await first.animation.promise;

  const next = loadPage("Electron/45");
  expect(window.getComputedStyle(document.body).backgroundColor).not.toBe("rgb(0, 0, 0)");
  fadeInDesktopWindow(next.root);
  renderScreen(next.root);
  await Promise.resolve();
  expect(next.root.animate).not.toHaveBeenCalled();
});

it.each([["Chrome/146", false], ["Electron/45", true]])(
  "does not fade with %s and reduced motion %s", async (userAgent, reducedMotion) => {
    const { root } = loadPage(userAgent, reducedMotion);
    if (!reducedMotion) expect(window.getComputedStyle(document.body).backgroundColor).not.toBe("rgb(0, 0, 0)");
    fadeInDesktopWindow(root);
    renderScreen(root);
    await Promise.resolve();
    expect(root.animate).not.toHaveBeenCalled();
    expect(window.getComputedStyle(document.body).backgroundColor).not.toBe("rgb(0, 0, 0)");
  },
);

it("uses the desktop preference before the screen paints on a new origin", () => {
  const load = vi.fn().mockReturnValue("light");
  Object.assign(window, { yoplaiDesktopTheme: { load } });
  loadPage("Electron/45", false, "dark");
  expect(load).toHaveBeenCalledWith("dark");
  expect(window.getComputedStyle(document.body).backgroundColor).toBe("rgb(255, 255, 255)");
});
