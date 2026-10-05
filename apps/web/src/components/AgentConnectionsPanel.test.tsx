// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { fetchConnectionsMock, disconnectMock, fetchMcpMock, disconnectMcpMock, useSessionMock } = vi.hoisted(() => ({
  fetchConnectionsMock: vi.fn(),
  disconnectMock: vi.fn(),
  fetchMcpMock: vi.fn(),
  disconnectMcpMock: vi.fn(),
  useSessionMock: vi.fn(),
}));
vi.mock("../api/connections", () => ({
  fetchAgentConnections: fetchConnectionsMock,
  disconnectAgentConnection: disconnectMock,
  fetchAgentMcpConnections: fetchMcpMock,
  disconnectMcpConnection: disconnectMcpMock,
}));
vi.mock("../auth/client", () => ({ useSession: useSessionMock }));

import { AgentConnectionsPanel } from "./AgentConnectionsPanel";
import type { ExtensionCatalogEntry } from "../api/extensions";
import { createSignal } from "solid-js";

let root: HTMLDivElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fetchConnectionsMock.mockReset();
  disconnectMock.mockReset();
  fetchMcpMock.mockReset();
  disconnectMcpMock.mockReset();
  const [session] = createSignal({ data: { user: { id: "alice" } } });
  useSessionMock.mockReturnValue(session);
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
});

