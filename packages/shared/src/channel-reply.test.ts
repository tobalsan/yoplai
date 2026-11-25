import { expect, it } from "vitest";
import { limitChannelReply } from "./channel-reply.js";

it("keeps a feed link outside a truncated Markdown code block", () => {
  const link = "[Open](https://garden.example.test)";
  const markdown = "````text\n" + "fern ".repeat(40) + "\n````";
  const reply = limitChannelReply(markdown, 80, link);
  expect(reply).toMatch(/\n````\n…\n\n\[Open\]\(https:\/\/garden\.example\.test\)$/);
  expect(reply.length).toBeLessThanOrEqual(80);
});

it("truncates without a configured feed URL and preserves short replies", () => {
  expect(limitChannelReply("Ferns grew.", 30)).toBe("Ferns grew.");
  expect(limitChannelReply("Ferns outgrew the box.", 10)).toBe("Ferns out…");
});

it("keeps the link outside a closing fence at the cut point", () => {
  const reply = limitChannelReply("```\nx\n```\n" + "fern ".repeat(40), 34, "[Open](https://x.test)");
  expect(reply).toMatch(/\n```\n…\n\n\[Open\]\(https:\/\/x\.test\)$/);
  expect(reply.length).toBeLessThanOrEqual(34);
});
