export type SlackEventIdentity = {
  eventId?: string;
  team?: string;
  channel: string;
  ts: string;
};

// Sized against realistic channel volume inside the TTL window rather than
// against a single conversation: each entry is a short string plus a number,
// so a few thousand costs little and keeps live claims from being evicted by
// unrelated traffic before Slack has finished retrying.
const DEFAULT_MAX_CLAIMS = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // covers Slack's retry window (~3 retries, ~1min apart)

function fallbackKey(identity: SlackEventIdentity): string {
  return `${identity.team ?? ""}:${identity.channel}:${identity.ts}`;
}

// A single Slack user action (e.g. an @-mention in a channel) can arrive as
// two independent Events API deliveries — a `message` event and an
// `app_mention` event — each with its own unique event_id but the same
// channel/ts. Checking both the event_id key (when present) and the
// channel/ts fallback key catches Slack's own retries (same event_id) as
// well as that message/app_mention overlap (same channel/ts).
function identityKeys(identity: SlackEventIdentity): string[] {
  const fallback = fallbackKey(identity);
  return identity.eventId ? [identity.eventId, fallback] : [fallback];
}

export function describeSlackEventIdentity(
  identity: SlackEventIdentity
): string {
  return identity.eventId ?? fallbackKey(identity);
}

export type SlackEventDeduper = {
  /**
   * Claims a Slack event's identity. Returns true the first time an event is
   * seen (caller should proceed), false if it's a duplicate (caller should
   * suppress it).
   */
  claim(identity: SlackEventIdentity, now?: number): boolean;
  clear(): void;
};

/**
 * Builds a claim store scoped to ONE Slack bot. The store must never be shared
 * across bots: two Slack apps in the same channel receive the same user message
 * as separate events with distinct event_ids but identical team/channel/ts, so
 * a shared store would let whichever bot ran first swallow every other bot's
 * copy of that message.
 */
export function createSlackEventDeduper(
  maxClaims = DEFAULT_MAX_CLAIMS,
  ttlMs = DEFAULT_TTL_MS
): SlackEventDeduper {
  // key -> expiry. Insertion order stays expiry order because every claim uses
  // the same TTL and refreshes re-insert at the tail, so the sweep below can
  // stop at the first live entry.
  const claims = new Map<string, number>();

  return {
    claim(identity: SlackEventIdentity, now = Date.now()): boolean {
      for (const [key, expiresAt] of claims) {
        if (expiresAt > now) break;
        claims.delete(key);
      }

      const keys = identityKeys(identity);
      const isDuplicate = keys.some((key) => {
        const expiresAt = claims.get(key);
        return expiresAt !== undefined && expiresAt > now;
      });

      for (const key of keys) {
        claims.delete(key);
        claims.set(key, now + ttlMs);
      }
      while (claims.size > maxClaims) {
        const oldest = claims.keys().next();
        if (oldest.done) break;
        claims.delete(oldest.value);
      }

      return !isDuplicate;
    },
    clear(): void {
      claims.clear();
    },
  };
}
