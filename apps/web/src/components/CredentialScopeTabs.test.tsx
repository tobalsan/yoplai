import { describe, expect, it } from "vitest";
import { preferredScope, type ScopeStatus } from "./CredentialScopeTabs";

const ok: ScopeStatus = { tone: "ok", label: "Connected" };
const off: ScopeStatus = { tone: "off", label: "Not set up" };
const broken: ScopeStatus = { tone: "error", label: "Reconnect" };

describe("preferredScope", () => {
  it("prefers Just me when both are connected", () => {
    expect(preferredScope({ personal: ok, team: ok })).toBe("personal");
  });

  it("opens whichever scope is connected", () => {
    expect(preferredScope({ personal: off, team: ok })).toBe("team");
    expect(preferredScope({ personal: ok, team: off })).toBe("personal");
    expect(preferredScope({ personal: broken, team: ok })).toBe("team");
  });

  it("falls back to Just me when nothing is connected", () => {
    expect(preferredScope({ personal: off, team: off })).toBe("personal");
    expect(preferredScope({})).toBe("personal");
  });

  it("uses Whole team when Just me is unavailable", () => {
    expect(preferredScope({ personal: ok, team: off }, false)).toBe("team");
  });
});
