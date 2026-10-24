/**
 * Mattermost rejects posts over 16383 characters (the server's
 * `PostMessageMaxRunesV2`). Chunks stay well below it so an added code-fence
 * line or a multi-byte surprise never tips one over.
 */
export const MATTERMOST_MAX = 15_000;

const FENCE = /^(\s*)(```|~~~)/;

/**
 * Split a Markdown reply into posts of at most `max` characters, cutting at a
 * paragraph, then a line, then a word boundary. A code block cut in two is
 * closed at the end of one chunk and reopened (same fence and language) at the
 * start of the next, so both halves still render as code.
 */
export function splitMessage(text: string, max = MATTERMOST_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  let reopen = "";

  while (rest.length > 0) {
    const budget = max - reopen.length - 4; // room for "\n```" when closing
    if (reopen.length + rest.length <= max) {
      chunks.push(reopen + rest);
      break;
    }
    const cut = findCut(rest, budget);
    let chunk = reopen + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\n+/, "");

    const openFence = unclosedFence(chunk);
    if (openFence) {
      chunk += `\n${openFence.marker}`;
      reopen = `${openFence.marker}${openFence.info}\n`;
    } else {
      reopen = "";
    }
    chunks.push(chunk);
  }
  return chunks;
}

function findCut(text: string, budget: number): number {
  const limit = Math.max(1, budget);
  const window = text.slice(0, limit);
  for (const separator of ["\n\n", "\n", " "]) {
    const index = window.lastIndexOf(separator);
    if (index > limit / 2) return index + separator.length;
  }
  return limit;
}

/** The fence left open at the end of `chunk`, if any. */
function unclosedFence(
  chunk: string
): { marker: string; info: string } | undefined {
  let open: { marker: string; info: string } | undefined;
  for (const line of chunk.split("\n")) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[2];
    if (open) {
      if (marker === open.marker) open = undefined;
    } else {
      open = { marker, info: line.slice(match[0].length).trim() };
    }
  }
  return open;
}
