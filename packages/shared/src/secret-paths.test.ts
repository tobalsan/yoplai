import { describe, expect, it } from "vitest";
import {
  LINK_NAMESPACE,
  ownsDashboardViewPath,
  ownsLinkPath,
  ownsRedactedPath,
  ownsRemoteLinkPath,
} from "./secret-paths.js";

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

describe("ownsDashboardViewPath", () => {
  it.each([
    "/api/relay/dashboard-views",
    "/api/relay/dashboard-views/abc/shell",
    "/API/Relay/Dashboard-Views/abc",
    "/api/relay/dashboard%2Dviews/abc",
    "/api%2Frelay%2Fdashboard-views%2Fabc",
    "/api/relay/dashboard%252Dviews/abc",
    "/api/relay/dashboard-views/abc%zz",
  ])("owns %s", (path) => {
    expect(ownsDashboardViewPath(path)).toBe(true);
  });

  it.each(["/", "/api/relay/gateways", "/api/relay/link/start", "/api/dashboards"])("does not own %s", (path) => {
    expect(ownsDashboardViewPath(path)).toBe(false);
  });
});

describe("link namespace tests", () => {
  it("keeps strict routing apart from broad redaction", () => {
    // Routing never sees these spellings as the namespace, but a log must still hide them.
    for (const path of ["/api/relay/./link/status/abc", "/api//relay//link/status/abc", "/api/relay/x/../link/status/abc"]) {
      expect(ownsLinkPath(path)).toBe(false);
      expect(ownsRedactedPath(path, LINK_NAMESPACE)).toBe(true);
    }
    expect(ownsRedactedPath("/api/relay/linkage", LINK_NAMESPACE)).toBe(false);
    expect(ownsRedactedPath("/api/relay/link", LINK_NAMESPACE)).toBe(true);
  });
});
