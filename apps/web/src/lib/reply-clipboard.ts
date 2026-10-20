import DOMPurify from "dompurify";
import { renderMarkdown } from "./markdown";

export function formatReplyClipboard(texts: string[]): {
  html: string;
  plain: string;
} {
  const parts = texts.map((text) => {
    const root = document.createElement("div");
    root.innerHTML = DOMPurify.sanitize(
      renderMarkdown(text, { preserveCodeWhitespace: true }),
      {
        ALLOWED_TAGS: [
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "p",
          "strong",
          "em",
          "ul",
          "ol",
          "li",
          "a",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "pre",
          "code",
          "blockquote",
          "br",
          "hr",
        ],
        ALLOWED_ATTR: ["href", "start"],
        ALLOW_DATA_ATTR: false,
      }
    );
    const plainNode = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof HTMLElement)) return "";
      if (node.tagName === "PRE" || node.tagName === "CODE")
        return node.textContent ?? "";
      const children = () =>
        Array.from(node.childNodes).map(plainNode).join("");
      if (node.tagName === "BR") return "\n";
      if (node.tagName === "A") {
        const label = children();
        const href = node.getAttribute("href");
        return href && href !== label ? `${label} (${href})` : label;
      }
      if (node.tagName === "UL" || node.tagName === "OL") {
        const start = Number(node.getAttribute("start") ?? 1);
        const list = Array.from(node.children)
          .map(
            (li, index) =>
              `${node.tagName === "OL" ? `${start + index}.` : "-"} ${plainNode(li).trim()}`
          )
          .join("\n");
        return node.parentElement?.tagName === "LI" ? `\n${list}` : list;
      }
      if (node.tagName === "BLOCKQUOTE")
        return Array.from(node.children).map(plainNode).join("\n\n");
      if (node.tagName === "TABLE")
        return Array.from(node.querySelectorAll("tr"))
          .map((row) =>
            Array.from(row.children)
              .map((cell) => plainNode(cell).trim())
              .join("\t")
          )
          .join("\n");
      return children();
    };
    const plain = Array.from(root.childNodes)
      .filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim())
      .map(plainNode)
      .join("\n\n");
    return { html: root.innerHTML, plain };
  });
  return {
    html: parts.map((part) => part.html).join("\n\n"),
    plain: parts.map((part) => part.plain).join("\n\n"),
  };
}
