import { describe, expect, it } from "vitest";
import {
  buildSlackContext,
  buildTelegramContext,
  buildUserContext,
  renderAgentContext,
} from "./context-rendering.js";

describe("renderAgentContext web user context", () => {
  it("renders the web user context block", () => {
    expect(renderAgentContext(buildUserContext({ name: "Thinh" }))).toBe(
      [
        "[USER CONTEXT]",
        "context: web UI",
        "name: Thinh",
        "[END USER CONTEXT]",
      ].join("\n")
    );
  });

  it("falls back when the user name is missing", () => {
    expect(renderAgentContext(buildUserContext({ name: undefined }))).toContain(
      "name: unknown"
    );
  });
});

describe("renderAgentContext telegram context", () => {
  it("renders a telegram DM context block", () => {
    const rendered = renderAgentContext(
      buildTelegramContext({
        metadata: {
          channel: "telegram",
          place: "direct message / alice",
          conversationType: "direct_message",
          sender: "alice",
        },
      })
    );
    expect(rendered).toContain("channel: telegram");
    expect(rendered).toContain("conversation_type: direct_message");
    expect(rendered).toContain("sender: alice");
    expect(rendered).toContain("recent_history:");
  });

  it("renders history entries when provided", () => {
    const rendered = renderAgentContext(
      buildTelegramContext({
        metadata: {
          channel: "telegram",
          place: "direct message / alice",
          conversationType: "direct_message",
          sender: "alice",
        },
        history: [{ author: "alice", content: "hi", timestamp: 0 }],
      })
    );
    expect(rendered).toContain("alice: hi");
  });

  it("returns empty string without metadata", () => {
    expect(renderAgentContext(buildTelegramContext({}))).toBe("");
  });
});

describe("renderAgentContext slack sender identity", () => {
  const metadata = { channel: "slack" as const, place: "#ops", conversationType: "channel_message" as const, sender: "Thinh" };

  it("tells the model an unpaired sender should use !pair", () => {
    const rendered = renderAgentContext(buildSlackContext({ metadata, unpairedSender: true }));
    expect(rendered).toContain("sender_identity: unpaired");
    expect(rendered).toContain("`!pair`");
  });

  it("omits the note for paired senders", () => {
    expect(renderAgentContext(buildSlackContext({ metadata }))).not.toContain("sender_identity");
  });
});
