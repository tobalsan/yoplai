import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";

type RenderMarkdownOptions = {
  breaks?: boolean;
  stripFrontmatter?: boolean;
  stripFirstHeading?: boolean;
  rewriteHref?: (href: string) => string | null;
};

function normalizeHref(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["href", "url", "src", "link", "raw"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  }
  return String(raw);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getFilenameFromHref(raw: string): string {
  const cleaned = raw.split(/[?#]/)[0] ?? "";
  const last = cleaned.split("/").filter(Boolean).pop() ?? cleaned;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function stripMarkdownMeta(
  content: string,
  options?: Pick<RenderMarkdownOptions, "stripFrontmatter" | "stripFirstHeading">
): string {
  let next = content;
  if (options?.stripFrontmatter) {
    next = next.replace(/^\s*---[\s\S]*?\n---\s*\n?/, "");
  }
  if (options?.stripFirstHeading) {
    next = next.replace(/^\s*#\s+.+\n+/, "");
  }
  return next;
}

export function renderMarkdown(
  content: string,
  options?: RenderMarkdownOptions
): string {
  const renderer = new marked.Renderer();

  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);

  renderer.link = ({ href, title, text }: Tokens.Link) => {
    const rawHref = normalizeHref(href) ?? "";
    const resolvedHref = options?.rewriteHref?.(rawHref) ?? rawHref;
    const safeTitle =
      typeof title === "string" && title ? ` title="${title}"` : "";
    const safeText =
      typeof text === "string" && text.trim().length > 0
        ? text
        : getFilenameFromHref(rawHref || resolvedHref || "");
    return `<a href="${resolvedHref ?? ""}"${safeTitle} target="_blank" rel="noopener noreferrer">${safeText}</a>`;
  };

  if (options?.rewriteHref) {
    renderer.image = ({ href, title }: Tokens.Image) => {
      const rawHref = normalizeHref(href) ?? "";
      const resolvedHref = options.rewriteHref?.(rawHref) ?? rawHref;
      const safeTitle =
        typeof title === "string" && title ? ` title="${title}"` : "";
      const label = getFilenameFromHref(rawHref || resolvedHref || "");
      return `<a href="${resolvedHref ?? ""}"${safeTitle} target="_blank" rel="noopener noreferrer">${label}</a>`;
    };
  }

  const html = marked.parse(
    stripMarkdownMeta(content, {
      stripFrontmatter: options?.stripFrontmatter,
      stripFirstHeading: options?.stripFirstHeading,
    }),
    {
      breaks: options?.breaks ?? true,
      async: false,
      renderer,
    }
  ) as string;

  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}
