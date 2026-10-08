// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ExtensionCatalogEntry } from "../api/extensions";

const {
  fetchAgentExtensionsMock,
  useSessionMock,
  useParamsMock,
  navigateMock,
  patchAgentExtensionMock,
} = vi.hoisted(() => ({
  patchAgentExtensionMock: vi.fn(),
  fetchAgentExtensionsMock: vi.fn(),
  useSessionMock: vi.fn(),
  useParamsMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("../api/extensions", async () => {
  const actual =
    await vi.importActual<typeof import("../api/extensions")>(
      "../api/extensions"
    );
  return {
    ...actual,
    fetchAgentExtensions: fetchAgentExtensionsMock,
    patchAgentExtension: patchAgentExtensionMock,
  };
});

vi.mock("../auth/client", () => ({ useSession: useSessionMock }));

vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; class?: string; children: unknown }) => {
    const a = document.createElement("a");
    a.setAttribute("href", props.href);
    if (props.class) a.className = props.class;
    a.textContent = String(props.children ?? "");
    return a;
  },
  useParams: () => useParamsMock(),
  useNavigate: () => navigateMock,
}));

import { ExtensionDetails } from "./ExtensionDetails";

function entry(
  partial: Partial<ExtensionCatalogEntry> = {}
): ExtensionCatalogEntry {
  return {
    id: "exa",
    displayName: "Exa",
    description: "Exa web search",
    builtIn: false,
    enabled: true,
    configured: true,
    missingConfig: [],
    configurable: true,
    managedAtRoot: false,
    configJsonSchema: null,
    requiredSecrets: [],
    advancedConfigFields: [],
    configValues: {},
    configRoutePath: null,
    oauth: null,
    tier: "toggle-only",
    ...partial,
  };
}

function setSession(role: string | null) {
  useSessionMock.mockReturnValue(() => ({
    isPending: false,
    data: role ? { user: { role } } : { user: {} },
  }));
}

let container: HTMLElement;
let dispose: () => void;

async function mount(agentId: string, extensionId: string) {
  useParamsMock.mockReturnValue({ agentId, extensionId });
  dispose = render(() => <ExtensionDetails />, container);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fetchAgentExtensionsMock.mockReset();
  patchAgentExtensionMock.mockReset();
  useSessionMock.mockReset();
  useParamsMock.mockReset();
  navigateMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
});

