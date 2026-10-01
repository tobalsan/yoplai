import { describe, expect, it } from "vitest";
import {
  fallbackToolLabel,
  fillToolLabelTemplate,
  humanizeToolName,
  toolLabel,
  validateToolLabelTemplate,
} from "./tool-labels.js";

describe("tool labels", () => {
  it("humanizes names", () => {
    expect(humanizeToolName("mcp__claap__list_workspaces")).toBe("Claap · list workspaces");
    expect(humanizeToolName("getUserInfo")).toBe("Get user info");
  });

  it("falls back with key args for common tools", () => {
    expect(fallbackToolLabel("bash", { command: "ls -la" })).toBe("Ran `ls -la`");
    expect(fallbackToolLabel("read", { path: "/a/b/c.ts" })).toBe("Read c.ts");
    expect(fallbackToolLabel("edit", { path: "/a/c.ts" })).toBe("Edited c.ts");
    expect(fallbackToolLabel("write", { path: "/a/c.ts" })).toBe("Wrote c.ts");
    expect(fallbackToolLabel("grep", { pattern: "foo" })).toBe("Searched for foo");
    expect(fallbackToolLabel("read", {})).toBe("Called tool: Read");
  });

  it("validates templates", () => {
    expect(validateToolLabelTemplate('"Fetched {id}"', ["id"])).toBe("Fetched {id}");
    expect(validateToolLabelTemplate("Fetched {nope}", ["id"])).toBeNull();
    expect(validateToolLabelTemplate("x".repeat(81), [])).toBeNull();
    expect(validateToolLabelTemplate("  ", [])).toBeNull();
  });

  it("fills templates and truncates values", () => {
    expect(fillToolLabelTemplate("Got {id}", { id: 7 })).toBe("Got 7");
    expect(fillToolLabelTemplate("Got {id}", {})).toBeNull();
    expect(fillToolLabelTemplate("Got {id}", { id: "y".repeat(100) })?.length).toBe(64);
  });

  it("uses template, else fallback", () => {
    const templates = { t: "Did {a}" };
    expect(toolLabel("t", { a: "x" }, templates)).toBe("Did x");
    expect(toolLabel("t", {}, templates)).toBe("Called tool: T");
    expect(toolLabel("other_tool", {}, templates)).toBe("Called tool: Other tool");
  });

  it("ignores templates for built-in tools", () => {
    const templates = { bash: "Ran bash command" };
    expect(toolLabel("bash", { command: "ls" }, templates)).toBe("Ran `ls`");
  });
});
