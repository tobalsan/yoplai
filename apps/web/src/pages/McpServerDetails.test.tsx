// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { fetchMcpServersMock, fetchMcpServerConfigMock, saveMcpServerConfigMock, removeMcpServerMock, disconnectMcpServerMock, useSessionMock, navigateMock } = vi.hoisted(() => ({
  fetchMcpServersMock: vi.fn(),
  fetchMcpServerConfigMock: vi.fn(),
  saveMcpServerConfigMock: vi.fn(),
  removeMcpServerMock: vi.fn(),
  disconnectMcpServerMock: vi.fn(),
  useSessionMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("../api/mcp-servers", () => ({
  cachedMcpServers: () => undefined,
  mcpDisplayName: (name: string, title?: string) => title || name.charAt(0).toUpperCase() + name.slice(1),
  fetchMcpServers: fetchMcpServersMock,
  fetchMcpServerConfig: fetchMcpServerConfigMock,
  saveMcpServerConfig: saveMcpServerConfigMock,
  removeMcpServer: removeMcpServerMock,
  disconnectMcpServer: disconnectMcpServerMock,
}));
vi.mock("../auth/client", () => ({ useSession: useSessionMock }));
vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; class?: string; children: unknown }) => {
    const a = document.createElement("a");
    a.setAttribute("href", props.href);
    a.textContent = String(props.children ?? "");
    return a;
  },
  useParams: () => ({ agentId: "scribe", serverName: "docs" }),
  useNavigate: () => navigateMock,
}));

import { McpServerDetails } from "./McpServerDetails";

let container: HTMLElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.startsWith(label));

async function mount() {
  dispose = render(() => <McpServerDetails />, container);
  await tick(); await tick();
}

beforeEach(() => {
  vi.resetAllMocks();
  useSessionMock.mockReturnValue(() => ({ isPending: false, data: { user: { id: "u" } } }));
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => { dispose?.(); container.remove(); vi.restoreAllMocks(); });

describe("McpServerDetails", () => {
  it("connects, disconnects only the selected scope, and removes after confirmation", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "connected", personalState: "connected", teamState: "disconnected", readOnly: false },
    ] });
    disconnectMcpServerMock.mockResolvedValue(undefined);
    removeMcpServerMock.mockResolvedValue(undefined);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await mount();

    button("Disconnect")!.click();
    await tick();
    expect(disconnectMcpServerMock).toHaveBeenCalledWith("scribe", "docs", "personal");
    container.querySelector<HTMLButtonElement>('[data-scope="team"]')!.click();
    await tick();
    button("Connect")!.click();
    expect(open).toHaveBeenCalledWith("/api/mcp/oauth/authorize?agent=scribe&server=docs&scope=team", "yoplai-oauth", expect.any(String));
    button("Remove server")!.click();
    await tick();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("deletes the extension from this agent for all users");
    expect(removeMcpServerMock).not.toHaveBeenCalled();
    button("Cancel")!.click();
    await tick();
    expect(button("Confirm remove")).toBeFalsy();
    button("Remove server")!.click();
    await tick();
    button("Confirm remove")!.click();
    await tick();
    expect(removeMcpServerMock).toHaveBeenCalledWith("scribe", "docs");
    expect(navigateMock).toHaveBeenCalledWith("/agents/scribe/edit");
  });

  it("edits a non-OAuth server config as JSON and shows save errors", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "static", state: "connected", readOnly: false },
    ] });
    fetchMcpServerConfigMock.mockResolvedValue({ name: "docs", type: "http", editable: true, config: { url: "https://docs.test/mcp", headers: { Authorization: "••••••••" } } });
    saveMcpServerConfigMock.mockResolvedValue({ name: "docs", type: "http", editable: true, config: { url: "https://new.test/mcp" } });
    await mount();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toContain("••••••••");

    textarea.value = "{ nope";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    button("Save")!.click();
    await tick();
    expect(container.textContent).toContain("Invalid JSON");
    expect(saveMcpServerConfigMock).not.toHaveBeenCalled();

    textarea.value = '{"url":"https://new.test/mcp"}';
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    button("Save")!.click();
    await tick();
    expect(saveMcpServerConfigMock).toHaveBeenCalledWith("scribe", "docs", { url: "https://new.test/mcp" });
    expect(container.textContent).toContain("Saved.");
  });

  it("shows stdio configs read-only", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [{ name: "docs", type: "stdio", auth: "stdio", state: "connected", readOnly: true }] });
    fetchMcpServerConfigMock.mockResolvedValue({ name: "docs", type: "stdio", editable: false, config: { command: "node" } });
    await mount();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.readOnly).toBe(true);
    expect(button("Save")).toBeUndefined();
  });

  it("hides Remove server from non-admins", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: false, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "connected", personalState: "connected", teamState: "connected", readOnly: false },
    ] });
    await mount();
    expect(button("Remove server")).toBeUndefined();
  });

  it("shows Remove server to admins and surfaces a remove failure", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "connected", personalState: "connected", teamState: "connected", readOnly: false },
    ] });
    removeMcpServerMock.mockRejectedValue(new Error("Only admins can remove this MCP server."));
    await mount();
    button("Remove server")!.click();
    await tick();
    button("Confirm remove")!.click();
    await tick();
    expect(container.textContent).toContain("Only admins can remove this MCP server.");
  });

  it("shows the connected account for the selected scope", async () => {
    fetchMcpServersMock.mockResolvedValue({ canConfigureTeam: true, servers: [
      { name: "docs", type: "http", url: "https://docs.test/mcp", auth: "oauth", state: "connected", personalState: "connected", teamState: "connected", personalAccount: "me@example.test", teamAccount: "team@example.test", readOnly: false },
    ] });
    await mount();
    expect(container.querySelector(".oauth-account")?.textContent).toContain("Connected as");
    expect(container.querySelector(".oauth-account-value")?.textContent).toBe("me@example.test");
    container.querySelector<HTMLButtonElement>('[data-scope="team"]')!.click();
    await tick();
    expect(container.querySelector(".oauth-account-value")?.textContent).toBe("team@example.test");
  });
});
