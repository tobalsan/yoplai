// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { useParamsMock } = vi.hoisted(() => ({ useParamsMock: vi.fn() }));

vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; class?: string; children: unknown }) => {
    const link = document.createElement("a");
    link.href = props.href;
    link.className = props.class ?? "";
    link.textContent = String(props.children ?? "");
    return link;
  },
  useParams: () => useParamsMock(),
}));

vi.mock("../../components/LeftNavShell", () => ({
  LeftNavShell: (props: { children: unknown }) => props.children,
}));

vi.mock("../../auth/client", () => ({ useSession: () => () => ({ data: { user: { id: "alice" } } }) }));

import { McpConfigPage } from "./routes";
import { activeScope, scopeTabLabels, selectScope } from "../../components/CredentialScopeTabs.testing";

const server = (state: "connected" | "disconnected" | "needs_reconnect" | "static", auth = state === "static" ? "static" : "oauth") => ({
  name: "Claap",
  url: "https://api.claap.io/mcp",
  auth,
  state,
});

let container: HTMLElement;
let dispose: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount() {
  useParamsMock.mockReturnValue({ agentId: "casey" });
  dispose = render(() => <McpConfigPage />, container);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function status(servers: object[]) {
  return { ok: true, json: vi.fn().mockResolvedValue({ servers }) };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", vi.fn());
});

afterEach(() => {
  dispose?.();
  container.remove();
  vi.unstubAllGlobals();
});

describe("McpConfigPage", () => {
  it.each([
    ["connected", "Connected", "Disconnect"],
    ["disconnected", "Not connected", "Connect"],
    ["needs_reconnect", "Needs reconnect", "Reconnect"],
    ["static", "Configured", undefined],
  ] as const)("renders the %s state", async (state, label, action) => {
    fetchMock.mockResolvedValue(status([server(state)]));
    await mount();

    expect(container.textContent).toContain("Claap");
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain(action ?? "Configured");
    if (!action) expect(container.querySelector(".mcp-config-card button")).toBeNull();
  });

  it("renders every configured server and an empty state", async () => {
    fetchMock.mockResolvedValue(status([server("connected"), { ...server("static"), name: "Internal", url: "https://mcp.example" }]));
    await mount();
    expect(container.querySelectorAll(".mcp-config-card")).toHaveLength(2);
    expect(container.textContent).toContain("Internal");

    dispose();
    fetchMock.mockResolvedValue(status([]));
    await mount();
    expect(container.textContent).toContain("No remote MCP servers are configured");
  });

  it("opens authorize popup and refreshes after a successful result", async () => {
    fetchMock.mockResolvedValue(status([server("disconnected")]));
    await mount();
    fetchMock.mockResolvedValue(status([server("connected")]));
    container.querySelector<HTMLButtonElement>(".mcp-config-card button")!.click();
    expect(window.open).toHaveBeenCalledWith(
      "/api/mcp/oauth/authorize?agent=casey&server=Claap&scope=team",
      "yoplai-oauth",
      "width=520,height=640"
    );

    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", extension: "mcp", server: "Claap", success: true } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One status request per scope, per refresh.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Connected");
  });

  it.each(["yoplai-oauth", "aihub-oauth"] as const)(
    "refreshes exactly once per %s popup message",
    async (type) => {
      fetchMock.mockResolvedValue(status([server("disconnected")]));
      await mount();
      fetchMock.mockResolvedValue(status([server("connected")]));

      window.dispatchEvent(new MessageEvent("message", { data: { type, extension: "mcp", server: "Claap", success: true } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(container.textContent).toContain("Connected");
    }
  );

  it("disconnects and refreshes the server state", async () => {
    let state: "connected" | "disconnected" = "connected";
    fetchMock.mockImplementation(async (input: string) => {
      if (!input.includes("/disconnect")) return status([server(state)]);
      state = "disconnected";
      return { ok: true, json: vi.fn().mockResolvedValue({ ok: true }) };
    });
    await mount();
    container.querySelector<HTMLButtonElement>(".mcp-config-card button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/oauth/disconnect?agent=casey&server=Claap&scope=team",
      { method: "POST" }
    );
    expect(container.textContent).toContain("Not connected");
  });

  it.each(["yoplai-oauth", "aihub-oauth"] as const)(
    "shows an error after a failed %s popup result",
    async (type) => {
      fetchMock.mockResolvedValue(status([server("disconnected")]));
      await mount();
      window.dispatchEvent(new MessageEvent("message", { data: { type, extension: "mcp", server: "Claap", success: false } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.textContent).toContain("Could not connect Claap.");
    }
  );
});

  it("uses personal scope for authorization and disconnect", async () => {
    fetchMock.mockResolvedValue(status([server("disconnected")]));
    await mount();
    selectScope(container, "personal");
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".mcp-config-card button")!.click();
    expect(window.open).toHaveBeenCalledWith(
      "/api/mcp/oauth/authorize?agent=casey&server=Claap&scope=personal",
      "yoplai-oauth", "width=520,height=640"
    );
    fetchMock.mockResolvedValue(status([server("connected")]));
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector<HTMLButtonElement>(".mcp-config-card button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/oauth/disconnect?agent=casey&server=Claap&scope=personal", { method: "POST" }
    );
  });

  it("shows each scope's own servers and summarizes both on the tab pills", async () => {
    fetchMock.mockImplementation(async (input: string) => status([server(input.includes("scope=personal") ? "connected" : "needs_reconnect")]));
    await mount();
    selectScope(container, "personal");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".cred-tabs-panel")?.textContent).toContain("Connected");
    expect(container.querySelector(".cred-tabs-panel")?.textContent).not.toContain("Needs reconnect");
    const pills = Array.from(container.querySelectorAll<HTMLElement>(".cred-tab-status")).map((pill) => [pill.textContent, pill.dataset.tone]);
    expect(pills).toEqual([["Connected", "ok"], ["Reconnect", "error"]]);
  });

  it("opens the requester personal connection from a reconnect link", async () => {
    window.history.replaceState({}, "", "/agents/casey/extensions/mcp?scope=personal");
    fetchMock.mockResolvedValue(status([server("needs_reconnect")]));
    await mount();
    expect(activeScope(container)).toBe("personal");
    expect(fetchMock).toHaveBeenCalledWith("/api/mcp/oauth/status?agent=casey&scope=personal");
    container.querySelector<HTMLButtonElement>(".mcp-config-card button")!.click();
    expect(window.open).toHaveBeenCalledWith(
      "/api/mcp/oauth/authorize?agent=casey&server=Claap&scope=personal",
      "yoplai-oauth", "width=520,height=640"
    );
  });

describe("McpConfigPage team access", () => {
  it("defaults non-admins to Just me and shows team connections read-only", async () => {
    fetchMock.mockImplementation(async (input: string) => ({ ok: true, json: vi.fn().mockResolvedValue({
      servers: [server(input.includes("scope=team") ? "connected" : "disconnected")], canConfigureTeam: false,
    }) }));
    await mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scopeTabLabels(container)).toEqual(["Just me", "Whole team"]);
    expect(activeScope(container)).toBe("personal");
    expect(container.querySelector(".mcp-config-card button")).not.toBeNull();

    selectScope(container, "team");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeScope(container)).toBe("team");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("managed by an admin");
    expect(container.querySelector(".mcp-config-card button")).toBeNull();
  });
});
