import { beforeEach, describe, expect, it } from "vitest";
import { createSlackEventDeduper } from "./dedupe.js";

describe("Slack inbound event claims", () => {
  let deduper: ReturnType<typeof createSlackEventDeduper>;

  beforeEach(() => {
    deduper = createSlackEventDeduper();
  });

  it("claims an event by event_id and rejects the same event_id again", () => {
    const identity = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    expect(deduper.claim(identity)).toBe(true);
    expect(deduper.claim(identity)).toBe(false);
  });

  it("rejects a different event_id sharing the same channel/ts", () => {
    expect(
      deduper.claim({ eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" })
    ).toBe(true);
    expect(
      deduper.claim({ eventId: "Ev2", team: "T1", channel: "C1", ts: "1.1" })
    ).toBe(false);
  });

  it("falls back to team:channel:ts when event_id is absent", () => {
    const identity = { team: "T1", channel: "C1", ts: "1.1" };
    expect(deduper.claim(identity)).toBe(true);
    expect(deduper.claim(identity)).toBe(false);
  });

  it("allows distinct events through", () => {
    expect(
      deduper.claim({ eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" })
    ).toBe(true);
    expect(
      deduper.claim({ eventId: "Ev2", team: "T1", channel: "C1", ts: "1.2" })
    ).toBe(true);
  });

  it("expires claims after the TTL window", () => {
    const identity = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    const start = Date.now();
    expect(deduper.claim(identity, start)).toBe(true);
    expect(deduper.claim(identity, start + 11 * 60 * 1000)).toBe(true);
  });

  it("keeps separate bots from claiming each other's copy of one message", () => {
    // Two Slack apps in the same channel receive the same user message as
    // distinct events sharing team/channel/ts.
    const botA = createSlackEventDeduper();
    const botB = createSlackEventDeduper();
    const shared = { team: "T1", channel: "C_eng", ts: "1712.0001" };

    expect(botA.claim({ ...shared, eventId: "Ev_A" })).toBe(true);
    expect(botB.claim({ ...shared, eventId: "Ev_B" })).toBe(true);
    // Within one bot, the sibling app_mention delivery is still collapsed.
    expect(botB.claim({ ...shared, eventId: "Ev_M" })).toBe(false);
  });

  it("keeps a live claim through a burst of unrelated channel traffic", () => {
    const start = Date.now();
    const target = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    expect(deduper.claim(target, start)).toBe(true);

    for (let i = 0; i < 1000; i += 1) {
      deduper.claim(
        { eventId: `Ev-noise-${i}`, team: "T1", channel: "C1", ts: `2.${i}` },
        start + i
      );
    }

    // Slack retries the original event five minutes later, well inside the TTL.
    expect(deduper.claim(target, start + 5 * 60 * 1000)).toBe(false);
  });

  it("release() lets a previously claimed identity be reclaimed", () => {
    const identity = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    expect(deduper.claim(identity)).toBe(true);
    expect(deduper.claim(identity)).toBe(false);

    deduper.release(identity);

    expect(deduper.claim(identity)).toBe(true);
  });

  it("release() also drops the channel/ts fallback key so the sibling delivery is not blocked either", () => {
    const identity = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    expect(deduper.claim(identity)).toBe(true);

    deduper.release(identity);

    expect(
      deduper.claim({ eventId: "Ev2", team: "T1", channel: "C1", ts: "1.1" })
    ).toBe(true);
  });

  it("release() on an identity that was never claimed is a harmless no-op", () => {
    const identity = { eventId: "Ev1", team: "T1", channel: "C1", ts: "1.1" };
    expect(() => deduper.release(identity)).not.toThrow();
    expect(deduper.claim(identity)).toBe(true);
  });

  it("evicts expired claims even when a later claim was refreshed", () => {
    const small = createSlackEventDeduper(4);
    const start = Date.now();
    small.claim({ eventId: "Ev-old", channel: "C1", ts: "1.1" }, start);
    small.claim({ eventId: "Ev-new", channel: "C1", ts: "1.2" }, start + 1000);
    // Refreshing the newer claim must not reorder it ahead of the older one in
    // a way that blocks the expiry sweep.
    small.claim({ eventId: "Ev-new", channel: "C1", ts: "1.2" }, start + 2000);

    // Long past both TTLs: everything is expired, so both claim as fresh.
    const later = start + 11 * 60 * 1000;
    expect(small.claim({ eventId: "Ev-old", channel: "C1", ts: "1.1" }, later)).toBe(
      true
    );
  });
});
