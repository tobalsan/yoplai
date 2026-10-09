// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const m = vi.hoisted(() => ({ fetchMcpCatalog: vi.fn(), addMcpCatalogServer: vi.fn(), updateMcpCatalogServer: vi.fn(), removeMcpCatalogServer: vi.fn() }));
vi.mock("../../api/mcp-servers", () => ({ ...m, mcpDisplayName: (name: string, title?: string) => title || name }));
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({ pathname: "/admin/mcp-servers", search: "" }),
}));

const { default: AdminMcpServersPage } = await import("./McpServers");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("AdminMcpServersPage", () => {
  let dispose: () => void;
  afterEach(() => { dispose?.(); document.body.innerHTML = ""; vi.clearAllMocks(); });

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

  it("lists, adds, edits and removes catalog servers", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("https://mcp.linear.app/mcp");
    expect(container.textContent).toContain("Issues");

    m.addMcpCatalogServer.mockResolvedValue({});
    type(container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://x.test/mcp");
    type(container.querySelector<HTMLInputElement>('[aria-label="Name (optional)"]')!, "X");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(m.addMcpCatalogServer).toHaveBeenCalledWith({ url: "https://x.test/mcp", displayName: "X", description: "" });

    m.updateMcpCatalogServer.mockResolvedValue({ name: "linear", url: "https://mcp.linear.app/mcp", displayName: "Lin", description: "Issues" });
    click(container, "Edit");
    type(container.querySelector<HTMLInputElement>('[aria-label="Name for linear"]')!, "Lin");
    click(container, "Save");
    await flush();
    expect(m.updateMcpCatalogServer).toHaveBeenCalledWith("linear", { displayName: "Lin", description: "Issues" });
    expect(container.textContent).toContain("Lin");

    m.removeMcpCatalogServer.mockResolvedValue(undefined);
    click(container, "Remove");
    expect(m.removeMcpCatalogServer).not.toHaveBeenCalled();
    click(container, "Confirm remove");
    await flush();
    expect(m.removeMcpCatalogServer).toHaveBeenCalledWith("linear");
    expect(container.textContent).toContain("No shared MCP servers yet.");
  });

  it("shows add errors", async () => {
    const container = await mount();
    m.addMcpCatalogServer.mockRejectedValue(new Error("Superadmin access required"));
    type(container.querySelector<HTMLInputElement>('[aria-label="Server URL"]')!, "https://x.test/mcp");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Superadmin access required");
  });
});
