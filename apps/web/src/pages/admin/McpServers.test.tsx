// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const m = vi.hoisted(() => ({ refreshMcpCatalogIcon: vi.fn(), fetchMcpCatalog: vi.fn(), addMcpCatalogServer: vi.fn(), updateMcpCatalogServer: vi.fn(), removeMcpCatalogServer: vi.fn(), sessionPending: false, gatewayParam: undefined as string | undefined }));
vi.mock("../../api/mcp-servers", async () => ({ ...m, iconRefreshOutcome: (await vi.importActual<typeof import("../../api/mcp-servers")>("../../api/mcp-servers")).iconRefreshOutcome, refreshMcpServerIcon: vi.fn(), ICON_REFRESH_UNCERTAIN: "uncertain", mcpDisplayName: (name: string, title?: string) => title || name }));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({ pathname: "/admin/mcp-servers", search: "" }),
  useSearchParams: () => [m.gatewayParam === undefined ? {} : { gateway: m.gatewayParam }, vi.fn()],
}));
vi.mock("../../auth/client", () => ({ useSession: () => () => ({ isPending: m.sessionPending, data: null }) }));
vi.mock("../../api/gateway", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api/gateway")>()), fetchGatewayList: vi.fn().mockResolvedValue({ state: "unavailable" }) }));

const { default: AdminMcpServersPage } = await import("./McpServers");
const { loadCapabilities, resetCapabilitiesForTests, setCapabilitiesForTests } = await import("../../lib/capabilities");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("AdminMcpServersPage", () => {
  let dispose: () => void;
  beforeEach(() => setCapabilitiesForTests({ extensions: { mcp: true } }));
  afterEach(() => { dispose?.(); document.body.innerHTML = ""; vi.clearAllMocks(); m.sessionPending = false; m.gatewayParam = undefined; vi.unstubAllGlobals(); resetCapabilitiesForTests(); });

  async function mount() {
    m.fetchMcpCatalog.mockResolvedValue([{ name: "linear", url: "https://mcp.linear.app/mcp", displayName: "Linear", description: "Issues" }]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    dispose = render(() => <AdminMcpServersPage />, container);
    await flush();
    return container;
  }
  const click = (container: HTMLElement, label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!.click();
  const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };

  it("hides cached rows once MCP is not installed, so they send no write", async () => {
    const container = await mount();
    expect(container.querySelector('[data-server="linear"]')).not.toBeNull();
    setCapabilitiesForTests({ extensions: { mcp: false } });
    await flush();
    expect(container.querySelector('[data-server="linear"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Remove")).toBe(false);
  });

  it("hides cached rows when a later capability read fails", async () => {
    const container = await mount();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 500 })));
    await loadCapabilities().catch(() => undefined);
    await flush();
    expect(container.textContent).toContain("Retry");
    expect(container.querySelector('[data-server="linear"]')).toBeNull();
  });

  it("shows no local Retry beside a missing named gateway", async () => {
    m.gatewayParam = "missing";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 500 })));
    await loadCapabilities().catch(() => undefined);
    const container = await mount();
    expect(container.textContent).toContain("Linked gateways are not available on this gateway.");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Retry")).toBe(false);
  });

  it("lists, adds, edits and removes catalog servers", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("https://mcp.linear.app/mcp");
    expect(container.textContent).toContain("Issues");
    expect(container.querySelector('.mcps-grid [data-server="linear"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll<HTMLInputElement>(".mcps-add input")).map((input) => input.placeholder)).toEqual([
      "https://mcp.example.com/mcp",
      "Display name, e.g. Atlassian",
      "What this server gives agents access to",
    ]);

    m.addMcpCatalogServer.mockResolvedValue({});
    type(container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://x.test/mcp");
    type(container.querySelector<HTMLInputElement>('[aria-label="Name (optional)"]')!, "X");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(m.addMcpCatalogServer).toHaveBeenCalledWith({ url: "https://x.test/mcp", displayName: "X", description: "" }, undefined);

    m.updateMcpCatalogServer.mockResolvedValue({ name: "linear", url: "https://mcp.linear.app/mcp", displayName: "Lin", description: "Issues" });
    click(container, "Edit");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Refresh icon")).toBe(false);
    type(container.querySelector<HTMLInputElement>('[aria-label="Name for linear"]')!, "Lin");
    click(container, "Save");
    await flush();
    expect(m.updateMcpCatalogServer).toHaveBeenCalledWith("linear", { displayName: "Lin", description: "Issues" }, undefined);
    expect(container.textContent).toContain("Lin");

    m.removeMcpCatalogServer.mockResolvedValue(undefined);
    click(container, "Remove");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Refresh icon")).toBe(false);
    expect(m.removeMcpCatalogServer).not.toHaveBeenCalled();
    click(container, "Confirm remove");
    await flush();
    expect(m.removeMcpCatalogServer).toHaveBeenCalledWith("linear", undefined);
    expect(container.textContent).toContain("No shared MCP servers yet.");
  });

  it("refreshes a catalog row icon with inline feedback", async () => {
    const container = await mount();
    const refresh = Promise.withResolvers<{ status: string; server: object }>();
    m.refreshMcpCatalogIcon.mockReturnValue(refresh.promise);
    click(container, "Refresh icon");
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Refreshing…")?.disabled).toBe(true);
    refresh.resolve({ status: "updated", server: { name: "linear", url: "https://mcp.linear.app/mcp", iconUrl: "https://linear.test/new.png" } });
    await flush();
    expect(m.refreshMcpCatalogIcon).toHaveBeenCalledWith("linear", undefined);
    expect(container.querySelector('[data-server="linear"] [role="status"]')?.textContent).toBe("Icon updated");
    expect(container.querySelector('[data-server="linear"] img')?.getAttribute("src")).toBe("https://linear.test/new.png");
  });

  it.each([
    ["unchanged", "No new icon found; kept the current one"],
    ["not_connected", "This server needs sign-in; its own icon is captured the next time an agent connects."],
  ])("shows the %s result and replaces the returned row icon", async (status, expected) => {
    const container = await mount();
    m.refreshMcpCatalogIcon.mockResolvedValue({ status, server: { name: "linear", url: "https://mcp.linear.app/mcp", iconUrl: "https://linear.test/favicon.png" } });
    click(container, "Refresh icon");
    await flush();
    expect(container.querySelector('[data-server="linear"] [role="status"]')?.textContent).toBe(expected);
    expect(container.querySelector('[data-server="linear"] img')?.getAttribute("src")).toBe("https://linear.test/favicon.png");
  });

  it.each([
    [{ status: "unreachable", error: "MCP server status timed out" }],
    [{ status: "unchanged", error: "MCP server status timed out" }],
  ])("reports a timed-out refresh as a row error, never as no new icon (%o)", async (response) => {
    const container = await mount();
    m.refreshMcpCatalogIcon.mockResolvedValue({ ...response, server: { name: "linear", url: "https://mcp.linear.app/mcp" } });
    click(container, "Refresh icon");
    await flush();
    expect(container.querySelector('[data-server="linear"] [role="alert"]')?.textContent).toContain("MCP server status timed out");
    expect(container.textContent).not.toContain("No new icon found");
  });

  it("reports a failed icon save as a row error, never as updated", async () => {
    const container = await mount();
    m.refreshMcpCatalogIcon.mockResolvedValue({ status: "save_failed", error: "disk full", server: { name: "linear", url: "https://mcp.linear.app/mcp" } });
    click(container, "Refresh icon");
    await flush();
    expect(container.querySelector('[data-server="linear"] [role="alert"]')?.textContent).toContain("Couldn't save the new icon: disk full");
    expect(container.textContent).not.toContain("Icon updated");
  });

  it("reports a refresh error on its row and allows retry", async () => {
    const container = await mount();
    m.refreshMcpCatalogIcon.mockRejectedValue(new Error("Icon lookup timed out"));
    click(container, "Refresh icon");
    await flush();
    expect(container.querySelector('[data-server="linear"] [role="alert"]')?.textContent).toBe("Icon lookup timed out");
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Refresh icon")?.disabled).toBe(false);
  });

  it("shows add errors", async () => {
    const container = await mount();
    m.addMcpCatalogServer.mockRejectedValue(new Error("Superadmin access required"));
    type(container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://x.test/mcp");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Superadmin access required");
  });

  it("shows neutral text and no form or catalog read when the mcp extension is off", async () => {
    setCapabilitiesForTests({ extensions: {} });
    const container = await mount();
    expect(m.fetchMcpCatalog).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("The MCP extension is not installed on this gateway.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-label="Server URL"]')).toBeNull();
  });

  it("shows no form and reads no catalog while the capabilities are not known", async () => {
    m.sessionPending = true;
    const container = await mount();
    expect(m.fetchMcpCatalog).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Server URL"]')).toBeNull();
  });
});
