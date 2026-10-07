// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "./steps";

function dom(html: string): ParentNode {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("TOUR_STEPS", () => {
  it("matches routes for each page", () => {
    expect(TOUR_STEPS[1].route.test("/")).toBe(true);
    expect(TOUR_STEPS[3].route.test("/agents/a1/edit")).toBe(true);
    expect(TOUR_STEPS[4].route.test("/agents/a1/extensions/gmail")).toBe(true);
    expect(TOUR_STEPS[4].route.test("/agents/a1/edit")).toBe(false);
    expect(TOUR_STEPS[11].route.test("/chat/a1")).toBe(true);
  });

  it("prefers the gmail add button, then card, then first extension", () => {
    const step = TOUR_STEPS[3];
    const root = dom(`
      <li data-tour="ext-card" data-tour-ext="slack"></li>
      <a data-tour="ext-add" data-tour-ext="slack" id="slack"></a>
      <a data-tour="ext-add" data-tour-ext="gmail" id="gmail"></a>`);
    expect(step.target!(root)?.id).toBe("gmail");
    expect(step.target!(dom(`<a data-tour="ext-add" data-tour-ext="slack" id="slack"></a>`))?.id).toBe("slack");
    expect(
      step.target!(dom(`<li data-tour="ext-card" data-tour-ext="gmail" id="c"></li><a data-tour="ext-add" data-tour-ext="x" id="x"></a>`))?.id
    ).toBe("c");
  });
});
