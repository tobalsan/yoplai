import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FeedWindow } from "@yoplai/shared";
import { expect, it } from "vitest";
import { sessionHistoryExtension } from "../session-history/index.js";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

function startGateway(multiUser: boolean) {
  return startDurableTestGateway({
    multiUser,
    legacyAnswer: "Legacy archive opened.",
    fixtureExtensions: [sessionHistoryExtension],
    extraYaml: "toolDeferral: { enabled: false }",
  });
}

it.each([false, true])("lists the caller's Main (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    gateway.script({ tool: "session_history", args: { action: "list" } }, "Main listed.");
    expect((await gateway.send(user, "Check the orchard", { clientSendId: "list" })).status).toBe(200);
    const results = gateway.requests.at(-1)?.messages.filter((message) => message.role === "toolResult");
    expect(results).toMatchObject([{
      toolName: "session_history",
      isError: false,
      content: [{ text: expect.stringMatching(
        /^durable-main · \d{4}-\d\d-\d\d \d\d:\d\d · 2 msgs · Check the orchard ★ CURRENT CONVERSATION$/,
      ) }],
    }]);
  } finally {
    await gateway.close();
  }
}, 20000);

const feed = "/api/agents/pilot/feed";

async function cutMain(gateway: Awaited<ReturnType<typeof startGateway>>, user: "local" | "alice") {
  gateway.script(
    { content: "The inventory code is Periwinkle.", usage: { input: 200 } },
    { content: "Archive ready. " + "crate ".repeat(1000), usage: { input: 5300 } },
    { content: "Archive verified.", usage: { input: 344 } },
  );
  expect((await gateway.send(user, "Open the crate archive.", { clientSendId: "open" })).status).toBe(200);
  expect((await gateway.send(user, "Prepare the archive.", { clientSendId: "prepare" })).status).toBe(200);
  expect((await gateway.send(user, "Verify the archive.", { clientSendId: "verify" })).status).toBe(200);

  const afterCut = gateway.requests.at(-1)?.messages;
  expect(afterCut).toBeDefined();
  expect(JSON.stringify(afterCut)).not.toContain("Periwinkle");
  const snapshot: FeedWindow = await (await gateway.request(user, feed)).json();
  expect(snapshot.items.map(({ role }) => role)).toEqual([
    "user", "assistant", "user", "assistant", "user", "seam", "assistant",
  ]);
  return { afterCut: afterCut!, items: snapshot.items };
}

function lastToolResult(gateway: Awaited<ReturnType<typeof startGateway>>) {
  return gateway.requests.at(-1)?.messages.filter((message) => message.role === "toolResult").at(-1);
}

it.each([false, true])("searches before a context cut with feed IDs (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const { items } = await cutMain(gateway, user);
    const original = items.find(({ text }) => text === "The inventory code is Periwinkle.");
    expect(original?.id).toMatch(/^m_\d+$/);
    gateway.script(
      { tool: "session_history", args: { action: "search", query: "PERIWINKLE", role: "assistant", limit: 1 } },
      "Inventory code recovered.",
    );
    expect((await gateway.send(user, "Recover the inventory code.", { clientSendId: "search" })).status).toBe(200);
    const result = lastToolResult(gateway);
    expect(result).toMatchObject({ toolName: "session_history", isError: false });
    const text = result?.content[0];
    expect(text).toMatchObject({ text: expect.stringContaining("every message can be read here") });
    expect(text).toMatchObject({ text: expect.stringMatching(new RegExp(
      `\\[${original?.id}\\] asst .*  The inventory code is Periwinkle\\.`,
    )) });
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("opens the summary's older request across a seam (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const { afterCut, items } = await cutMain(gateway, user);
    const [, summary] = afterCut;
    expect(summary).toMatchObject({ role: "user" });
    const content = summary?.role === "user" ? summary.content : [];
    const text = typeof content === "string" ? content : content.map((block) => block.type === "text" ? block.text : "").join("\n");
    expect(text.split("\n").find((line) => line.includes("Answer the latest request")))
      .toContain("Open any bracketed request with session_history read, around: <id>.");
    const id = text.match(/^\[(m_\d+)\].*Open the crate archive\.$/m)?.[1];
    expect(id).toBe(items[0]?.id);
    gateway.script({ tool: "session_history", args: { action: "read", around: id! } }, "Archive discussion recovered.");
    expect((await gateway.send(user, "Recover the archive discussion.", { clientSendId: "around" })).status).toBe(200);
    const result = lastToolResult(gateway);
    expect(result).toMatchObject({ toolName: "session_history", isError: false });
    const block = result?.content[0];
    const lines = block?.type === "text" ? block.text.split("\n") : [];
    expect(lines).toContainEqual(expect.stringContaining("every message can be read here"));
    expect(lines.filter((line) => line.startsWith("[m_") || line === "— context was cut here —")).toEqual([
      expect.stringMatching(new RegExp(`^\\[${id}\\] user .*  Open the crate archive\\.$`)),
      expect.stringContaining("The inventory code is Periwinkle."),
      expect.stringContaining("Prepare the archive."),
      expect.stringContaining("Archive ready."),
      expect.stringContaining("Verify the archive."),
      "— context was cut here —",
      expect.stringMatching(new RegExp(`^\\[${items.at(-1)?.id}\\] asst .*  Archive verified\\.$`)),
    ]);

    gateway.script(
      { tool: "session_history", args: { action: "read", around: id!, role: "user" } },
      "Archive requests recovered.",
    );
    expect((await gateway.send(user, "Recover only archive requests.", { clientSendId: "user-window" })).status).toBe(200);
    const userWindow = lastToolResult(gateway)?.content[0];
    expect(userWindow).toMatchObject({ text: expect.stringMatching(/Verify the archive\.\n— context was cut here —$/) });
  } finally {
    await gateway.close();
  }
}, 20000);

