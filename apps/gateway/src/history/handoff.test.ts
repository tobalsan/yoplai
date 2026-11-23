import { describe, expect, it } from "vitest";
import { buildHandoff } from "./handoff.js";
import type { ToolStep, TranscriptEntry } from "./transcript.js";

function user(id: string, text: string): TranscriptEntry {
  return { id, role: "user", text };
}

function assistant(id: string, text: string): TranscriptEntry {
  return { id, role: "assistant", text };
}

// Nine fit in the 80,000-character recent budget. The tenth marks the boundary.
const padding = Array.from({ length: 10 }, (_, i) =>
  user(`padding-${i}`, "p".repeat(8000))
);

describe("buildHandoff", () => {
  it("carries early user requests verbatim in older excerpts", () => {
    const { text } = buildHandoff({
      transcript: [
        user("origin", "Keep the blue tiles.\n  Match the samples."),
        user("follow-up", "Please price the small batch."),
        ...padding,
      ],
    });

    const [older, recent] = text.split("## Recent messages\n");
    expect(older).toContain(
      "## Older excerpts\n[origin] user\nKeep the blue tiles.\n  Match the samples.\n\n" +
        "[follow-up] user\nPlease price the small batch."
    );
    expect(recent).toContain("[padding-1] user\n");
    expect(recent).toContain("[padding-9] user\n");
    expect(recent).not.toContain("[origin] user");
  });

  it("deduplicates topic references and renders the selected excerpts chronologically", () => {
    const { text } = buildHandoff({
      transcript: [
        user("design", "d".repeat(510)),
        assistant("sample", "One polished sample."),
        ...padding,
        user("live", "Ship a sample."),
      ],
      memory: {
        text: "Samples",
        topicRefs: [
          { id: "sample" },
          { id: "design" },
          { id: "sample" },
          { id: "live" },
          { id: "missing" },
        ],
      },
    });

    const [older, recent] = text.split("## Recent messages\n");
    expect(
      older.includes(
        `[design] user\n${"d".repeat(500)}… [+10 chars · design]\n\n[sample] assistant\nOne polished sample.`
      )
    ).toBe(true);
    expect(text.match(/\[design\] user/g)).toHaveLength(1);
    expect(text.match(/\[sample\] assistant/g)).toHaveLength(1);
    expect(text.match(/\[live\] user/g)).toHaveLength(1);
    expect(older.includes("[live]")).toBe(false);
    expect(recent.includes("[live] user\nShip a sample.")).toBe(true);
    expect(text.includes("[missing]")).toBe(false);
  });

  it("takes final public replies from the last three omitted turns", () => {
    const { text } = buildHandoff({
      transcript: [
        user("turn-1", "First request"),
        assistant("reply-1", "Too old"),
        user("turn-2", "Second request"),
        assistant("partial-2", "An intermediate update"),
        assistant("reply-2", "Second conclusion"),
        user("turn-3", "No answer yet"),
        assistant("empty-3", ""),
        user("turn-4", "Fourth request"),
        assistant("reply-4", "r".repeat(1230)),
        assistant("empty-4", ""),
        user("crosses", "A turn still in progress"),
        assistant("crosses-early", "x".repeat(8000)),
        assistant("crosses-recent", "y".repeat(8000)),
        ...padding.slice(2),
      ],
    });

    const [older] = text.split("## Recent messages\n");
    expect(older.includes("[reply-2] assistant\nSecond conclusion")).toBe(true);
    expect(
      older.includes(
        `[reply-4] assistant\n${"r".repeat(1200)}… [+30 chars · reply-4]`
      )
    ).toBe(true);
    expect(older.indexOf("[reply-2]")).toBeLessThan(older.indexOf("[reply-4]"));
    expect(
      older.match(
        /\[(?:reply-1|partial-2|empty-[34]|crosses-early)\] assistant/g
      )
    ).toBeNull();
  });

  it("carries an omitted final reply when the recent window starts with a tool-only entry", () => {
    const { text } = buildHandoff({
      transcript: [
        user("request", "Check the tile order."),
        assistant(
          "conclusion",
          "The blue tiles are in stock. ".padEnd(8000, "r")
        ),
        {
          ...assistant("tool", ""),
          toolCalls: [{ callId: "lookup", name: "lookup", arguments: {} }],
        },
        ...Array.from({ length: 10 }, (_, i) =>
          user(`n${i}`, "p".repeat(7900))
        ),
      ],
    });

    const [older, recent] = text.split("## Recent messages\n");
    expect(recent?.startsWith("[tool] assistant\n\n[n0] user\n")).toBe(true);
    expect(older).toContain("[conclusion] assistant\nThe blue tiles are in stock.");
    expect(older).toContain("… [+6800 chars · conclusion]");
  });

  it("caps each message and reports user requests that exceed the fixed excerpt budget", () => {
    const users = Array.from({ length: 13 }, (_, i) =>
      user(`request-${i}`, "u".repeat(10_000))
    );
    const { text } = buildHandoff({
      transcript: [
        ...users,
        ...padding.slice(0, -1),
        user("latest", "n".repeat(10_000)),
      ],
    });

    const [older, tail] = text.split("## Recent messages\n");
    const [recent, notice] = tail?.split("## Omission notice\n") ?? [];
    expect(older.match(/^\[request-\d+\] user$/gm)).toEqual([
      "[request-0] user",
      "[request-6] user",
      "[request-7] user",
      "[request-8] user",
      "[request-9] user",
      "[request-10] user",
      "[request-11] user",
      "[request-12] user",
    ]);
    expect(
      older.includes(
        `[request-0] user\n${"u".repeat(800)}… [+9200 chars · request-0]`
      )
    ).toBe(true);
    expect(
      recent?.endsWith(
        `[latest] user\n${"n".repeat(8000)}… [+2000 chars · latest]\n\n`
      )
    ).toBe(true);
    expect(notice).toContain(
      "14 messages before the recent window ([request-0] to [padding-0])."
    );
    expect(notice).toContain(
      "5 omitted user messages not carried ([request-1] to [request-5])."
    );
    expect(notice).toContain(
      "Use the session_history tool’s search action to recover originals."
    );
    expect(notice).toContain("Bracketed IDs identify the originals.");
  });

  it("condenses recent tool steps and identifies the latest omitted result by call position", () => {
    const tools = (id: string, ...toolCalls: ToolStep[]): TranscriptEntry => ({
      ...assistant(id, ""),
      toolCalls,
    });
    const input = {
      transcript: [
        user("first", "Check the inventory."),
        tools("old-call", {
          callId: "old",
          name: "read",
          arguments: {},
          result: {
            id: "late-result",
            text: "Older call, later result",
            isError: false,
          },
        }),
        tools(
          "last-call",
          {
            callId: "last",
            name: "inventory",
            arguments: {},
            result: {
              id: "early-result",
              text: "x".repeat(2500),
              isError: false,
            },
          },
          {
            callId: "pending-old",
            name: "search",
            arguments: {},
          }
        ),
        ...padding,
        tools(
          "recent-call",
          {
            callId: "recent",
            name: "sample_lookup",
            arguments: { code: "blue" },
            result: { id: "recent-result", text: "Found", isError: false },
          },
          {
            callId: "err",
            name: "read",
            arguments: { path: "stock.txt" },
            result: {
              id: "failed-result",
              text: "Unavailable\nLater detail",
              isError: true,
            },
          },
          {
            callId: "pending",
            name: "search",
            arguments: {},
          }
        ),
      ],
      templates: { sample_lookup: "Looked up {code}" },
    };

    const output = buildHandoff(input);
    expect(buildHandoff(input)).toEqual(output);
    const steps = output.text
      .split("## Condensed steps\n")[1]
      ?.split("\n\n")[0];
    expect(steps).toBe(
      "[recent-call] → Looked up blue (ok, 5 chars)\n" +
        "[recent-call] → Read stock.txt (ERR: Unavailable, 24 chars)\n" +
        "[recent-call] → search (no result)"
    );
    const notice = output.text.split("## Omission notice\n")[1];
    expect(notice).toContain("3 tool steps not shown.");
    expect(notice).toContain(
      "Latest omitted tool output: [early-result] inventory (2.5k chars)."
    );
    expect(notice).not.toContain("[late-result]");
  });

  it("keeps the sections in order and caps memory, steps, and long omission ranges", () => {
    const result = { id: "result", text: "Found", isError: false };
    const calls = Array.from(
      { length: 150 },
      (_, i): ToolStep => ({
        callId: `call-${i}`,
        name: "lookup",
        arguments: { value: `${i} ${"v".repeat(56)}` },
        result: { ...result, id: `result-${i}` },
      })
    );
    const topics = Array.from({ length: 10 }, (_, i) =>
      assistant(`topic-${i}`, "t".repeat(1000))
    );
    const users = Array.from({ length: 25 }, (_, i) =>
      user(`user-${i}`, "u".repeat(1000))
    );
    const longFirstId = "first-" + "x".repeat(2700);
    const longLastId = "last-" + "y".repeat(2700);
    const { text, breakdown } = buildHandoff({
      transcript: [
        user(longFirstId, "Start here"),
        ...topics,
        ...users,
        user(longLastId, "p".repeat(8000)),
        ...padding.slice(1),
        { ...assistant("work", ""), toolCalls: calls },
      ],
      memory: {
        text: "m".repeat(20_000),
        topicRefs: topics.map(({ id }) => ({ id })),
      },
    });

    expect(text.match(/^## .+$/gm)).toEqual([
      "## Memory",
      "## Older excerpts",
      "## Condensed steps",
      "## Recent messages",
      "## Omission notice",
    ]);
    const [memory, older, steps, recent, notice] = text.split(/\n\n(?=## )/);
    expect(memory.startsWith("## Memory\nmmm")).toBe(true);
    expect(memory).toMatch(/… \[\+\d+ chars\]$/);
    expect(older.match(/^\[topic-\d+\] assistant$/gm)).toEqual([
      "[topic-0] assistant",
      "[topic-1] assistant",
      "[topic-2] assistant",
      "[topic-3] assistant",
      "[topic-4] assistant",
      "[topic-5] assistant",
      "[topic-6] assistant",
    ]);
    expect(steps.split("\n")[1]).not.toContain("lookup 0 ");
    expect(steps.indexOf("lookup 148 ")).toBeLessThan(
      steps.indexOf("lookup 149 ")
    );
    expect(steps).toContain("lookup 149 ");
    expect(notice).toContain("37 messages before the recent window");
    expect(notice).toMatch(/\d+ omitted user messages not carried/);
    expect(notice).toMatch(
      /Latest omitted tool output: \[result-\d+\] lookup \(5 chars\)\./
    );
    expect(notice).toContain("Bracketed IDs identify the originals.");
    expect(notice.includes(longFirstId)).toBe(false);
    expect(notice.includes(longLastId)).toBe(false);
    expect(breakdown).toEqual({
      totalTokens: Math.ceil(text.length / 4),
      memoryTokens: Math.ceil(memory.length / 4),
      excerptTokens: Math.ceil((older.length + 2) / 4),
      stepTokens: Math.ceil((steps.length + 2) / 4),
      recentTokens: Math.ceil((recent.length + 2) / 4),
      omissionTokens: Math.ceil((notice.length + 2) / 4),
    });
    expect(breakdown.totalTokens).toBeLessThanOrEqual(30_000);
    expect(breakdown.memoryTokens).toBeLessThanOrEqual(3_000);
    expect(breakdown.excerptTokens).toBeLessThanOrEqual(4_000);
    expect(breakdown.stepTokens).toBeLessThanOrEqual(2_000);
    expect(breakdown.recentTokens).toBeLessThanOrEqual(20_000);
    expect(breakdown.omissionTokens).toBeLessThanOrEqual(1_000);
  });

  it("includes the newest message even when its metadata alone exceeds the budget", () => {
    const { text, breakdown } = buildHandoff({
      transcript: [
        {
          ...user("message-" + "i".repeat(90_000), "Keep this latest request."),
          author: { id: "reader", name: "A".repeat(90_000) },
          timestamp: 0,
        },
      ],
    });

    expect(text.startsWith("## Recent messages\n[message-")).toBe(true);
    expect(
      text.includes(
        "] user · 1970-01-01T00:00:00.000Z\nKeep this latest request."
      )
    ).toBe(true);
    expect(breakdown.recentTokens).toBeLessThanOrEqual(20_000);
  });

  it("returns just the recovery notice for an empty transcript without memory", () => {
    expect(buildHandoff({ transcript: [] })).toEqual({
      text:
        "## Omission notice\n" +
        "0 messages before the recent window.\n" +
        "0 omitted user messages not carried.\n" +
        "Use the session_history tool’s search action to recover originals. Bracketed IDs identify the originals.",
      breakdown: {
        totalTokens: 50,
        memoryTokens: 0,
        excerptTokens: 0,
        stepTokens: 0,
        recentTokens: 0,
        omissionTokens: 50,
      },
    });
  });

  it("preserves a recoverable result ID when the tool name takes too much space", () => {
    const resultId = "result-" + "r".repeat(1500);
    const { text, breakdown } = buildHandoff({
      transcript: [
        user("initial", "Check inventory."),
        {
          ...assistant("omitted-call", ""),
          toolCalls: [
            {
              callId: "lookup-call",
              name: "inventory-" + "x".repeat(3000),
              arguments: {},
              result: { id: resultId, text: "Found", isError: false },
            },
          ],
        },
        ...padding,
      ],
    });

    const notice = text.split("## Omission notice\n")[1];
    expect(
      notice.includes(`Latest omitted tool output: [${resultId}] inventory-`)
    ).toBe(true);
    expect(notice).toMatch(/… \(5 chars\)\./);
    expect(breakdown.omissionTokens).toBeLessThanOrEqual(1000);
  });

  it("uses the fallback label for a tool with no stored template", () => {
    const { text } = buildHandoff({
      transcript: [
        {
          ...assistant("call", ""),
          toolCalls: [
            { callId: "tool-call", name: "constructor", arguments: {} },
          ],
        },
      ],
      templates: {},
    });

    expect(text).toContain("[call] → constructor (no result)");
  });
});
