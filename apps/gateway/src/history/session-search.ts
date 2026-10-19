import { oneLine } from "./condense.js";

export type SearchMessage = { role: string; content: unknown };
export type SessionMatch = { match: "title" | "content"; snippet?: string };

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const obj = block as Record<string, unknown>;
      return obj.type === "text" && typeof obj.text === "string"
        ? obj.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Match the shown label and only user/assistant text blocks. */
export function matchSession(
  label: string,
  messages: SearchMessage[],
  query: string
): SessionMatch | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const title = label.toLowerCase();
  if (words.every((word) => title.includes(word))) return { match: "title" };
  const texts = messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant"
    )
    .map((message) => textFromContent(message.content));
  if (
    !words.every(
      (word) =>
        title.includes(word) ||
        texts.some((text) => text.toLowerCase().includes(word))
    )
  )
    return null;
  let best = "";
  let bestHits = 0;
  for (const text of texts) {
    const hits = words.filter((word) =>
      text.toLowerCase().includes(word)
    ).length;
    if (hits > bestHits) {
      best = text;
      bestHits = hits;
    }
  }
  const flat = oneLine(best);
  const lower = flat.toLowerCase();
  const first = Math.min(
    ...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0)
  );
  const start = Math.max(0, first - 80);
  const end = Math.min(flat.length, start + 160);
  return {
    match: "content",
    snippet: `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`,
  };
}
