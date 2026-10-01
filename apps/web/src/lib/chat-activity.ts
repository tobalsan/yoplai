export type ActivitySegment<T> =
  | { kind: "activity"; items: T[]; startIndex: number; endIndex: number }
  | { kind: "message"; item: T; startIndex: number; endIndex: number };

/** Groups adjacent activity items without moving them across visible content. */
export function groupActivityItems<T>(
  items: readonly T[],
  isActivity: (item: T) => boolean
): ActivitySegment<T>[] {
  const segments: ActivitySegment<T>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isActivity(item)) {
      segments.push({
        kind: "message",
        item,
        startIndex: index,
        endIndex: index,
      });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === "activity") {
      previous.items.push(item);
      previous.endIndex = index;
    } else {
      segments.push({
        kind: "activity",
        items: [item],
        startIndex: index,
        endIndex: index,
      });
    }
  }
  return segments;
}

/**
 * Ticker excerpt of streaming text: last five complete words + ellipsis.
 * Text not ending in whitespace may end mid-token, so its last word is dropped.
 */
export function lastFiveWords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1 && !/\s$/.test(text)) words.pop();
  return words.length ? `${words.slice(-5).join(" ")}…` : "";
}
