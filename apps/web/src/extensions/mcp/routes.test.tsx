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

import { McpConfigPage } from "./routes";

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
    if (!action) expect(container.querySelector("button")).toBeNull();
  });

  it("renders every configured server and an empty state", async () => {
    fetchMock.mockResolvedValueOnce(status([server("connected"), { ...server("static"), name: "Internal", url: "https://mcp.example" }]));
    await mount();
    expect(container.querySelectorAll(".mcp-config-card")).toHaveLength(2);
    expect(container.textContent).toContain("Internal");

    dispose();
    fetchMock.mockResolvedValueOnce(status([]));
    await mount();
    expect(container.textContent).toContain("No remote MCP servers are configured");
  });

  it("opens authorize popup and refreshes after a successful result", async () => {
    fetchMock.mockResolvedValueOnce(status([server("disconnected")])).mockResolvedValueOnce(status([server("connected")]));
    await mount();
    container.querySelector<HTMLButtonElement>("button")!.click();
    expect(window.open).toHaveBeenCalledWith(
      "/api/mcp/oauth/authorize?agent=casey&server=Claap",
      "yoplai-oauth",
      "width=520,height=640"
    );

    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", extension: "mcp", server: "Claap", success: true } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Connected");
  });

  it.each(["yoplai-oauth", "aihub-oauth"] as const)(
    "refreshes exactly once per %s popup message",
    async (type) => {
      fetchMock.mockResolvedValueOnce(status([server("disconnected")])).mockResolvedValueOnce(status([server("connected")]));
      await mount();

      window.dispatchEvent(new MessageEvent("message", { data: { type, extension: "mcp", server: "Claap", success: true } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Connected");
    }
  );

  it("disconnects and refreshes the server state", async () => {
    fetchMock
      .mockResolvedValueOnce(status([server("connected")]))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) })
      .mockResolvedValueOnce(status([server("disconnected")]));
    await mount();
    container.querySelector<HTMLButtonElement>("button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/mcp/oauth/disconnect?agent=casey&server=Claap",
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
