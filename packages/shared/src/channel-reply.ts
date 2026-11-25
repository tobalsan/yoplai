/** Bound an already-rendered reply, leaving room for the link and a closing code fence. */
export function limitChannelReply(text: string, max: number, link?: string): string {
  if (text.length <= max) return text;
  const tail = link && link.length < max - 10 ? "\n\n" + link : "";
  const fences = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
  const ellipsis = text.slice(0, max - tail.length - 1).search(fences) >= 0 ? "\n…" : "…";
  const budget = max - tail.length - ellipsis.length;
  const prefix = text.slice(0, budget);
  let fence: RegExpMatchArray | undefined;
  for (const match of prefix.matchAll(fences)) {
    if (!fence) fence = match;
    else if (match[1][0] === fence[1][0] && match[1].length >= fence[1].length && !match[2].trim()) fence = undefined;
  }
  let cut = budget;
  let closing = "";
  if (fence && fence.index !== undefined) {
    const marker = "\n" + fence[1];
    if (fence.index + fence[0].length >= budget - marker.length) cut = fence.index;
    else {
      cut -= marker.length;
      closing = marker;
    }
  }
  return prefix.slice(0, cut).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + closing + ellipsis + tail;
}
