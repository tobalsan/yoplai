import { describe, expect, it } from "vitest";
import { toolCallMilestone } from "./tool-milestones.js";

describe("toolCallMilestone", () => {
  it.each(["task.checkpoint", "task.start", "task_checkpoint", "task_list"])(
    "returns undefined for task lifecycle tool %s",
    (name) => {
      expect(toolCallMilestone(name)).toBeUndefined();
    }
  );

  it.each([
    ["read", "Reading files"],
    ["write", "Editing files"],
    ["edit", "Editing files"],
    ["bash", "Running commands"],
    ["extract_document", "Reading documents"],
    ["describe_image", "Looking at an image"],
    ["notion_search", "Working in Notion"],
    ["slack_post_message", "Using Slack"],
    ["pennylane_get_invoice", "Working in Pennylane"],
    ["pipedrive_get_deal", "Working in Pipedrive"],
    ["scheduler_create_job", "Managing scheduled jobs"],
    ["web_search", "Searching the web"],
    ["websearch", "Searching the web"],
    ["fetch", "Searching the web"],
    ["fetch_url", "Searching the web"],
  ])("maps %s to %s", (name, expected) => {
    expect(toolCallMilestone(name)).toBe(expected);
  });

  it.each([
    ["slack.send_message", "Using Slack"],
    ["notion.query", "Working in Notion"],
    ["pennylane-get-invoice", "Working in Pennylane"],
  ])("normalizes dot/dash separators before matching: %s to %s", (name, expected) => {
    expect(toolCallMilestone(name)).toBe(expected);
  });

  it("humanizes unknown tool names", () => {
    expect(toolCallMilestone("google_sheets_append")).toBe(
      "Using google sheets append"
    );
  });

  it("strips a module prefix before the first dot when humanizing", () => {
    expect(toolCallMilestone("mcp.custom_tool_name")).toBe(
      "Using custom tool name"
    );
  });
});
