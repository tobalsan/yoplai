import fs from "node:fs";
import { getByRole, queryByRole } from "@testing-library/dom";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";

const html = fs.readFileSync(new URL("splash.html", import.meta.url), "utf8");

function openSplash(mode: "splash" | "wait", reducedMotion = false) {
  const queue = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let changeMotion = (_matches: boolean) => {};
  const fade = Promise.withResolvers<void>();
  const animate = vi.fn(() => ({ finished: fade.promise }));
  const getAnimations = vi.fn(() => [{ finished: fade.promise }]);
  const dom = new JSDOM(html, {
    url: `file:///splash.html?mode=${mode}`,
    runScripts: "dangerously",
    beforeParse(window) {
      const motion = Object.assign(new window.EventTarget(), { matches: reducedMotion });
      changeMotion = (matches) => {
        motion.matches = matches;
        motion.dispatchEvent(new window.Event("change"));
      };
      window.matchMedia = (query: string) => query.includes("reduced-motion")
        ? motion
        : { matches: false, addEventListener: vi.fn() };
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        queue.set(++frameId, callback);
        return frameId;
      };
      window.cancelAnimationFrame = (id: number) => queue.delete(id);
      window.HTMLElement.prototype.getAnimations = getAnimations;
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
    frame: (now: number) => {
      const [entry] = queue;
      if (entry) {
        const [id, callback] = entry;
        queue.delete(id);
        callback(now);
      }
    },
    queued: () => queue.size,
    changeMotion,
    animate,
    getAnimations,
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

it("shows the splash without motion but keeps the 200 ms fade", async () => {
  const splash = openSplash("splash", true);
  try {
    expect(splash.queued()).toBe(0);
    expect(getByRole(splash.page, "status", { name: "Loading" })).toBeTruthy();
    expect(getByRole(splash.page, "img", { name: "YOPLAI." })).toBeTruthy();
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

it("reveals the loader at 250 ms and waits for its exit", async () => {
  vi.useFakeTimers();
  const splash = openSplash("wait");
  try {
    const loader = getByRole(splash.page, "status", { name: "Loading" });
    expect(queryByRole(splash.page, "img", { name: "YOPLAI." })).toBeNull();
    vi.advanceTimersByTime(249);
    expect(loader.classList.contains("revealed")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(loader.classList.contains("revealed")).toBe(true);
    const finished = vi.fn();
    const result = splash.finish();
    void result.then(finished);
    expect(splash.finish()).toBe(result);
    expect(splash.getAnimations).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    splash.finishFade();
    await result;
    expect(loader.hidden).toBe(true);
  } finally {
    splash.close();
    vi.useRealTimers();
  }
});

it("stops the roll and hides without a shrink when the user enables reduced motion", async () => {
  vi.useFakeTimers();
  const splash = openSplash("wait");
  try {
    vi.advanceTimersByTime(250);
    const loader = getByRole(splash.page, "status", { name: "Loading" });
    const track = loader.querySelector<HTMLElement>(".track")!;
    for (let now = 0; now <= 4500; now += 16) splash.frame(now);
    expect(track.style.transform).toMatch(/^translateX\(/);
    splash.changeMotion(true);
    expect(splash.queued()).toBe(0);
    expect(track.style.transform).toBe("");
    splash.frame(4600);
    expect(track.style.transform).toBe("");
    await splash.finish();
    expect(loader.hidden).toBe(true);
    expect(splash.getAnimations).not.toHaveBeenCalled();
  } finally {
    splash.close();
    vi.useRealTimers();
  }
});

it.each([[false, 249], [true, 250]] as const)("hides without an exit with reduced motion %s at %s ms", async (reducedMotion, ms) => {
  vi.useFakeTimers();
  const splash = openSplash("wait", reducedMotion);
  try {
    const loader = getByRole(splash.page, "status", { name: "Loading" });
    vi.advanceTimersByTime(ms);
    expect(loader.classList.contains("revealed")).toBe(reducedMotion);
    if (reducedMotion) expect(splash.queued()).toBe(0);
    await splash.finish();
    vi.advanceTimersByTime(1000);
    expect(loader.hidden).toBe(true);
    expect(loader.classList.contains("revealed")).toBe(reducedMotion);
    expect(splash.getAnimations).not.toHaveBeenCalled();
  } finally {
    splash.close();
    vi.useRealTimers();
  }
});