describe("AgentConnectionsPanel", () => {
  it("shows personal and team presence and disconnects only the personal grant", async () => {
    fetchConnectionsMock.mockResolvedValue([{ kind: "oauth", id: "google", name: "Google Drive", personal: true, team: true }]);
    disconnectMock.mockResolvedValue(undefined);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" />, root);
    await tick();
    const pills = (scope: string) => root.querySelector(`[data-scope="${scope}"] .cred-status-pill`)!;
    expect([pills("personal").textContent, pills("personal").getAttribute("data-tone")]).toEqual(["Connected", "ok"]);
    expect([pills("team").textContent, pills("team").getAttribute("data-tone")]).toEqual(["Connected", "ok"]);
    const button = root.querySelector<HTMLButtonElement>('[data-scope="personal"] button')!;
    expect(button.getAttribute("aria-label")).toBe("Disconnect your personal Google Drive connection");
    expect(root.querySelector('[data-scope="team"] button')).toBeNull();
    button.click();
    await tick();
    expect(disconnectMock).toHaveBeenCalledWith("scribe", "oauth", "google");
  });

  it("shows the matching extension icon, falling back to a letter", async () => {
    fetchConnectionsMock.mockResolvedValue([
      { kind: "oauth", id: "google", name: "google", personal: true, team: false },
      { kind: "extension", id: "exa", name: "Exa", personal: false, team: true },
      { kind: "extension", id: "custom", name: "custom", personal: false, team: true },
    ]);
    const extensions = [
      { id: "googleDrive", enabled: false, oauth: { provider: "google", scopes: [] }, iconDataUri: "data:drive" },
      { id: "gmail", enabled: true, oauth: { provider: "google", scopes: [] }, iconDataUri: "data:gmail" },
      { id: "exa", enabled: true, oauth: null, iconDataUri: "data:exa" },
    ] as unknown as ExtensionCatalogEntry[];
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" extensions={extensions} />, root);
    await tick();
    const marks = Array.from(root.querySelectorAll(".agent-connection-mark")).map((mark) => mark.querySelector("img")?.getAttribute("src") ?? mark.textContent);
    expect(marks).toEqual(["data:gmail", "data:exa", "C"]);
  });

  it("marks missing connections red and offers no disconnect", async () => {
    fetchConnectionsMock.mockResolvedValue([{ kind: "extension", id: "exa", name: "Exa", personal: false, team: false }]);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" />, root);
    await tick();
    const tones = Array.from(root.querySelectorAll(".cred-status-pill")).map((pill) => [pill.textContent, pill.getAttribute("data-tone")]);
    expect(tones).toEqual([["Not connected", "error"], ["Not connected", "error"]]);
    expect(root.querySelector("button")).toBeNull();
  });

  it("shows loading and fetch failures", async () => {
    let reject!: (cause: Error) => void;
    fetchConnectionsMock.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" />, root);
    expect(root.textContent).toContain("Loading connections");
    reject(new Error("offline"));
    await tick();
    expect(root.textContent).toContain("offline");
  });

  it("shows MCP personal and team presence and uses its disconnect route", async () => {
    fetchConnectionsMock.mockResolvedValue([]);
    fetchMcpMock.mockResolvedValue([{ kind: "mcp", id: "Docs", name: "Docs (MCP)", personal: true, team: true }]);
    disconnectMcpMock.mockResolvedValue(undefined);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" includeMcp />, root);
    await tick();
    expect(root.textContent).toContain("Docs");
    expect(root.textContent).toContain("MCP server");
    expect(root.querySelector('[data-scope="team"] .cred-status-pill')!.textContent).toBe("Connected");
    root.querySelector("button")!.click();
    await tick();
    expect(disconnectMcpMock).toHaveBeenCalledWith("scribe", "Docs");
  });

  it("keeps core connections available when MCP status fails", async () => {
    fetchConnectionsMock.mockResolvedValue([{ kind: "oauth", id: "google", name: "Google Drive", personal: true, team: false }]);
    fetchMcpMock.mockRejectedValue(new Error("MCP offline"));
    disconnectMock.mockResolvedValue(undefined);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" includeMcp />, root);
    await tick();
    expect(root.textContent).toContain("Google Drive");
    expect(root.textContent).toContain("MCP connections unavailable: MCP offline");
    root.querySelector("button")!.click();
    await tick();
    expect(disconnectMock).toHaveBeenCalledWith("scribe", "oauth", "google");
  });

  it("does not wait for an MCP status request before showing and disconnecting core connections", async () => {
    fetchConnectionsMock.mockResolvedValue([{ kind: "extension", id: "asana", name: "Asana", personal: true, team: true }]);
    fetchMcpMock.mockReturnValue(new Promise(() => {}));
    disconnectMock.mockResolvedValue(undefined);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" includeMcp />, root);
    await tick();
    expect(root.textContent).toContain("Asana");
    expect(root.textContent).toContain("Loading MCP connections");
    root.querySelector("button")!.click();
    await tick();
    expect(disconnectMock).toHaveBeenCalledWith("scribe", "extension", "asana");
  });

  it("ignores a late response from the previously selected agent", async () => {
    const [agentId, setter] = createSignal("one");
    let resolveOld!: (value: unknown) => void;
    fetchConnectionsMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([{ kind: "extension", id: "new", name: "New Agent Secret", personal: false, team: true }]);
    dispose = render(() => <AgentConnectionsPanel agentId={agentId()} />, root);
    setter("two");
    await tick();
    resolveOld([{ kind: "extension", id: "old", name: "Old Agent Secret", personal: true, team: false }]);
    await tick();
    expect(root.textContent).toContain("New Agent Secret");
    expect(root.textContent).not.toContain("Old Agent Secret");
  });

  it("clears connections and ignores stale results when the signed-in user changes", async () => {
    const [session, setSession] = createSignal({ data: { user: { id: "alice" } } });
    useSessionMock.mockReturnValue(session);
    let resolveAlice!: (value: unknown) => void;
    fetchConnectionsMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveAlice = resolve; }))
      .mockResolvedValueOnce([{ kind: "oauth", id: "google", name: "Bob Drive", personal: true, team: false }]);
    dispose = render(() => <AgentConnectionsPanel agentId="scribe" />, root);
    setSession({ data: { user: { id: "bob" } } });
    await tick();
    expect(root.textContent).toContain("Bob Drive");
    resolveAlice([{ kind: "oauth", id: "google", name: "Alice Drive", personal: true, team: false }]);
    await tick();
    expect(root.textContent).not.toContain("Alice Drive");
  });
});
