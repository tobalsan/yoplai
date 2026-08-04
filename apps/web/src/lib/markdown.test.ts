// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders raw HTML from agent text literally without truncating later content", () => {
    const html = renderMarkdown(
      "Format: **<title>** · <source> · one line why it matters.\nEverything after this line remains visible."
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelector("title")).toBeNull();
    expect(container.textContent).toContain("<title>");
    expect(container.textContent).toContain("Everything after this line remains visible.");
  });

  it("does not render executable raw HTML", () => {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown('<script>alert("xss")</script>');

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("xss")</script>');
  });
});
