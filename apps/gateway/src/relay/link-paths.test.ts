import { describe, expect, it } from "vitest";
import { ownsLinkPath, ownsRemoteLinkPath } from "./link-paths.js";

describe("ownsRemoteLinkPath", () => {
  it.each([
    "/api/auth/gateway-link",
    "/api/auth/gateway-link/requests/abc",
    "/api/auth/gateway-link/token",
    "/API/AUTH/Gateway-Link/token",
    "/api/auth/gateway%2Dlink/token",
    "/api/auth%2Fgateway-link%2Ftoken",
    "/api/auth/gateway-link%252Ftoken",
    "/api/auth/gateway-link%3Fverifier=x",
    "/api/auth/./gateway-link/token",
    "/api/auth/x/../gateway-link/token",
    "/api//auth//gateway-link//token",
    "/api/auth/gateway-link/token%zz",
  ])("owns %s", (path) => {
    expect(ownsRemoteLinkPath(path)).toBe(true);
  });

  it.each(["/", "/api/auth/get-session", "/api/auth/gateway-links", "/api/auth/gateway-linkage/x", "/api/relay/link/start", "/api/auth/x/../get-session"])(
    "does not own %s",
    (path) => {
      expect(ownsRemoteLinkPath(path)).toBe(false);
    }
  );

  it("leaves the local link namespace to its own test", () => {
    expect(ownsLinkPath("/api/relay/link/status/abc")).toBe(true);
    expect(ownsLinkPath("/api/auth/gateway-link/token")).toBe(false);
  });
});
