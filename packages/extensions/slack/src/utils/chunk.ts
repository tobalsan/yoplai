export const SLACK_MAX = 4000;
const CLOSING_FENCE = "\n```";

function isInsideCodeBlock(text: string, openFence: string | null): boolean {
  let inside = Boolean(openFence);
  const fenceCount = [...text.matchAll(/^```[^\n]*/gm)].length;
  for (let index = 0; index < fenceCount; index++) {
    inside = !inside;
  }
  return inside;
}

function getLastFence(text: string): string | undefined {
  return [...text.matchAll(/^(```[^\n]*)/gm)].pop()?.[1];
}

export function splitMessage(text: string, maxLength = SLACK_MAX): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null;

  while (remaining.length > 0) {
    const prefix: string = openFence ? `${openFence}\n` : "";
    if (prefix.length + remaining.length <= maxLength) {
      chunks.push(prefix + remaining);
      break;
    }

    let rawLimit: number = maxLength - prefix.length;
    let chunk = remaining.slice(0, rawLimit);
    let insideCodeBlock = isInsideCodeBlock(chunk, openFence);
    if (insideCodeBlock) {
      rawLimit = maxLength - prefix.length - CLOSING_FENCE.length;
      chunk = remaining.slice(0, rawLimit);
      insideCodeBlock = isInsideCodeBlock(chunk, openFence);
    }

    let splitIndex: number = rawLimit;

    if (insideCodeBlock) {
      const lastNewline = chunk.lastIndexOf("\n");
      if (lastNewline > rawLimit / 2) {
        splitIndex = lastNewline;
      }
    } else {
      let idx = chunk.lastIndexOf("\n");
      if (idx === -1 || idx < rawLimit / 2) {
        idx = chunk.lastIndexOf(" ");
      }
      if (idx > rawLimit / 2) {
        splitIndex = idx;
      }
    }

    chunk = remaining.slice(0, splitIndex);
    insideCodeBlock = isInsideCodeBlock(chunk, openFence);

    if (insideCodeBlock) {
      chunk = `${prefix}${chunk}${CLOSING_FENCE}`;
      openFence = getLastFence(remaining.slice(0, splitIndex)) ?? openFence ?? "```";
    } else {
      chunk = prefix + chunk;
      openFence = null;
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
