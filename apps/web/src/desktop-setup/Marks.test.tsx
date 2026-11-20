// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { AgentMark } from "./Marks";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  root = document.body.appendChild(document.createElement("div"));
});
afterEach(() => { dispose?.(); dispose = undefined; root.remove(); vi.unstubAllGlobals(); });

const settle = () => { for (let step = 0; frames.length && step < 500; step += 1) frames.splice(0).forEach((frame) => frame(0)); };
/** The farthest point of both rendered eyes from the centre of the circle, read from the SVG geometry. */
function farthestEyePoint(): { reach: number; radius: number } {
  const svg = root.querySelector("svg")!;
  const radius = Number(svg.querySelector("circle")!.getAttribute("r"));
  const [, x, y] = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(svg.querySelector("g")!.getAttribute("transform")!)!.map(Number);
  let reach = 0;
  for (const eye of svg.querySelectorAll("ellipse")) {
    const [cx, rx, ry] = ["cx", "rx", "ry"].map((name) => Number(eye.getAttribute(name)));
    for (let point = 0; point < Math.PI * 2; point += .05) reach = Math.max(reach, Math.hypot(x + cx + rx * Math.cos(point), y + ry * Math.sin(point)));
  }
  return { reach, radius };
}

it("keeps both rendered eyes inside the circle for near and far pointer positions", () => {
  dispose = render(() => <AgentMark />, root);
  vi.spyOn(root.querySelector("svg")!, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  const inside = [farthestEyePoint()];
  for (let direction = 0; direction < 360; direction += 15) {
    const angle = direction * Math.PI / 180;
    for (const distance of [0, 30, 1e6]) {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 + distance * Math.cos(angle), clientY: 50 + distance * Math.sin(angle) }));
      settle();
      inside.push(farthestEyePoint());
    }
  }
  expect(inside.length).toBeGreaterThan(50);
  for (const { reach, radius } of inside) expect(reach).toBeLessThan(radius);
  expect(Math.max(...inside.map(({ reach }) => reach))).toBeGreaterThan(inside[0].reach);
});
