import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it("accepts relative paths with query strings", () => {
    expect(safeReturnTo("?returnTo=%2Fchat%2Fhenry%3Fsession%3Dnew")).toBe(
      "/chat/henry?session=new"
    );
  });

  it.each([
    "//evil.com",
    "//return-to.invalid/path",
    "//[",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "https://evil.com",
  ])(
    "rejects external destination %s",
    (returnTo) => {
      expect(safeReturnTo(`?returnTo=${encodeURIComponent(returnTo)}`)).toBeNull();
    }
  );

  it("returns null when returnTo is absent", () => {
    expect(safeReturnTo("")).toBeNull();
  });
});