describe("ExtensionDetails", () => {
  it("renders the extension name and description", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([entry()]);
    await mount("scribe", "exa");

    expect(fetchAgentExtensionsMock).toHaveBeenCalledWith("scribe");
    expect(container.querySelector(".ext-details-name")?.textContent).toBe(
      "Exa"
    );
    expect(container.querySelector(".ext-details-desc")?.textContent).toBe(
      "Exa web search"
    );
  });

  it("shows a not-found message when the extension id is unknown", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([entry()]);
    await mount("scribe", "ghost");

    expect(container.textContent).toContain("Extension not found");
  });

  it("allows a non-admin to view an accessible team agent extension", async () => {
    setSession("user");
    fetchAgentExtensionsMock.mockResolvedValue([entry()]);
    await mount("scribe", "exa");

    expect(navigateMock).not.toHaveBeenCalledWith("/", { replace: true });
    expect(container.querySelector(".ext-details")).not.toBeNull();
  });

  it("renders auto-form settings inline, with no extra Configure step", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([entry({
      tier: "auto-form",
      configJsonSchema: { type: "object", properties: { apiKey: { type: "string" } } },
      requiredSecrets: ["apiKey"],
    })]);
    await mount("scribe", "exa");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector(".ext-details-name")?.textContent).toBe("Exa");
    expect(container.querySelector("#ext-field-apiKey")).not.toBeNull();
    expect(container.querySelector("a.ext-details-configure")).toBeNull();
    expect(container.querySelector(".ext-details-settings")).toBeNull();
    expect(container.querySelector(".ext-config-panel .ext-config-save")).not.toBeNull();
  });

  it("renders a Configure link to the bespoke route when present", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([
      entry({
        tier: "bespoke-route",
        configRoutePath: "/agents/scribe/extensions/slack/setup",
      }),
    ]);
    await mount("scribe", "exa");

    const link = container.querySelector<HTMLAnchorElement>(
      "a.ext-details-configure"
    );
    expect(link?.getAttribute("href")).toBe(
      "/agents/scribe/extensions/slack/setup"
    );
  });

  it("shows Connected when the OAuth grant contains every required scope", async () => {
    setSession("admin");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          state: "connected",
          connected: true,
          provider: "google",
          scopes: ["gmail.modify", "userinfo.email"],
        }),
      })
    );
    fetchAgentExtensionsMock.mockResolvedValue([
      entry({
        oauth: {
          provider: "google",
          scopes: ["gmail.modify", "userinfo.email"],
        },
      }),
    ]);
    await mount("scribe", "exa");

    expect(container.querySelector('.cred-tab[data-scope="team"] .cred-tab-status')?.textContent).toBe(
      "Connected"
    );
    vi.unstubAllGlobals();
  });

  it("renders OAuth grant state and includes required scopes in authorize URL", async () => {
    setSession("admin");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: "connected",
        connected: true,
        provider: "google",
        account: "user@example.com",
        scopes: ["openid"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
    fetchAgentExtensionsMock.mockResolvedValue([
      entry({
        id: "gmail",
        displayName: "Gmail",
        oauth: {
          provider: "google",
          scopes: ["gmail.modify", "userinfo.email"],
        },
      }),
    ]);
    await mount("scribe", "gmail");

    expect(container.textContent).toContain("Not granted");
    expect(container.querySelector(".ext-details-settings")).toBeNull();
    const grant = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Grant Gmail access")
    );
    grant?.click();
    expect(openMock).toHaveBeenCalledWith(
      "/api/oauth/google/authorize?agent=scribe&scopes=gmail.modify%2Cuserinfo.email&scope=personal",
      "yoplai-oauth",
      "width=520,height=640"
    );
    openMock.mockRestore();
    vi.unstubAllGlobals();
  });

  it("enables a toggle-only extension from its details page", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([
      entry({ tier: "toggle-only", enabled: false }),
    ]);
    patchAgentExtensionMock.mockResolvedValue([
      entry({ tier: "toggle-only", enabled: true }),
    ]);
    await mount("scribe", "exa");

    const button = container.querySelector<HTMLButtonElement>(
      "button.ext-details-configure"
    )!;
    expect(button.textContent).toBe("Enable");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: true,
    });
    expect(
      container.querySelector("button.ext-details-configure")?.textContent
    ).toBe("Disable");
  });

  it("locks the toggle for root-managed extensions", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([
      entry({ tier: "toggle-only", managedAtRoot: true }),
    ]);
    await mount("scribe", "exa");

    expect(
      container.querySelector<HTMLButtonElement>("button.ext-details-configure")
        ?.disabled
    ).toBe(true);
  });

  describe("OAuth extension write setting per scope", () => {
    const driveEntry = (partial: Partial<ExtensionCatalogEntry> = {}) => entry({
      id: "drive", displayName: "Google Drive", tier: "auto-form",
      configJsonSchema: { type: "object", properties: { allowWrite: { type: "boolean", title: "Enable creating and writing files" } } },
      configValues: { allowWrite: false }, personalConfigValues: {}, canConfigureTeam: false,
      oauth: { provider: "google", scopes: ["drive.readonly"], personalScopes: ["drive.readonly"] },
      ...partial,
    });
    const writeEntry = (scope: "personal" | "team", canConfigureTeam: boolean) => driveEntry({
      canConfigureTeam,
      ...(scope === "personal"
        ? { personalConfigValues: { allowWrite: true }, oauth: { provider: "google", scopes: ["drive.readonly"], personalScopes: ["drive.readonly", "drive.file", "spreadsheets"] } }
        : { configValues: { allowWrite: true }, oauth: { provider: "google", scopes: ["drive.readonly", "drive.file", "spreadsheets"], personalScopes: ["drive.readonly"] } }),
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const checkbox = () => container.querySelector<HTMLInputElement>("#ext-field-allowWrite")!;
    const tab = (scope: string) => container.querySelector<HTMLButtonElement>(`.cred-tab[data-scope="${scope}"]`)!;
    const connectButton = () => container.querySelector<HTMLButtonElement>(".oauth-btn-primary")!;
    const popup = () => ({ closed: false, close: vi.fn(), location: { replace: vi.fn() } });
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ connected: false, provider: "google" }) })));
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("renders the write setting inside the connect card with no separate panel or Save button", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      await mount("scribe", "drive");
      await flush();
      expect(checkbox().closest(".cred-tabs-panel")).not.toBeNull();
      expect(container.querySelector(".ext-config-panel")).toBeNull();
      expect(container.querySelector(".ext-config-save")).toBeNull();
    });

    it("saves the Whole team setting immediately for an admin", async () => {
      setSession("admin");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry({ canConfigureTeam: true })]);
      patchAgentExtensionMock.mockResolvedValue([writeEntry("team", true)]);
      await mount("scribe", "drive");
      await flush();
      tab("team").click();
      await flush();
      checkbox().click();
      await flush();
      expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "drive", expect.objectContaining({ credentialScope: "team", config: { allowWrite: true } }));
    });

    it("shows an inline error when the immediate save fails", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      patchAgentExtensionMock.mockRejectedValue(new Error("Failed to update extension"));
      await mount("scribe", "drive");
      await flush();
      checkbox().click();
      await flush();
      expect(container.textContent).toContain("Failed to update extension");
    });

    it("lets a non-admin edit and save the Just me setting, then connect with its scopes without reload", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      patchAgentExtensionMock.mockResolvedValue([writeEntry("personal", false)]);
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      await mount("scribe", "drive");
      await flush();
      expect(checkbox().disabled).toBe(false);
      checkbox().click();
      await flush();
      expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "drive", expect.objectContaining({ credentialScope: "personal", config: { allowWrite: true } }));
      expect(container.textContent).toContain("Saved ✓");
      connectButton().click();
      const url = String(open.mock.calls.at(-1)?.[0]);
      expect(url).toContain("drive.file");
      expect(url).toContain("spreadsheets");
      expect(url).toContain("scope=personal");
    });

    it("keeps Whole team read-only for a non-admin and uses team scopes there", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry({ configValues: { allowWrite: true }, oauth: { provider: "google", scopes: ["drive.readonly", "drive.file"], personalScopes: ["drive.readonly"] } })]);
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      await mount("scribe", "drive");
      await flush();
      tab("team").click();
      await flush();
      expect(checkbox().disabled).toBe(true);
      expect(checkbox().checked).toBe(true);
      expect(container.textContent).toContain("These settings are managed by an admin.");
      expect(container.querySelector(".ext-config-save")).toBeNull();
      tab("personal").click();
      await flush();
      expect(checkbox().checked).toBe(false);
      expect(checkbox().disabled).toBe(false);
      connectButton().click();
      expect(String(open.mock.calls.at(-1)?.[0])).not.toContain("drive.file");
    });

    it("saves the ticked Just me setting when Connect is clicked, then opens the reserved popup with the new scopes", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      patchAgentExtensionMock.mockResolvedValue([writeEntry("personal", false)]);
      const reserved = popup();
      const open = vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
      await mount("scribe", "drive");
      await flush();
      checkbox().click();
      connectButton().click();
      expect(open).toHaveBeenCalledWith("", "yoplai-oauth", "width=520,height=640");
      await flush();
      expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "drive", expect.objectContaining({ credentialScope: "personal", config: { allowWrite: true } }));
      const url = String(reserved.location.replace.mock.calls[0]?.[0]);
      expect(url).toContain("drive.file");
      expect(url).toContain("spreadsheets");
      expect(url).toContain("scope=personal");
    });

    it("saves the ticked Whole team setting for an admin on Connect and uses the team scopes", async () => {
      setSession("admin");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry({ canConfigureTeam: true })]);
      patchAgentExtensionMock.mockResolvedValue([writeEntry("team", true)]);
      const reserved = popup();
      vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
      await mount("scribe", "drive");
      await flush();
      tab("team").click();
      await flush();
      checkbox().click();
      connectButton().click();
      await flush();
      expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "drive", expect.objectContaining({ credentialScope: "team", config: { allowWrite: true } }));
      const url = String(reserved.location.replace.mock.calls[0]?.[0]);
      expect(url).toContain("drive.file");
      expect(url).toContain("scope=team");
    });

    it("closes the reserved popup and shows the error when saving on Connect fails", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      patchAgentExtensionMock.mockRejectedValue(new Error("Failed to update extension"));
      const reserved = popup();
      vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
      await mount("scribe", "drive");
      await flush();
      checkbox().click();
      connectButton().click();
      await flush();
      expect(reserved.close).toHaveBeenCalled();
      expect(reserved.location.replace).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Failed to update extension");
    });

    it("keeps the clicked tab's scopes when the tab changes while saving on Connect", async () => {
      setSession("admin");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry({ canConfigureTeam: true })]);
      let resolvePatch!: (value: ExtensionCatalogEntry[]) => void;
      patchAgentExtensionMock.mockReturnValue(new Promise((resolve) => { resolvePatch = resolve; }));
      const reserved = popup();
      vi.spyOn(window, "open").mockReturnValue(reserved as unknown as Window);
      await mount("scribe", "drive");
      await flush();
      checkbox().click();
      connectButton().click();
      tab("team").click();
      resolvePatch([writeEntry("personal", true)]);
      await flush();
      const url = String(reserved.location.replace.mock.calls[0]?.[0]);
      expect(url).toContain("scope=personal");
      expect(url).toContain("drive.file");
    });

    it("does not save on Connect when the checkbox is unchanged", async () => {
      setSession("user");
      fetchAgentExtensionsMock.mockResolvedValue([driveEntry()]);
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      await mount("scribe", "drive");
      await flush();
      connectButton().click();
      await flush();
      expect(patchAgentExtensionMock).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith("/api/oauth/google/authorize?agent=scribe&scopes=drive.readonly&scope=personal", "yoplai-oauth", "width=520,height=640");
    });
  });
});
