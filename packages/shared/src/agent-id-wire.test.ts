import { describe, expect, it } from "vitest";
import { addGatewaySuffix, isCarriedPathSegment, isSupportedRemoteAgentId, splitGatewaySuffix } from "./agent-id-wire.js";

describe("qualified agent IDs", () => {
  it("adds and splits a linked gateway suffix", () => {
    expect(addGatewaySuffix("pom", "ams")).toBe("pom@ams");
    expect(splitGatewaySuffix("pom@ams", ["ams"])).toEqual({ agentId: "pom", gateway: "ams" });
  });

  it("reads only the text after the last @, and only for a linked gateway", () => {
    expect(splitGatewaySuffix("a@b@ams", ["ams"])).toEqual({ agentId: "a@b", gateway: "ams" });
    expect(splitGatewaySuffix("pom@other", ["ams"])).toEqual({ agentId: "pom@other" });
    expect(splitGatewaySuffix("pom", ["ams"])).toEqual({ agentId: "pom" });
    expect(splitGatewaySuffix("@ams", ["ams"])).toEqual({ agentId: "@ams" });
  });
});

describe("supported remote agent IDs", () => {
  it.each(["pom", "a@b", "with space", "Ünï-cødé-日本語", "🙂", "a.b", "...", "a:b", "a&b=c", "a+b", "a'b", "a\"b"])(
    "accepts %s",
    (id) => expect(isSupportedRemoteAgentId(id)).toBe(true)
  );

  it.each(["", ".", "..", "a/b", "a\\b", "a%b", "a%2Fb", "a?b", "a#b", "a\nb", "a\u0000b", "a\u007Fb", "\ud800"])(
    "rejects %j",
    (id) => expect(isSupportedRemoteAgentId(id)).toBe(false)
  );

  it("uses the same segment rule as the outbound path guard", () => {
    expect(isCarriedPathSegment("a b")).toBe(true);
    expect(isCarriedPathSegment("..")).toBe(false);
    expect(isCarriedPathSegment("a/b")).toBe(false);
  });
});
