// @vitest-environment jsdom
import { expect, it } from "vitest";
import { formatReplyClipboard } from "./reply-clipboard";

it("formats a complete turn as semantic HTML and clean text while preserving code", () => {
  const result = formatReplyClipboard([
    "## Heading\n\n**Bold** and *italic* with `x < y`.\n\n- First\n- Second\n\n3. Third\n4. Fourth\n\n[Docs](https://example.com)\n\n```sh\n  echo '**raw**'\n\t<x>\n```",
    "| Name | Value |\n| --- | --- |\n| A | B |",
  ]);
  expect(result.plain).toBe(
    "Heading\n\nBold and italic with x < y.\n\n- First\n- Second\n\n3. Third\n4. Fourth\n\nDocs (https://example.com)\n\n  echo '**raw**'\n\t<x>\n\n\nName\tValue\nA\tB"
  );
  const html = new DOMParser().parseFromString(result.html, "text/html");
  expect(html.querySelector("h2")?.textContent).toBe("Heading");
  expect(html.querySelector("strong")?.textContent).toBe("Bold");
  expect(html.querySelector("em")?.textContent).toBe("italic");
  expect(html.querySelector("pre code")?.textContent).toBe(
    "  echo '**raw**'\n\t<x>\n"
  );
  expect(html.querySelectorAll("tr")).toHaveLength(2);
  expect(html.querySelector("[class], [style]")).toBeNull();
});

it("keeps nested list items and quoted paragraphs on separate plain-text lines", () => {
  const result = formatReplyClipboard([
    "- Parent\n  - Child\n\n> First paragraph\n>\n> Second paragraph",
  ]);
  expect(result.plain).toBe(
    "- Parent\n- Child\n\nFirst paragraph\n\nSecond paragraph"
  );
});
