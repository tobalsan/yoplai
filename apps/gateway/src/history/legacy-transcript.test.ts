import { expect, it } from "vitest";
import { buildHandoff } from "./handoff.js";
import { legacyTranscript, parseHistoryJsonl } from "./legacy-transcript.js";

const raw = `{"type":"history","agentId":"tiles","sessionId":"old-chat","timestamp":3000,"role":"assistant","content":[{"type":"text","text":"The blue tiles are in stock."}]}
{"type":"history","agentId":"tiles","sessionId":"old-chat","timestamp":0,"role":"system","content":[{"type":"text","text":"A generated summary."}],"compaction":{"id":"marker","coveredThrough":0}}
{"type":"history","agentId":"tiles","sessionId":"old-chat","timestamp":1000,"role":"user","content":[{"type":"text","text":"  Keep the blue tiles."},{"type":"file","fileId":"image","filename":"sample.png","mimeType":"image/png","size":12,"direction":"inbound"},{"type":"file","fileId":"document","filename":"notes.txt","mimeType":"text/plain","size":15,"direction":"inbound"},{"type":"text","text":"Second line. "}]}
{"type":"history","agentId":"tiles","sessionId":"old-chat","timestamp":2000,"role":"assistant","content":[{"type":"thinking","thinking":"Private scratchpad"},{"type":"text","text":"Checking stock."},{"type":"toolCall","id":"stock","name":"read","arguments":{"path":"stock.txt"}},{"type":"toolCall","id":"verify","name":"verify","arguments":{}}]}
{"type":"history","agentId":"tiles","sessionId":"old-chat","timestamp":2000,"role":"toolResult","toolCallId":"stock","toolName":"read","isError":false,"content":[{"type":"text","text":"Found stock"}]}
{"type":"meta","key":"thinkingLevel","value":"high","timestamp":1800}
this line is malformed`;

it("converts a legacy history file to a verbatim handoff with ordered public anchors", () => {
  const { messages, errors } = parseHistoryJsonl(raw);
  expect(errors).toEqual([expect.stringMatching(/^SyntaxError:/)]);
  expect(messages.map(({ role }) => role)).toEqual([
    "system",
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  const transcript = legacyTranscript(messages, {
    agentId: "tiles",
    sessionId: "old#chat%23",
  });
  expect(transcript).toEqual([
    {
      id: "legacy:tiles:old%23chat%2523#1",
      role: "user",
      text: "Keep the blue tiles.\n[image sample.png]\n[file notes.txt]\nSecond line.",
      timestamp: 1000,
    },
    {
      id: "legacy:tiles:old%23chat%2523#2",
      role: "assistant",
      text: "Checking stock.",
      timestamp: 2000,
      toolCalls: [
        {
          callId: "stock",
          name: "read",
          arguments: { path: "stock.txt" },
          result: {
            id: "legacy:tiles:old%23chat%2523#3",
            text: "Found stock",
            isError: false,
          },
        },
        { callId: "verify", name: "verify", arguments: {} },
      ],
    },
    {
      id: "legacy:tiles:old%23chat%2523#4",
      role: "assistant",
      text: "The blue tiles are in stock.",
      timestamp: 3000,
    },
  ]);
  expect(buildHandoff({ transcript }).text).toBe(`## Condensed steps
[legacy:tiles:old%23chat%2523#2] → Read stock.txt (ok, 11 chars)
[legacy:tiles:old%23chat%2523#2] → verify (no result)

## Recent messages
[legacy:tiles:old%23chat%2523#1] user · 1970-01-01T00:00:01.000Z
Keep the blue tiles.
[image sample.png]
[file notes.txt]
Second line.

[legacy:tiles:old%23chat%2523#2] assistant · 1970-01-01T00:00:02.000Z
Checking stock.

[legacy:tiles:old%23chat%2523#4] assistant · 1970-01-01T00:00:03.000Z
The blue tiles are in stock.

## Omission notice
0 messages before the recent window.
0 omitted user messages not carried.
Use the session_history tool’s search action to recover originals. Bracketed IDs identify the originals.`);
});
