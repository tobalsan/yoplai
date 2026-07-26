// Convert agent markdown into Telegram-native HTML. Telegram's HTML parse_mode
// supports a small tag set (<b> <i> <u> <s> <code> <pre> <a> <blockquote> and
// <tg-spoiler>), so we translate the common markdown constructs into those and
// escape everything else. HTML is preferred over MarkdownV2 because escaping is
// simpler and unambiguous: only `&`, `<`, and `>` are special.
//
// The pipeline mirrors the slack mrkdwn converter's house style: protect code
// spans/blocks first (so their contents are never reinterpreted), convert
// GitHub-flavoured tables into an aligned monospace block, then translate inline
// markup, and finally escape the residual plain text.

const SENTINEL_PREFIX = "\u0000YOPLAI";
const MAX_LINK_OPEN_TAG_LENGTH = 1024;
const MAX_CODE_OPEN_TAG_LENGTH = 1024;

type ProtectedToken = {
  key: string;
  /** Already-rendered HTML to splice back in verbatim. */
  html: string;
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for safe use inside a double-quoted HTML attribute. */
function escapeAttribute(input: string): string {
  return escapeHtml(input).replace(/"/g, "&quot;");
}

/**
 * Replace fenced code blocks and inline code with sentinels, pre-rendering them
 * to the Telegram <pre>/<code> equivalents. Their contents are HTML-escaped but
 * otherwise left untouched so markdown inside code is not interpreted.
 */
function protectCode(
  input: string,
  tokens: ProtectedToken[]
): string {
  const push = (html: string): string => {
    const key = `${SENTINEL_PREFIX}${tokens.length}\u0000`;
    tokens.push({ key, html });
    return key;
  };

  // Fenced blocks: ```lang\n...\n``` -> <pre><code class="language-lang">...
  let text = input.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, lang: string, body: string) => {
      const escaped = escapeHtml(body.replace(/\n$/, ""));
      const language = lang.trim();
      const codeOpenTag = language
        ? `<code class="language-${escapeAttribute(language)}">`
        : "";
      const inner =
        language && codeOpenTag.length <= MAX_CODE_OPEN_TAG_LENGTH
          ? `${codeOpenTag}${escaped}</code>`
          : escaped;
      return push(`<pre>${inner}</pre>`);
    }
  );

  // Inline code: `...`
  text = text.replace(/`([^`\n]+)`/g, (_match, body: string) =>
    push(`<code>${escapeHtml(body)}</code>`)
  );

  return text;
}

/**
 * Replace markdown links/images with sentinels before the inline pass so URLs
 * (which often contain `_`, `*`, `"`) are never reinterpreted as markdown or
 * allowed to break the href attribute. Images become their alt text.
 */
function protectLinks(input: string, tokens: ProtectedToken[]): string {
  const push = (html: string): string => {
    const key = `${SENTINEL_PREFIX}${tokens.length}\u0000`;
    tokens.push({ key, html });
    return key;
  };

  return (
    input
      // Images: keep alt text only (it still flows through the inline pass).
      .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, "$1")
      // Links: [label](url). The url is href-escaped (incl. quotes); the label
      // is left in place as a sentinel-wrapped fragment so its own markdown is
      // still rendered, but the url can never be touched.
      .replace(
        /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
        (_m, label: string, url: string) => {
          const openTag = `<a href="${escapeHref(url)}">`;
          if (openTag.length > MAX_LINK_OPEN_TAG_LENGTH) {
            return `${label} (${push(`<code>${escapeHtml(url)}</code>`)})`;
          }
          return push(openTag) + label + push("</a>");
        }
      )
  );
}

/** Escape a URL for safe use inside a double-quoted href attribute. */
function escapeHref(url: string): string {
  return escapeAttribute(url);
}

function restore(input: string, tokens: ProtectedToken[]): string {
  // Restore in reverse so later (inline) sentinels nested in earlier output do
  // not clash; keys are unique regardless, but reverse keeps it deterministic.
  let text = input;
  for (let i = tokens.length - 1; i >= 0; i--) {
    text = text.split(tokens[i].key).join(tokens[i].html);
  }
  return text;
}

function parseTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return Boolean(cells?.every((cell) => /^:?-{1,}:?$/.test(cell)));
}

/**
 * Render a GitHub-flavoured markdown table as an aligned, monospaced block so it
 * stays readable in Telegram (which has no native table support). The whole
 * block is emitted as a protected <pre> token: contents are escaped and never
 * reinterpreted by the inline pass.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths: number[] = [];
  const all = [headers, ...rows];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }

  const pad = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join(" | ")
      .trimEnd();

  const divider = widths.map((w) => "-".repeat(w)).join("-+-");
  const lines = [pad(headers), divider, ...rows.map((row) => pad(row))];
  return lines.join("\n");
}

/**
 * Replace markdown tables with protected <pre> tokens. Non-table lines pass
 * through untouched for the later inline pass.
 */
function convertTables(input: string, tokens: ProtectedToken[]): string {
  const lines = input.split("\n");
  const output: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const headers = parseTableRow(lines[index]);
    if (!headers || !lines[index + 1] || !isTableSeparator(lines[index + 1])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = parseTableRow(lines[index]);
      if (!row || isTableSeparator(lines[index])) break;
      rows.push(row);
      index += 1;
    }

    const table = renderTable(headers, rows);
    const key = `${SENTINEL_PREFIX}${tokens.length}\u0000`;
    tokens.push({ key, html: `<pre>${escapeHtml(table)}</pre>` });
    output.push(key);
  }

  return output.join("\n");
}

/**
 * Translate inline emphasis/strikethrough on already-escaped text. Links, images,
 * and code are handled earlier via sentinels, so they never reach this pass.
 */
function convertInline(input: string): string {
  return (
    input
      // Bold: **text** or __text__
      .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>")
      .replace(/__([^\n]+?)__/g, "<b>$1</b>")
      // Italic: *text* or _text_
      .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
      .replace(/(^|[^_])_(?!\s)([^_\n]+?)_(?!_)/g, "$1<i>$2</i>")
      // Strikethrough: ~~text~~
      .replace(/~~([^\n]+?)~~/g, "<s>$1</s>")
  );
}

/** Convert a single block (non-code) line's leading markdown structure. */
function convertBlockLine(line: string): string {
  // Headings: # .. ###### -> bold line.
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (heading) {
    return `<b>${convertInline(heading[2].trimEnd())}</b>`;
  }

  // Blockquote: > text. The leading ">" is already HTML-escaped to "&gt;".
  const quote = line.match(/^\s{0,3}&gt;\s?(.*)$/);
  if (quote) {
    return `<blockquote>${convertInline(quote[1])}</blockquote>`;
  }

  // Unordered list: -, *, + -> bullet.
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    return `${bullet[1]}• ${convertInline(bullet[2])}`;
  }

  // Ordered list: keep the number, normalise the marker.
  const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${convertInline(ordered[3])}`;
  }

  // Horizontal rule.
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return "──────────";
  }

  return convertInline(line);
}

/**
 * Render agent markdown into Telegram HTML. Output is safe to send with
 * `parse_mode: "HTML"`: code, tables, and the residual text are all escaped, and
 * only the intentional Telegram tags survive.
 */
export function renderMarkdown(input: string): string {
  const tokens: ProtectedToken[] = [];

  // 1. Protect code first so nothing inside is reinterpreted or escaped twice.
  let text = protectCode(input, tokens);

  // 2. Tables -> protected <pre> tokens.
  text = convertTables(text, tokens);

  // 2b. Links/images -> protected tokens so URLs are never reinterpreted.
  text = protectLinks(text, tokens);

  // 3. Escape the remaining plain text up front; inline/block converters then
  //    insert real tags. Sentinels contain only NUL + ASCII so survive escaping.
  text = escapeHtml(text);

  // 4. Block + inline markdown -> tags, line by line.
  text = text
    .split("\n")
    .map((line) => convertBlockLine(line))
    .join("\n");

  // 5. Splice protected code/table HTML back in.
  return restore(text, tokens).trim();
}
