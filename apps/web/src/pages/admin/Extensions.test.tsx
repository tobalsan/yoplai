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
      system: { extensions: [], mcp: [] },
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

  it("lets a superadmin mark and unmark an extension as system", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const control = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: [], system: { extensions: ["exa"], mcp: [] } });
    expect(control("Mark Exa as system")).not.toBeNull();
    control("Mark Exa as system").click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: [], mcp: [], system: { extensions: ["exa"], mcp: [] } });
    expect(control("Unmark Exa as system").getAttribute("aria-checked")).toBe("true");
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
    control("Unmark Exa as system").click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
    expect(control("Mark Exa as system").getAttribute("aria-checked")).toBe("false");
  });

  it("shows User management and Extensions tabs to a superadmin", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const tabs = Array.from(container.querySelectorAll(".admin-tab")).map((t) => [t.textContent, t.getAttribute("href")]);
    expect(tabs).toEqual([
      ["User management", "/admin/users"],
      ["Extensions", "/admin/extensions"],
      ["MCP servers", "/admin/mcp-servers"],
      ["Skills", "/admin/skills"],
    ]);
    expect(container.querySelector(".admin-tab.active")?.textContent).toBe("Extensions");
  });

  it("marks and unmarks an MCP server and immediately shows the server's removal of its Top star", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const control = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: ["https://mcp.linear.app/mcp"], system: { extensions: [], mcp: [] } });
    control("Mark linear as top").click();
    await flush();
    expect(control("Unmark linear as top").getAttribute("aria-pressed")).toBe("true");
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: [], system: { extensions: [], mcp: ["https://mcp.linear.app/mcp"] } });
    control("Mark linear as system").click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: [], mcp: ["https://mcp.linear.app/mcp"], system: { extensions: [], mcp: ["https://mcp.linear.app/mcp"] } });
    expect(control("Unmark linear as system").getAttribute("aria-checked")).toBe("true");
    expect(control("Mark linear as top").getAttribute("aria-pressed")).toBe("false");
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
    control("Unmark linear as system").click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
    expect(control("Mark linear as system").getAttribute("aria-checked")).toBe("false");
  });

  it("hides System controls in single-user mode", async () => {
    const container = await mountWith({ multiUser: false });
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector('[aria-label="Mark Exa as top"]')).not.toBeNull();
  });

  it("unlocks controls after a failed System save so another change can proceed", async () => {
    const container = await mountWith({ multiUser: true, user: { id: "s", role: "superadmin" } });
    const control = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    m.saveTopExtensions.mockRejectedValueOnce(new Error("Network timeout"));
    control("Mark Exa as system").click();
    expect(control("Mark linear as system").disabled).toBe(true);
    await flush();
    expect(container.textContent).toContain("Network timeout");
    expect(control("Mark linear as system").disabled).toBe(false);
    m.saveTopExtensions.mockResolvedValueOnce({ extensions: [], mcp: [], system: { extensions: [], mcp: ["https://mcp.linear.app/mcp"] } });
    control("Mark linear as system").click();
    await flush();
    expect(control("Unmark linear as system").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Network timeout");
  });

  it("hides User management in single-user mode", async () => {
    const container = await mountWith({ multiUser: false });
    expect(Array.from(container.querySelectorAll(".admin-tab")).map((t) => t.textContent)).toEqual(["Extensions", "MCP servers", "Skills"]);
  });

  it("lists candidates and toggles stars via PUT", async () => {
    m.fetchAdminTopExtensions.mockResolvedValue({
      extensions: ["exa"],
      mcp: [],
      system: { extensions: [], mcp: [] },
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
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({ extensions: ["exa", "notion"], mcp: [], system: { extensions: [], mcp: [] } });
    expect(star('[data-extension="notion"]').getAttribute("aria-pressed")).toBe("true");

    star('[data-mcp="https://mcp.linear.app/mcp"]').click();
    await flush();
    expect(m.saveTopExtensions).toHaveBeenLastCalledWith({
      extensions: ["exa", "notion"],
      mcp: ["https://mcp.linear.app/mcp"],
      system: { extensions: [], mcp: [] },
    });
  });

  it("locks every star while a save is in flight so toggles cannot overwrite each other", async () => {
    m.fetchAdminTopExtensions.mockResolvedValue({
      extensions: [],
      mcp: [],
      system: { extensions: [], mcp: [] },
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
    resolve({ extensions: ["exa"], mcp: [], system: { extensions: [], mcp: [] } });
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
