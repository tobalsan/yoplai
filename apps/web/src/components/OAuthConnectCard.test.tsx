// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { OAuthConnectCard } from "./OAuthConnectCard";

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
  it("keeps the newest scope status when the team response arrives last", async () => {
    let resolveTeam!: (value: Response) => void;
    const team = new Promise<Response>((resolve) => { resolveTeam = resolve; });
    const status = (account: string) => new Response(JSON.stringify({ connected: true, provider: "google", account, scopes: [] }));
    const fetchMock = vi.fn((input: string) => input.includes("scope=personal")
      ? Promise.resolve(status("alice@example.test"))
      : team);
    vi.stubGlobal("fetch", fetchMock);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    const selector = document.querySelector("select")!;
    selector.value = "personal";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(document.body.textContent).toContain("alice@example.test");
    resolveTeam(status("team@example.test"));
    await flush();
    expect(document.body.textContent).toContain("alice@example.test");
    expect(document.body.textContent).not.toContain("team@example.test");
  });

  it("starts and disconnects the selected personal scope", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connected: false, provider: "google" })));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    const selector = document.querySelector("select")!;
    selector.value = "personal";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
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

  it("defaults non-admins to Just me and shows the team connection read-only", async () => {
    const fetchMock = vi.fn(async (input: string) => new Response(JSON.stringify(input.includes("scope=team")
      ? { connected: true, provider: "google", account: "team@example.test", scopes: [], canConfigureTeam: false }
      : { connected: false, provider: "google", canConfigureTeam: false })));
    vi.stubGlobal("fetch", fetchMock);
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    await flush();
    const selector = document.querySelector("select")!;
    expect(Array.from(selector.options).map((option) => option.text)).toEqual(["Just me", "Whole team"]);
    expect(selector.value).toBe("personal");
    expect(document.querySelector(".oauth-btn-primary")).not.toBeNull();

    selector.value = "team";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(selector.value).toBe("team");
    expect(document.body.textContent).toContain("team@example.test");
    expect(document.body.textContent).toContain("managed by an admin");
    expect(document.querySelector(".oauth-btn")).toBeNull();
  });

  it("tells non-admins an admin must set up a missing team connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connected: false, provider: "google", canConfigureTeam: false }))));
    dispose = render(() => <OAuthConnectCard agentId="probe" provider="google" label="Google" />, document.body);
    await flush();
    await flush();
    const selector = document.querySelector("select")!;
    selector.value = "team";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(document.body.textContent).toContain("An admin must connect it");
    expect(document.querySelector(".oauth-btn")).toBeNull();
  });
});