it.each([false, true])("restricts tool results to the caller's Main (multi-user: %s)", async (multiUser) => {
  const gateway = await startGateway(multiUser);
  const user = multiUser ? "alice" : "local";
  try {
    const project = await gateway.request(user, "/api/chat-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Private archives" }),
    });
    expect(project.status).toBe(201);
    const { id: projectId } = await project.json();
    const legacy = await gateway.send(user, "The project code is Zircon.", { sessionId: "project-archive", projectId });
    expect(legacy.status).toBe(200);
    const { meta: { sessionId } } = await legacy.json() as { meta: { sessionId: string } };
    expect((await gateway.history(user, "?sessionId=" + sessionId)).messages).toMatchObject([
      { role: "user", content: "The project code is Zircon." },
      { role: "assistant", content: "Legacy archive opened." },
    ]);

    let foreignId: string | undefined;
    if (multiUser) {
      gateway.script("Bob's inventory code is Quartz.");
      expect((await gateway.send("bob", "Record Bob's inventory code.", { clientSendId: "bob" })).status).toBe(200);
      const bob: FeedWindow = await (await gateway.request("bob", feed)).json();
      expect(bob.items[1]).toMatchObject({ id: expect.stringMatching(/^m_\d+$/), text: "Bob's inventory code is Quartz." });
      foreignId = bob.items[1]!.id;
    }

    const lookups: { args: Record<string, string>; expected: string | RegExp }[] = [
      { args: { action: "search", query: "Zircon" }, expected: /no matches$/ },
      { args: { action: "read", session: sessionId }, expected: `no such session: ${sessionId}` },
      { args: { action: "read", session: "other/durable-main" }, expected: "no such session: other/durable-main" },
    ];
    if (foreignId) lookups.push(
      { args: { action: "search", query: "Quartz" }, expected: /no matches$/ },
      { args: { action: "read", around: foreignId }, expected: new RegExp(`no message ${foreignId}$`) },
    );
    for (const [index, { args, expected }] of lookups.entries()) {
      gateway.script({ tool: "session_history", args }, "Lookup complete.");
      expect((await gateway.send(user, "Look up an archive reference.", { clientSendId: `lookup-${index}` })).status).toBe(200);
      expect(lastToolResult(gateway)).toMatchObject({
        toolName: "session_history", isError: false,
        content: [{ text: expected instanceof RegExp ? expect.stringMatching(expected) : expected }],
      });
    }
  } finally {
    await gateway.close();
  }
}, 20000);

it("reports invalid filters and anchors and continues the turn", async () => {
  const gateway = await startGateway(false);
  try {
    gateway.script(
      { tool: "session_history", args: { action: "search", query: "archive", tool: "read" } },
      { tool: "session_history", args: { action: "read", around: "banana" } },
      { tool: "session_history", args: { action: "list", until: "not-a-date" } },
      { tool: "session_history", args: { action: "list" } },
      "Valid lookup complete.",
    );
    const response = await gateway.send("local", "Check the archive.", { clientSendId: "invalid" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payloads: [{ text: "Valid lookup complete." }] });
    const results = gateway.requests.at(-1)?.messages.filter((message) => message.role === "toolResult");
    expect(results).toMatchObject([
      { isError: true, content: [{ text: expect.stringMatching(/invalid_input.*tool filter/) }] },
      { isError: true, content: [{ text: expect.stringMatching(/invalid_input.*Expected a message ID/) }] },
      { isError: true, content: [{ text: expect.stringMatching(/invalid_input.*Invalid until date/) }] },
      { isError: false, content: [{ text: expect.stringContaining("★ CURRENT CONVERSATION") }] },
    ]);
  } finally {
    await gateway.close();
  }
}, 20000);

