import { describe, expect, it } from "vitest";
import { matchSession } from "./session-search.js";

describe("session search", () => {
  it("matches every word across user and assistant text, regardless of order or case", () => {
    expect(
      matchSession(
        "Database notes",
        [
          {
            role: "user",
            content: [{ type: "text", text: "How does PgBouncer work?" }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Connection pooling saves resources." },
            ],
          },
        ],
        "POOLING pgbouncer"
      )
    ).toEqual({ match: "content", snippet: "How does PgBouncer work?" });
  });
});

it("chooses the message containing most query words and centers a one-line snippet on its first hit", () => {
  const result = matchSession(
    "Database notes",
    [
      { role: "user", content: [{ type: "text", text: "PgBouncer question" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${"before ".repeat(35)}PgBouncer\n poolING ${"after ".repeat(35)}`,
          },
        ],
      },
    ],
    "pooling pgbouncer"
  );
  expect(result?.match).toBe("content");
  expect(result?.snippet).toContain("PgBouncer poolING");
  expect(result?.snippet).toMatch(/^….*…$/);
  expect(result?.snippet?.length).toBeLessThanOrEqual(162);
});

it("classifies the shown label, rejects missing words and ignores empty queries and non-chat blocks", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "visible user text" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        {
          type: "toolCall",
          name: "secrettool",
          arguments: { value: "hiddenargument" },
        },
        { type: "thinking", thinking: "hiddenthought" },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "hiddenresult" }] },
    { role: "system", content: [{ type: "text", text: "hiddensystem" }] },
  ];
  expect(
    matchSession("PgBouncer pooling notes", messages, "POOLING pgbouncer")
  ).toEqual({ match: "title" });
  expect(
    matchSession(
      "assistant-only-42",
      [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
      "only-42"
    )
  ).toEqual({ match: "title" });
  for (const query of [
    "visible missing",
    "hiddenargument",
    "hiddenthought",
    "hiddenresult",
    "hiddensystem",
    "secrettool",
    " \t\n ",
  ]) {
    expect(matchSession("Notes", messages, query)).toBeNull();
  }
});
