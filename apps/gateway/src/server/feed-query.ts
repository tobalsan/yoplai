import type { HonoRequest } from "hono";
import type { FeedSelector } from "../durable/feed.js";

export const DEFAULT_FEED_LIMIT = 50;
export const INVALID_FEED_LIMIT = "Feed limit must be between 1 and 200";

export function validFeedLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 200;
}

export function feedWindowQuery(request: HonoRequest): { limit: number; selector?: FeedSelector } | { error: string } {
  const limit = Number(request.query("limit") ?? DEFAULT_FEED_LIMIT);
  if (!validFeedLimit(limit)) return { error: INVALID_FEED_LIMIT };
  const selectors = (["before", "after", "around"] as const).flatMap((direction) =>
    (request.queries(direction) ?? []).map((id) => ({ direction, id })));
  if (selectors.length > 1) return { error: "Use a single feed selector" };
  return { limit, selector: selectors[0] };
}