it("paginates newest-first reads and keeps the around anchor within the budget", async () => {
  const gateway = await startGateway(false);
  try {
    gateway.script(...Array.from({ length: 26 }, (_, i) => `Crate ${i}: ${"checked ".repeat(45)}`));
    for (let i = 0; i < 26; i++) {
      expect((await gateway.send("local", `Inspect crate ${i}.`, { clientSendId: `crate-${i}` })).status).toBe(200);
    }
    const snapshot: FeedWindow = await (await gateway.request("local", feed + "?limit=100")).json();
    const archive = snapshot.items.filter(({ role }) => role === "assistant");
    expect(archive).toHaveLength(26);
    gateway.script({ tool: "session_history", args: { action: "read", role: "assistant" } }, "Recent crates listed.");
    expect((await gateway.send("local", "List recent inspections.", { clientSendId: "newest" })).status).toBe(200);
    const block = lastToolResult(gateway)?.content[0];
    const result = block?.type === "text" ? block.text : "";
    const firstShown = result.match(/^\[(m_\d+)\] asst .*Crate/m)?.[1];
    const to = result.match(/more: read (?:session=durable-main )?to=(m_\d+) role=assistant$/m)?.[1];
    const previous = archive.findIndex(({ id }) => id === to);
    expect(previous).toBeGreaterThan(10);
    expect(archive[previous + 1]?.id).toBe(firstShown);
    expect(result).toContain(`read full=${archive.at(-1)?.id}]`);
    expect(result).toContain("Crate 25:");
    expect(result).not.toContain("Crate 0:");
    expect(result.length).toBeLessThan(4300);

    gateway.script({ tool: "session_history", args: { action: "read", to: to!, role: "assistant" } }, "Earlier crates listed.");
    expect((await gateway.send("local", "Continue the inspection list.", { clientSendId: "older" })).status).toBe(200);
    const next = lastToolResult(gateway)?.content[0];
    const rows = next?.type === "text" ? next.text.split("\n").filter((line) => line.startsWith("[m_")) : [];
    expect(rows.at(-1)).toContain(`[${to}] asst`);
    expect(rows.at(-1)).toContain(`Crate ${previous}:`);
    expect(rows.join("\n")).not.toContain(`[${firstShown}]`);

    const center = archive[13]!.id;
    gateway.script(
      { tool: "session_history", args: { action: "read", around: center, n: 50, role: "assistant" } },
      "Archive opened.",
    );
    expect((await gateway.send("local", "Open the center of the archive.", { clientSendId: "center" })).status).toBe(200);
    const centered = lastToolResult(gateway)?.content[0];
    const centeredText = centered?.type === "text" ? centered.text : "";
    expect(centeredText).toContain(`[${center}] asst`);
    expect(centeredText).toContain("Crate 12:");
    expect(centeredText).toContain("Crate 14:");
    expect(centeredText.length).toBeLessThan(4300);
  } finally {
    await gateway.close();
  }
}, 20000);

it("reads inclusive ranges and expands only public text and tool names", async () => {
  const gateway = await startDurableTestGateway({
    fixtureExtensions: [sessionHistoryExtension],
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: {
      invisibleTools: ["private_probe"],
      extension: defineExtension({
        name: "private-history-fixture",
        tools: [defineTool({
          name: "private_probe", description: "Check a private marker", parameters: { type: "object" },
          async execute() { return { output: [{ type: "text", text: "Private canary" }], details: { hidden: true } }; },
        })],
      }),
    },
  });
  try {
    gateway.script(
      { tool: "session_history", args: { action: "list" } },
      { tool: "private_probe" },
      "Crate report. " + "x".repeat(8200) + " Beyond the cap.",
    );
    expect((await gateway.send("local", "Inspect the crate.", { clientSendId: "inspect" })).status).toBe(200);
    const snapshot: FeedWindow = await (await gateway.request("local", feed)).json();
    const [request, answer] = snapshot.items;
    expect(answer).toMatchObject({ role: "assistant", toolCallCount: 1 });
    const cases: { args: Record<string, string>; mode: string }[] = [
      { args: { from: request!.id, to: answer!.id, role: "assistant" }, mode: "range" },
      { args: { full: answer!.id }, mode: "full" },
    ];
    for (const { args, mode } of cases) {
      gateway.script({ tool: "session_history", args: { action: "read", ...args } }, "Report inspected.");
      expect((await gateway.send("local", "Recall the crate report.", { clientSendId: mode })).status).toBe(200);
      const result = lastToolResult(gateway);
      expect(result).toMatchObject({ isError: false });
      const block = result?.content[0];
      const text = block?.type === "text" ? block.text : "";
      expect(text).toContain(`[${answer!.id}] asst`);
      expect(text).toContain("· 1 tool calls");
      expect(text).not.toMatch(/private_probe|Private canary|Beyond the cap\./);
      if (mode === "range") {
        expect(text).toContain(`read full=${answer!.id}]`);
        expect(text).not.toContain(`[${request!.id}]`);
      } else {
        expect(text).toContain("Crate report. " + "x".repeat(7986) + "… [truncated at 8000 chars]");
        expect(text).toContain("    → session_history");
      }
    }
  } finally {
    await gateway.close();
  }
}, 20000);
