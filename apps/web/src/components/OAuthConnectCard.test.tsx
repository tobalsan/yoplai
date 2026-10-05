// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { OAuthConnectCard } from "./OAuthConnectCard";
import { activeScope, scopeTabLabels, selectScope } from "./CredentialScopeTabs.testing";

vi.mock("../auth/client", () => ({
  useSession: () => () => ({ data: { user: { id: "alice" } } }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OAuthConnectCard scope", () => {
  it("shows each scope's own connection and both states on the tab pills", async () => {
    const fetchMock = vi.fn(async (input: string) => new Response(JSON.stringify(input.includes("scope=personal")
      ? { connected: true, provider: "google", account: "alice@example.test", scopes: [] }
      : { state: "needs_reconnect", connected: false, provider: "google" })));
    vi.stubGlobal("fetch", fetchMock);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    selectScope(document, "personal");
    await flush();
    expect(document.querySelector(".cred-tabs-panel")?.textContent).toContain("alice@example.test");
    const pills = Array.from(document.querySelectorAll<HTMLElement>(".cred-tab-status")).map((pill) => [pill.textContent, pill.dataset.tone]);
    expect(pills).toEqual([["Connected", "ok"], ["Reconnect", "error"]]);
    selectScope(document, "team");
    await flush();
    expect(document.querySelector(".cred-tabs-panel")?.textContent).not.toContain("alice@example.test");
  });

  it("starts and disconnects the selected personal scope", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connected: false, provider: "google" })));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    selectScope(document, "personal");
    await flush();
    document.querySelector<HTMLButtonElement>(".oauth-btn-primary")!.click();
    expect(open).toHaveBeenCalledWith("/api/oauth/google/authorize?agent=probe&scope=personal", "yoplai-oauth", "width=520,height=640");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ connected: true, provider: "google", scopes: [] })));
    window.dispatchEvent(new Event("focus"));
    await flush();
    document.querySelector<HTMLButtonElement>(".oauth-btn-danger")!.click();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/oauth/google/disconnect?agent=probe&scope=personal", { method: "POST" });
  });

  it("opens on the connected team tab, read-only for non-admins, when Just me is not set up", async () => {
    const fetchMock = vi.fn(async (input: string) => new Response(JSON.stringify(input.includes("scope=team")
      ? { connected: true, provider: "google", account: "team@example.test", scopes: [], canConfigureTeam: false }
      : { connected: false, provider: "google", canConfigureTeam: false })));
    vi.stubGlobal("fetch", fetchMock);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    await flush();
    expect(scopeTabLabels(document)).toEqual(["Just me", "Whole team"]);
    expect(activeScope(document)).toBe("team");
    expect(document.body.textContent).toContain("team@example.test");
    expect(document.body.textContent).toContain("managed by an admin");
    expect(document.querySelector(".oauth-btn")).toBeNull();

    selectScope(document, "personal");
    await flush();
    expect(activeScope(document)).toBe("personal");
    expect(document.querySelector(".oauth-btn-primary")).not.toBeNull();
  });

  it("tells non-admins an admin must set up a missing team connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connected: false, provider: "google", canConfigureTeam: false }))));
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    await flush();
    selectScope(document, "team");
    await flush();
    expect(document.body.textContent).toContain("An admin must connect it");
    expect(document.querySelector(".oauth-btn")).toBeNull();
  });
});
