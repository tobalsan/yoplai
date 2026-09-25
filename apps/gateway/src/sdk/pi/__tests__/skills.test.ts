import path from "node:path";
import { describe, expect, it } from "vitest";
import { getBuiltInSkillsDir } from "../skills.js";

describe("getBuiltInSkillsDir", () => {
  it("resolves the gateway skill assets beside source or compiled code", () => {
    expect(getBuiltInSkillsDir()).toBe(
      path.resolve(import.meta.dirname, "../../../skills")
    );
  });
});
