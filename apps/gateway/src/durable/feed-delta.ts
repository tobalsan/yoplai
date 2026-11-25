import type { FeedItem } from "@yoplai/shared";

export function feedDelta(previous: readonly FeedItem[], next: readonly FeedItem[]) {
  if (!next.length) return previous.length ? undefined : { upsert: [] };
  const first = next[0].id;
  const firstIndex = previous.findIndex(({ id }) => id === first);
  if (firstIndex < 0 && previous.length && Number(first.slice(2)) <= Number(previous.at(-1)!.id.slice(2))) return;
  const remaining = firstIndex < 0 ? [] : previous.slice(firstIndex);
  if (remaining.some((item, index) => item.id !== next[index]?.id)) return;
  // A seam can move a previously visible answer behind the dropped prefix.
  const dropped = firstIndex < 0 ? previous : previous.slice(0, firstIndex);
  const nextIds = new Set(next.map(({ id }) => id));
  if (dropped.some(({ id }) => nextIds.has(id))) return;
  const dropBefore = previous.length && firstIndex !== 0 ? first : undefined;
  const upsert = next.filter((item, index) => JSON.stringify(item) !== JSON.stringify(remaining[index]));
  return { upsert, ...(dropBefore !== undefined ? { dropBefore } : {}) };
}
