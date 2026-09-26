import path from "node:path";
import { describe, expect, it } from "vitest";
import { getBuiltInSkillsDir } from "../skills.js";

describe("getBuiltInSkillsDir", () => {
  it("resolves skill assets beside the compiled runner", () => {
    expect(getBuiltInSkillsDir()).toBe(
      path.resolve(import.meta.dirname, "../skills")
    );
  });
});
