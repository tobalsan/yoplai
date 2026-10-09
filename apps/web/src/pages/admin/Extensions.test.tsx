// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const m = vi.hoisted(() => ({ fetchAdminTopExtensions: vi.fn(), saveTopExtensions: vi.fn() }));
vi.mock("../../api/top-extensions", () => m);
vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({ pathname: "/admin/extensions", search: "" }),
}));

const { default: AdminExtensionsPage } = await import("./Extensions");
const { setCapabilitiesForTests, resetCapabilitiesForTests } = await import("../../lib/capabilities");

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("AdminExtensionsPage", () => {
  let dispose: () => void;
  afterEach(() => {
    dispose?.();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    resetCapabilitiesForTests();
  });

  const mountWith = async (capabilities: Record<string, unknown>) => {
    setCapabilitiesForTests(capabilities as never);
    m.fetchAdminTopExtensions.mockResolvedValue({
      extensions: [],
      mcp: [],
      candidates: {
        extensions: [
          { id: "exa", displayName: "Exa", description: "", iconDataUri: "data:image/svg+xml;base64,AAAA" },
          { id: "plain", displayName: "Plain", description: "" },
        ],
        mcp: [
          { url: "https://mcp.linear.app/mcp", displayName: "linear", agentCount: 1, iconUrl: "https://linear.app/icon.png" },
          { url: "https://o.test/mcp", displayName: "other", agentCount: 1 },
        ],
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    dispose = render(() => <AdminExtensionsPage />, container);
    await flush();
    return container;
  };

  it("shows extension and MCP icons, with fallbacks", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const img = (sel: string) => container.querySelector<HTMLImageElement>(`${sel} img`)?.getAttribute("src");
    expect(img('[data-extension="exa"]')).toBe("data:image/svg+xml;base64,AAAA");
    expect(img('[data-mcp="https://mcp.linear.app/mcp"]')).toBe("https://linear.app/icon.png");
    expect(container.querySelector('[data-extension="plain"] .edit-agent-ext-icon svg')).not.toBeNull();
    expect(container.querySelector('[data-mcp="https://o.test/mcp"] svg[aria-label="Model Context Protocol"]')).not.toBeNull();
  });

  it("shows User management and Top extensions tabs to a superadmin", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const tabs = Array.from(container.querySelectorAll(".admin-tab")).map((t) => [t.textContent, t.getAttribute("href")]);
    expect(tabs).toEqual([
      ["User management", "/admin/users"],
      ["Top extensions", "/admin/extensions"],
      ["MCP servers", "/admin/mcp-servers"],
    ]);
    expect(container.querySelector(".admin-tab.active")?.textContent).toBe("Top extensions");
  });

  it("hides User management in single-user mode", async () => {
    const container = await mountWith({ multiUser: false });
    expect(Array.from(container.querySelectorAll(".admin-tab")).map((t) => t.textContent)).toEqual(["Top extensions", "MCP servers"]);
  });

  it("lists candidates and toggles stars via PUT", async () => {
    m.fetchAdminTopExtensions.mockResolvedValue({
      extensions: ["exa"],
      mcp: [],
      candidates: {
        extensions: [
          { id: "exa", displayName: "Exa", description: "Search" },
          { id: "notion", displayName: "Notion", description: "Docs" },
        ],
        mcp: [{ url: "https://mcp.linear.app/mcp", displayName: "linear", agentCount: 3 }],
      },
    });
    m.saveTopExtensions.mockImplementation(async (next) => next);
    const container = document.createElement("div");
    document.body.appendChild(container);
    dispose = render(() => <AdminExtensionsPage />, container);
    await flush();

    expect(container.textContent).toContain("used by 3 agents");
    const star = (sel: string) => container.querySelector<HTMLButtonElement>(`${sel} .top-star`)!;
    expect(star('[data-extension="exa"]').getAttribute("aria-pressed")).toBe("true");
    expect(star('[data-extension="notion"]').getAttribute("aria-pressed")).toBe("false");

    star('[data-extension="notion"]').click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: ["exa", "notion"], mcp: [] });
    expect(star('[data-extension="notion"]').getAttribute("aria-pressed")).toBe("true");

    star('[data-mcp="https://mcp.linear.app/mcp"]').click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({
      extensions: ["exa", "notion"],
      mcp: ["https://mcp.linear.app/mcp"],
    });
  });

  it("locks every star while a save is in flight so toggles cannot overwrite each other", async () => {
    m.fetchAdminTopExtensions.mockResolvedValue({
      extensions: [],
      mcp: [],
      candidates: {
        extensions: [
          { id: "exa", displayName: "Exa", description: "" },
          { id: "notion", displayName: "Notion", description: "" },
        ],
        mcp: [],
      },
    });
    let resolve!: (value: unknown) => void;
    m.saveTopExtensions.mockReturnValue(new Promise((r) => (resolve = r)));
    const container = document.createElement("div");
    document.body.appendChild(container);
    dispose = render(() => <AdminExtensionsPage />, container);
    await flush();
    const star = (id: string) => container.querySelector<HTMLButtonElement>(`[data-extension="${id}"] .top-star`)!;
    star("exa").click();
    expect(star("notion").disabled).toBe(true);
    resolve({ extensions: ["exa"], mcp: [] });
    await flush();
    expect(star("notion").disabled).toBe(false);
    expect(m.saveTopExtensions).toHaveBeenCalledTimes(1);
  });

  it("shows the forbidden message for non-superadmins", async () => {
    m.fetchAdminTopExtensions.mockRejectedValue(new Error("Only the superadmin can manage top extensions."));
    const container = document.createElement("div");
    document.body.appendChild(container);
    dispose = render(() => <AdminExtensionsPage />, container);
    await flush();
    expect(container.textContent).toContain("Only the superadmin");
  });
});
