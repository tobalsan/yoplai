import { describe, expect, it } from "vitest";
import { decodeSkillId, encodeSkillId } from "./skill-id-wire.js";

const bytesToWire = (bytes: number[]) => "v1_" + Buffer.from(bytes).toString("base64url");

describe("skill ID wire codec", () => {
  it.each([
    "mine-skill",
    "agent:iris:team/review",
    "agent:iris:a/b/c/SKILL",
    "default:notes",
    "100%25 literal",
    "%2F%5C..%2e",
    "name@east",
    "agent:ams@east:team/review",
    "../import",
    "import",
    "Ünï-cødé/日本語/🙂",
    "  spaces  ",
    "a".repeat(5000),
  ])("round-trips %j exactly", (id) => {
    const wire = encodeSkillId(id);
    expect(wire).toMatch(/^v1_[A-Za-z0-9_-]+$/);
    expect(decodeSkillId(wire)).toBe(id);
  });

  it("changes no case and decodes only once", () => {
    const wire = encodeSkillId("Agent:Iris:Team/%2f");
    expect(decodeSkillId(wire)).toBe("Agent:Iris:Team/%2f");
    // The decoded text is never decoded again, so a nested wire form stays text.
    const nested = encodeSkillId(wire);
    expect(decodeSkillId(nested)).toBe(wire);
  });

  it.each(["\ufeffa", "a\ufeffb", "\ufeff", "\ufeff\ufeffagent:x/y", "agent:x/\ufeffy"])("round-trips U+FEFF exactly in %j", (id) => {
    const wire = encodeSkillId(id);
    expect(decodeSkillId(wire)).toBe(id);
    expect(decodeSkillId(wire)?.length).toBe(id.length);
  });

  it("rejects the bytes of a byte order mark only when the encoding is not canonical", () => {
    // The bytes EF BB BF 61 are the canonical encoding of the ID with a leading U+FEFF, so they decode to it.
    expect(decodeSkillId(bytesToWire([0xef, 0xbb, 0xbf, 0x61]))).toBe("\ufeffa");
  });

  it("rejects an empty ID and an ID with a lone surrogate on encode", () => {
    expect(() => encodeSkillId("")).toThrow();
    expect(() => encodeSkillId("a\uD800b")).toThrow();
    expect(() => encodeSkillId("a\uDC00b")).toThrow();
  });

  it.each([
    ["an empty value", ""],
    ["the prefix alone", "v1_"],
    ["an unknown version", "v2_" + Buffer.from("abc").toString("base64url")],
    ["a missing version", Buffer.from("abc").toString("base64url")],
    ["an upper-case version", "V1_" + Buffer.from("abc").toString("base64url")],
    ["padding", "v1_" + Buffer.from("a").toString("base64")],
    ["a percent escape", "v1_YWJj%2F"],
    ["a slash", "v1_YW/j"],
    ["a plus sign", "v1_YW+j"],
    ["a dot", "v1_YW.j"],
    ["whitespace", "v1_YWJj "],
    ["an extra separator", "v1_YWJj/extra"],
    ["one leftover character", "v1_YWJjZ"],
    ["noncanonical trailing bits", "v1_YR"],
    ["malformed UTF-8", bytesToWire([0xff, 0xfe])],
    ["an overlong UTF-8 form", bytesToWire([0xc0, 0xaf])],
    ["a UTF-16 surrogate in UTF-8", bytesToWire([0xed, 0xa0, 0x80])],
  ])("rejects %s", (_name, wire) => {
    expect(decodeSkillId(wire)).toBeUndefined();
  });
});
