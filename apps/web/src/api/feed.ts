import type { FeedDetail, FeedHit, FeedWindow, WsFeedMessage } from "@yoplai/shared/types";
import { API_BASE, apiFetch } from "./core";
import { subscribeToRealtime } from "./realtime-client";

export type FeedSelector = { before?: string; after?: string; around?: string };

async function readFeed<T>(agentId: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/feed${path}`, { signal });
  if (!response.ok) throw Object.assign(new Error("Unable to read conversation feed"), { status: response.status });
  return response.json();
}

export function fetchFeedWindow(agentId: string, selector: FeedSelector, limit: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(limit), ...selector });
  return readFeed<FeedWindow>(agentId, `?${query}`, signal);
}

export function fetchFeedDetail(agentId: string, id: string, signal: AbortSignal) {
  return readFeed<FeedDetail>(agentId, `/messages/${encodeURIComponent(id)}`, signal);
}

export async function searchFeed(agentId: string, text: string, signal: AbortSignal) {
  const query = new URLSearchParams({ q: text, limit: "20" });
  return (await readFeed<{ hits: FeedHit[] }>(agentId, `/search?${query}`, signal)).hits;
}

export function subscribeToFeed(
  agentId: string,
  limit: number,
  onFrame: (frame: WsFeedMessage) => void,
  onClose: () => void,
) {
  const stop = subscribeToRealtime({
    interests: [{ type: "feed", agentId, limit }],
    onClose,
    onEvent: (event) => {
      if (event.type === "feed_snapshot" || event.type === "feed_delta" || event.type === "feed_end") {
        onFrame(event);
        if (event.type === "feed_end") stop();
      }
    },
  });
  return stop;
}
