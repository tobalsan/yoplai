import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it("accepts relative paths with query strings", () => {
    expect(safeReturnTo("?returnTo=%2Fchat%2Fhenry%3Fsession%3Dnew")).toBe(
      "/chat/henry?session=new"
    );
  });

  it("keeps the request of a gateway link consent page through the login redirect", () => {
    expect(safeReturnTo("?returnTo=%2Fgateway-link%3Frequest%3Dabc_DEF-123")).toBe("/gateway-link?request=abc_DEF-123");
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
