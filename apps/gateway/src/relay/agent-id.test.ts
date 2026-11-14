import { describe, expect, it } from "vitest";
import { addGatewaySuffix, removeGatewaySuffix } from "./agent-id.js";

describe("remote agent id", () => {
  it("adds the gateway name after an @", () => {
    expect(addGatewaySuffix("pom", "ams")).toBe("pom@ams");
  });

  it("removes the suffix of a linked gateway", () => {
    expect(removeGatewaySuffix("pom@ams", ["ams"])).toEqual({
      agentId: "pom",
      gateway: "ams",
    });
  });

  it("keeps an id whose last @ text is not a linked gateway", () => {
    expect(removeGatewaySuffix("pom@other", ["ams"])).toEqual({
      agentId: "pom@other",
    });
    expect(removeGatewaySuffix("pom", ["ams"])).toEqual({ agentId: "pom" });
  });

  it("reads only the text after the last @", () => {
    expect(removeGatewaySuffix("a@b@ams", ["ams"])).toEqual({
      agentId: "a@b",
      gateway: "ams",
    });
  });
});
