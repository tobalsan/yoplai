import fs from "node:fs";
import { getByRole, queryByRole } from "@testing-library/dom";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";

const html = fs.readFileSync(new URL("splash.html", import.meta.url), "utf8");

function openSplash(mode: "splash" | "wait", reducedMotion = false) {
  const queue: FrameRequestCallback[] = [];
  const fade = Promise.withResolvers<void>();
  const animate = vi.fn(() => ({ finished: fade.promise }));
  const dom = new JSDOM(html, {
    url: `file:///splash.html?mode=${mode}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: reducedMotion });
      window.requestAnimationFrame = (callback: FrameRequestCallback) => queue.push(callback);
      window.Path2D = class {
        moveTo() {}
        lineTo() {}
        closePath() {}
        arc() {}
      };
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
      window.HTMLElement.prototype.animate = animate;
    },
  });
  return {
    page: dom.window.document.body,
    finish: (): Promise<void> => dom.window.yoplaiSplash.finish(),
    frame: (now: number) => queue.shift()?.(now),
    queued: () => queue.length,
    animate,
    finishFade: fade.resolve,
    close: () => dom.window.close(),
  };
}

it("waits for the animation and the 200 ms fade when the stack is ready first", async () => {
  const splash = openSplash("splash");
  try {
    const finished = vi.fn();
    const result = splash.finish().then(finished);
    splash.frame(0);
    splash.frame(7400);
    await Promise.resolve();
    expect(splash.animate).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    splash.frame(7454);
    await Promise.resolve();
    expect(splash.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.objectContaining({ duration: 200 }));
    expect(finished).not.toHaveBeenCalled();
    splash.finishFade();
    await result;
    expect(finished).toHaveBeenCalledTimes(1);
  } finally {
    splash.close();
  }
});

it("shows the loading mark if the animation ends first", () => {
  const splash = openSplash("splash");
  try {
    expect(queryByRole(splash.page, "status", { name: "Loading" })).toBeNull();
    splash.frame(0);
    splash.frame(7454);
    expect(getByRole(splash.page, "status", { name: "Loading" })).toBeTruthy();
    expect(getByRole(splash.page, "img", { name: "YOPLAI." })).toBeTruthy();
  } finally {
    splash.close();
  }
});

it.each([["wait", false], ["splash", true]] as const)("starts without motion in %s mode with reduced motion %s", async (mode, reducedMotion) => {
  const splash = openSplash(mode, reducedMotion);
  try {
    expect(splash.queued()).toBe(0);
    expect(getByRole(splash.page, "status", { name: "Loading" })).toBeTruthy();
    expect(Boolean(queryByRole(splash.page, "img", { name: "YOPLAI." }))).toBe(reducedMotion);
    const finished = vi.fn();
    const result = splash.finish().then(finished);
    await Promise.resolve();
    expect(splash.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.objectContaining({ duration: 200 }));
    expect(finished).not.toHaveBeenCalled();
    splash.finishFade();
    await result;
    expect(finished).toHaveBeenCalledTimes(1);
  } finally {
    splash.close();
  }
});
