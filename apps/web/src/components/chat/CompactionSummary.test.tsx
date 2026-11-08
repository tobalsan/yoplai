// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { render } from "solid-js/web";
import { CompactionSummary } from "./ChatBlocks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = "";
});

function mount(text: string): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <CompactionSummary text={text} timestamp={0} />, container);
  return container.querySelector(".compaction-summary-text")!;
}

it("renders the compaction summary as markdown", () => {
  const el = mount("## Updates\n\n- **Eric** reconnected\n- done");
  expect(el.querySelector("h2")?.textContent).toBe("Updates");
  expect(el.querySelectorAll("li")).toHaveLength(2);
  expect(el.querySelector("strong")?.textContent).toBe("Eric");
  expect(el.textContent).not.toContain("**");
});

it("sanitises HTML in the summary", () => {
  const el = mount('hi <img src=x onerror="alert(1)"><script>alert(1)</script>');
  expect(el.querySelector("script")).toBeNull();
  expect(el.querySelector("img")).toBeNull();
});

it("does not force pre-wrap on the rendered markdown", () => {
  const css = readFileSync(join(__dirname, "ChatView.css"), "utf8");
  const rule = css.match(/\.compaction-summary-text\s*\{[^}]*\}/)?.[0];
  expect(rule).toBeDefined();
  expect(rule).not.toContain("pre-wrap");
});
