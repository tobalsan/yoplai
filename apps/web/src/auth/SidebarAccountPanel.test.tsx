// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

// matchMedia must exist before theme.ts module-level code runs
window.matchMedia = vi.fn().mockReturnValue({ matches: false });

const sessionDataSignal = createSignal<{
  data?: { user?: { name?: string; email?: string; image?: string } | null };
}>({ data: { user: { name: "Test User", email: "test@example.com" } } });

const navigateMock = vi.fn();
const [pathname, setPathname] = createSignal("/");

vi.mock("./client", () => ({
  useSession: () => sessionDataSignal[0],
  signOut: vi.fn(async () => {}),
}));

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useNavigate: () => navigateMock,
  useLocation: () => ({
    get pathname() {
      return pathname();
    },
    search: "",
  }),
}));

const { default: SidebarAccountPanel } = await import("./SidebarAccountPanel");
const { setCapabilitiesForTests, resetCapabilitiesForTests } = await import(
  "../lib/capabilities"
);

describe("SidebarAccountPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    navigateMock.mockReset();
    resetCapabilitiesForTests();
    sessionDataSignal[1]({ data: { user: { name: "Test User", email: "test@example.com" } } });
  });

  it("shows the current photo, falls back on failure, and retries a changed photo", () => {
    sessionDataSignal[1]({ data: { user: { name: "Test User", image: "https://lh3.googleusercontent.com/old-photo" } } });
    const dispose = render(() => <SidebarAccountPanel collapsed={() => false} />, document.body);
    const avatar = document.querySelector(".sidebar-account-avatar")!;
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/old-photo");
    avatar.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("TU");
    sessionDataSignal[1]({ data: { user: { name: "Test User", image: "https://lh3.googleusercontent.com/new-photo" } } });
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/new-photo");
    dispose();
  });

  it("renders menu toggle in multi-user mode", () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    expect(document.body.textContent).toContain("Test User");
    expect(document.body.textContent).toContain("test@example.com");
    
    // Should have menu button
    const toggle = document.querySelector(".sidebar-account-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    
    // Should NOT have inline links/buttons
    expect(document.body.textContent).not.toContain("Account connections");
    expect(document.body.textContent).not.toContain("Logout");
    
    dispose();
  });

  it("opens menu on toggle click in multi-user mode", () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    const toggle = document.querySelector(".sidebar-account-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    
    // Menu should not be visible initially
    expect(document.querySelector(".account-menu")).toBeNull();
    
    // Click to open
    toggle.click();
    
    // Menu should now be visible
    const menu = document.querySelector(".account-menu");
    expect(menu).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    
    // Check menu items
    expect(document.body.textContent).toContain("Account connections");
    expect(document.body.textContent).toContain("Archive");
    expect(document.body.textContent).toContain("Logout");
    
    // Check icons
    expect(menu?.querySelector(".fa-plug")).not.toBeNull();
    expect(menu?.querySelector(".fa-box-archive")).not.toBeNull();
    expect(menu?.querySelector(".fa-right-from-bracket")).not.toBeNull();
    
    // Check separator
    expect(menu?.querySelector(".account-menu-separator")).not.toBeNull();
    
    dispose();
  });

  it("navigates to /account/connections when menu item clicked", () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    // Open menu
    const toggle = document.querySelector(".sidebar-account-toggle") as HTMLButtonElement;
    toggle.click();
    
    // Click Account connections
    const items = document.querySelectorAll(".account-menu-item");
    const connectionsItem = Array.from(items).find((item) =>
      item.textContent?.includes("Account connections")
    ) as HTMLButtonElement;
    expect(connectionsItem).not.toBeNull();
    
    connectionsItem.click();
    
    expect(navigateMock).toHaveBeenCalledWith("/account/connections");
    
    dispose();
  });

  it("navigates to /archive when Archive menu item clicked", () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    // Open menu
    const toggle = document.querySelector(".sidebar-account-toggle") as HTMLButtonElement;
    toggle.click();
    
    // Click Archive
    const items = document.querySelectorAll(".account-menu-item");
    const archiveItem = Array.from(items).find((item) =>
      item.textContent?.includes("Archive") && !item.textContent?.includes("box-archive")
    ) as HTMLButtonElement;
    expect(archiveItem).not.toBeNull();
    
    archiveItem.click();
    
    expect(navigateMock).toHaveBeenCalledWith("/archive");
    
    dispose();
  });

  it("closes menu on Escape key", async () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    // Open menu
    const toggle = document.querySelector(".sidebar-account-toggle") as HTMLButtonElement;
    toggle.click();
    
    expect(document.querySelector(".account-menu")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    
    // Press Escape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    
    // Wait for effect to run
    await new Promise((resolve) => setTimeout(resolve, 0));
    
    // Menu should close
    expect(document.querySelector(".account-menu")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    
    dispose();
  });

  it("closes menu on route change", async () => {
    setCapabilitiesForTests({ multiUser: true });
    const [collapsed] = createSignal(false);
    const dispose = render(() => <SidebarAccountPanel collapsed={collapsed} />, document.body);
    
    // Open menu
    const toggle = document.querySelector(".sidebar-account-toggle") as HTMLButtonElement;
    toggle.click();
    
    expect(document.querySelector(".account-menu")).not.toBeNull();
    
    // Change route
    setPathname("/chat/agent");
    
    // Wait for effect to run
    await new Promise((resolve) => setTimeout(resolve, 0));
    
    // Menu should close
    expect(document.querySelector(".account-menu")).toBeNull();
    
    dispose();
  });
});
