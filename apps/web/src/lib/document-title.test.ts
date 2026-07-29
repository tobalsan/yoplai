import { describe, expect, it } from "vitest";
import { buildTitle, documentTitle, sectionForPath } from "./document-title";

describe("document titles", () => {
  it("builds home titles with and without branding", () => {
    expect(documentTitle({ pathname: "/", brandingName: "Acme" })).toBe(
      "Acme — Yoplai"
    );
    expect(documentTitle({ pathname: "/" })).toBe("Yoplai");
    expect(buildTitle(["", undefined, "Acme"])).toBe("Acme — Yoplai");
  });

  it("uses the resolved chat agent name when available", () => {
    expect(
      documentTitle({
        pathname: "/chat/poms",
        agentName: "Poms",
        brandingName: "Acme",
      })
    ).toBe("Poms — Acme — Yoplai");
    expect(
      documentTitle({ pathname: "/chat/poms", brandingName: "Acme" })
    ).toBe("Acme — Yoplai");
  });

  it.each([
    ["/agents", "Agents"],
    ["/agents/poms/edit", "Edit Agent"],
    ["/agents/poms/extensions/mcp", "Extension"],
    ["/agents/poms/extensions/mcp/config", "Extension Config"],
    ["/teams", "Teams"],
    ["/admin/users", "Users"],
    ["/login", "Sign in"],
  ])("labels static route %s", (pathname, section) => {
    expect(sectionForPath(pathname)).toBe(section);
    expect(documentTitle({ pathname, brandingName: "Acme" })).toBe(
      `${section} — Acme — Yoplai`
    );
  });

  it("leaves extension routes without a section label", () => {
    expect(
      documentTitle({ pathname: "/extensions/mcp", brandingName: "Acme" })
    ).toBe("Acme — Yoplai");
  });

  it("prefixes the complete branded title in development", () => {
    expect(
      documentTitle({
        pathname: "/agents",
        brandingName: "Acme",
        devPrefix: "[DEV :3000] ",
      })
    ).toBe("[DEV :3000] Agents — Acme — Yoplai");
  });
});
