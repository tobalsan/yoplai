import { describe, expect, it } from "vitest";
import { decideNavigation, decideWindowOpen, isPermissionAllowed, RESTART_URL } from "./links.js";

const uiOrigin = "http://localhost:3000";

describe("decideWindowOpen", () => {
  it("keeps OAuth popups as child windows", () => {
    expect(decideWindowOpen({ url: "https://idp.example/auth", frameName: "yoplai-oauth" })).toBe("child-window");
    expect(decideWindowOpen({ url: "", frameName: "yoplai-oauth-3" })).toBe("child-window");
  });

  it("keeps MCP app blank windows as child windows", () => {
    expect(decideWindowOpen({ url: "about:blank", frameName: "" })).toBe("child-window");
  });

  it("sends other web and mail links to the system browser", () => {
    expect(decideWindowOpen({ url: "https://example.com", frameName: "_blank" })).toBe("system-browser");
    expect(decideWindowOpen({ url: "mailto:a@b.c", frameName: "" })).toBe("system-browser");
  });

  it("denies other protocols", () => {
    expect(decideWindowOpen({ url: "file:///etc/passwd", frameName: "" })).toBe("deny");
    expect(decideWindowOpen({ url: "javascript:alert(1)", frameName: "" })).toBe("deny");
  });
});

describe("decideNavigation", () => {
  it("allows the UI origin", () => {
    expect(decideNavigation({ url: "http://localhost:3000/chat", uiOrigin })).toBe("allow");
  });

  it("sends other origins to the system browser", () => {
    expect(decideNavigation({ url: "https://example.com", uiOrigin })).toBe("system-browser");
    expect(decideNavigation({ url: "http://localhost:4000/x", uiOrigin })).toBe("system-browser");
  });

  it("handles the restart link and denies unsafe URLs", () => {
    expect(decideNavigation({ url: RESTART_URL, uiOrigin })).toBe("restart");
    expect(decideNavigation({ url: "file:///etc/passwd", uiOrigin })).toBe("deny");
    expect(decideNavigation({ url: "not a url", uiOrigin })).toBe("deny");
  });
});

describe("isPermissionAllowed", () => {
  it("allows clipboard write and fullscreen for the UI origin only", () => {
    expect(isPermissionAllowed("clipboard-sanitized-write", "http://localhost:3000/chat", uiOrigin)).toBe(true);
    expect(isPermissionAllowed("fullscreen", "https://example.com/", uiOrigin)).toBe(false);
  });

  it("denies camera, microphone, and unknown permissions", () => {
    expect(isPermissionAllowed("media", "http://localhost:3000/", uiOrigin)).toBe(false);
    expect(isPermissionAllowed("geolocation", "http://localhost:3000/", uiOrigin)).toBe(false);
    expect(isPermissionAllowed("fullscreen", "not a url", uiOrigin)).toBe(false);
  });
});
