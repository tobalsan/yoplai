// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { ExtensionCatalogEntry } from "../api/extensions";
import type { McpServer } from "../api/mcp-servers";

const m = vi.hoisted(() => ({
  fetchConnectPrompt: vi.fn(),
  markConnectPromptSeen: vi.fn(),
  fetchTopExtensions: vi.fn(),
  fetchAgentExtensions: vi.fn(),
  patchAgentExtension: vi.fn(),
  fetchOAuthScopeState: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchAgents: vi.fn(),
}));

const [pathname, setPathname] = createSignal("/chat/scribe");

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useLocation: () => ({
    get pathname() {
      return pathname();
    },
    search: "",
  }),
}));
vi.mock("../api/connect-prompt", () => ({
  fetchConnectPrompt: m.fetchConnectPrompt,
  markConnectPromptSeen: m.markConnectPromptSeen,
}));
vi.mock("../api/top-extensions", () => ({ fetchTopExtensions: m.fetchTopExtensions }));
vi.mock("../api/agents", () => ({ fetchAgents: m.fetchAgents }));
vi.mock("../api/extensions", () => ({
  detailsPath: (a: string, e: string) => `/agents/${a}/extensions/${e}`,
  fetchAgentExtensions: m.fetchAgentExtensions,
  patchAgentExtension: m.patchAgentExtension,
  fetchOAuthScopeState: m.fetchOAuthScopeState,
}));
vi.mock("../api/mcp-servers", () => ({
  fetchMcpServers: m.fetchMcpServers,
  mcpDisplayName: (name: string, title?: string) => title || name.charAt(0).toUpperCase() + name.slice(1),
}));

const { ConnectToolsPrompt, buildConnectRows } = await import("./ConnectToolsPrompt");
const { setTourStep, openConnectPrompt, clearConnectPromptRequest } = await import("../onboarding/state");
const { TOUR_STEPS } = await import("../onboarding/steps");
// First tour step shown on agent chat pages, and one shown elsewhere (home).
const CHAT_STEP = TOUR_STEPS.findIndex((step) => step.route.test("/chat/scribe"));
const HOME_STEP = TOUR_STEPS.findIndex((step) => step.route.test("/"));
const { setCapabilitiesForTests, resetCapabilitiesForTests } = await import("../lib/capabilities");

const base = {
  builtIn: false,
  configured: true,
  configJsonSchema: null,
  requiredSecrets: [] as string[],
  advancedConfigFields: [],
  configRoutePath: null,
  description: "",
  enabled: true,
  tier: "auto-form",
  configValues: {},
} as unknown as ExtensionCatalogEntry;

const ext = (partial: Partial<ExtensionCatalogEntry>): ExtensionCatalogEntry => ({ ...base, ...partial });
const server = (partial: Partial<McpServer>): McpServer =>
  ({ name: "linear", type: "http", url: "https://mcp.linear.app/mcp", auth: "oauth", state: "disconnected", readOnly: false, ...partial }) as McpServer;

describe("buildConnectRows", () => {
  const top = { extensions: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], mcp: ["https://mcp.linear.app/mcp"] };
  it("derives every row state", () => {
    const rows = buildConnectRows({
      top,
      oauthStates: {
        google: { personal: "connected", team: "disconnected" },
        drive: { personal: "needs_reconnect", team: "connected" },
        github: { personal: "disconnected", team: "connected" },
      },
      extensions: [
        ext({ id: "a", displayName: "A", requiredSecrets: ["k"], personalSecretFields: ["k"] }),
        ext({ id: "b", displayName: "B", requiredSecrets: ["k"], configValues: { k: "***" } }),
        ext({ id: "c", displayName: "C", enabled: false, requiredSecrets: ["k"], personalSecretFields: ["k"] }),
        ext({ id: "d", displayName: "D", oauth: { provider: "slack", scopes: [] }, oauthConnected: false }),
        ext({ id: "e", displayName: "E", configured: false, requiredSecrets: ["k"] }),
        // Only one of two required secrets: still needs setup.
        ext({ id: "h", displayName: "H", configured: false, requiredSecrets: ["k", "s"], personalSecretFields: ["k"] }),
        // Disabled: `configured` is not checked yet, so every secret must be covered.
        ext({ id: "k", displayName: "K", enabled: false, requiredSecrets: ["k", "s"], personalSecretFields: ["k"] }),
        ext({ id: "l", displayName: "L", enabled: false, requiredSecrets: ["k"] }),
        // Broken personal grant asks for reconnect instead of using the team's.
        ext({ id: "i", displayName: "I", oauth: { provider: "drive", scopes: [] }, oauthConnected: true }),
        ext({ id: "j", displayName: "J", oauth: { provider: "github", scopes: [] }, oauthConnected: true }),
        ext({ id: "f", displayName: "F", oauth: { provider: "google", scopes: [] }, oauthConnected: true }),
        ext({ id: "g", displayName: "G" }),
        ext({ id: "mcp", displayName: "MCP", requiredSecrets: ["k"] }),
        ext({ id: "z", displayName: "Z", requiredSecrets: ["k"] }),
      ],
      servers: [
        server({}),
        server({ name: "other", url: "https://other.example/mcp" }),
        server({ name: "linear_2", url: "https://MCP.linear.app/mcp/", personalState: "connected", iconUrl: "https://linear.app/icon.png" }),
        server({ name: "linear_3", url: "https://mcp.linear.app/mcp", personalState: "needs_reconnect", teamState: "connected" }),
      ],
    });
    expect(rows.find((r) => r.key === "mcp:linear_2")?.iconDataUri).toBe("https://linear.app/icon.png");
    const states = Object.fromEntries(rows.map((r) => [r.key, r.state]));
    expect(states).toEqual({
      "ext:a": "connected",
      "ext:b": "team",
      "ext:c": "enable",
      "ext:d": "connect",
      "ext:e": "setup",
      "ext:f": "connected",
      "ext:h": "setup",
      "ext:i": "connect",
      "ext:j": "team",
      "ext:k": "setup",
      "ext:l": "setup",
      "mcp:linear": "connect",
      "mcp:linear_2": "connected",
      "mcp:linear_3": "connect",
    });
  });
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

let container: HTMLElement;
let dispose: () => void;

async function mount() {
  dispose = render(() => <ConnectToolsPrompt />, container);
  await flush();
}

describe("ConnectToolsPrompt", () => {
  beforeEach(() => {
    setCapabilitiesForTests({ multiUser: true, user: { id: "u1", role: "user" } } as never);
    setTourStep(null);
    clearConnectPromptRequest();
    setPathname("/chat/scribe");
    m.fetchConnectPrompt.mockReset().mockResolvedValue({ supported: true, seen: false, at: null });
    m.markConnectPromptSeen.mockReset().mockResolvedValue({ supported: true, seen: true, at: "t" });
    m.fetchTopExtensions.mockReset().mockResolvedValue({ extensions: ["exa", "notion", "gmail"], mcp: [] });
    m.fetchAgents.mockReset().mockResolvedValue([{ id: "scribe", name: "Scribe" }]);
    m.fetchMcpServers.mockReset().mockResolvedValue({ servers: [], canConfigureTeam: true });
    m.fetchOAuthScopeState.mockReset().mockResolvedValue("disconnected");
    m.patchAgentExtension.mockReset();
    m.fetchAgentExtensions.mockReset().mockResolvedValue([
      ext({ id: "exa", displayName: "Exa", configured: false, requiredSecrets: ["k"] }),
      ext({ id: "notion", displayName: "Notion", enabled: false, requiredSecrets: ["k"], personalSecretFields: ["k"], personalConfigValues: { region: "eu" } }),
      ext({ id: "gmail", displayName: "Gmail", oauth: { provider: "google", scopes: ["a"], personalScopes: ["p"] }, oauthConnected: false }),
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    dispose?.();
    container.remove();
    resetCapabilitiesForTests();
    vi.restoreAllMocks();
  });

  it("shows rows with the right actions and marks seen on Continue", async () => {
    await mount();
    expect(container.querySelector("#connect-prompt-title")?.textContent).toBe("Connect Scribe to your tools");
    expect(container.textContent).toContain("These are the recommended extensions for Scribe.");
    const state = (key: string) => container.querySelector(`[data-row="${key}"]`)?.getAttribute("data-state");
    expect([state("ext:exa"), state("ext:notion"), state("ext:gmail")]).toEqual(["setup", "enable", "connect"]);
    expect(container.querySelector<HTMLAnchorElement>('[data-row="ext:exa"] a')?.getAttribute("href")).toBe(
      "/agents/scribe/extensions/exa"
    );
    expect(container.querySelector<HTMLAnchorElement>('a[href="/agents/scribe/edit"]')?.textContent?.trim()).toBe(
      "Browse all connectors or add a custom one"
    );
    expect(container.textContent).toContain("Want to see more?");
    const continueButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Continue")!;
    continueButton.click();
    await flush();
    expect(m.markConnectPromptSeen).toHaveBeenCalledWith("scribe");
    expect(container.querySelector(".connect-prompt")).toBeNull();
  });

  it("opens a personal-scope OAuth popup from Connect", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await mount();
    container.querySelector<HTMLButtonElement>('[data-row="ext:gmail"] button')!.click();
    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0][0]);
    expect(url).toContain("/api/oauth/google/authorize?");
    expect(url).toContain("scope=personal");
    expect(url).toContain("agent=scribe");
  });

  it("enables an extension in one click and refreshes the row", async () => {
    await mount();
    m.fetchAgentExtensions.mockResolvedValue([
      ext({ id: "exa", displayName: "Exa", configured: false, requiredSecrets: ["k"] }),
      ext({ id: "notion", displayName: "Notion", requiredSecrets: ["k"], personalSecretFields: ["k"] }),
      ext({ id: "gmail", displayName: "Gmail", oauth: { provider: "google", scopes: [] }, oauthConnected: false }),
    ]);
    m.patchAgentExtension.mockResolvedValue([]);
    container.querySelector<HTMLButtonElement>('[data-row="ext:notion"] button')!.click();
    await flush();
    // Personal scope so members can enable; own overrides are resent so they survive.
    expect(m.patchAgentExtension).toHaveBeenCalledWith("scribe", "notion", { credentialScope: "personal", config: { region: "eu" } });
    expect(container.querySelector('[data-row="ext:notion"]')?.getAttribute("data-state")).toBe("connected");
  });

  it("enables an OAuth extension once its personal grant lands", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await mount();
    container.querySelector<HTMLButtonElement>('[data-row="ext:gmail"] button')!.click();
    m.fetchAgentExtensions.mockResolvedValue([
      ext({ id: "gmail", displayName: "Gmail", enabled: false, oauth: { provider: "google", scopes: [] }, oauthConnected: true }),
    ]);
    m.fetchOAuthScopeState.mockImplementation(async (_a: string, _p: string, scope: string) => (scope === "personal" ? "connected" : "disconnected"));
    m.patchAgentExtension.mockResolvedValue([]);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth" } }));
    await flush();
    expect(m.patchAgentExtension).toHaveBeenCalledWith("scribe", "gmail", { credentialScope: "personal", config: {} });
  });

  it("ignores reopen requests while a tour step shows here and closes when one appears", async () => {
    setTourStep(CHAT_STEP);
    await mount();
    openConnectPrompt("scribe");
    await flush();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    setTourStep(null);
    await flush();
    expect(container.querySelector(".connect-prompt")).not.toBeNull();
    setTourStep(CHAT_STEP);
    await flush();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    expect(m.markConnectPromptSeen).not.toHaveBeenCalled();
  });

  it("stays hidden while a tour step shows on this chat page, then opens when the tour ends", async () => {
    setTourStep(CHAT_STEP);
    await mount();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    expect(m.fetchConnectPrompt).not.toHaveBeenCalled();
    setTourStep(null);
    await flush();
    expect(container.querySelector(".connect-prompt")).not.toBeNull();
  });

  it("shows for a new user landing in chat while the pending tour step waits on another page", async () => {
    expect(HOME_STEP).toBeGreaterThanOrEqual(0);
    setTourStep(HOME_STEP);
    await mount();
    expect(container.querySelector(".connect-prompt")).not.toBeNull();
    // Following the tour home brings its step on screen there and closes the prompt unseen.
    setPathname("/");
    await flush();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    expect(m.markConnectPromptSeen).not.toHaveBeenCalled();
  });

  it("stays hidden once seen", async () => {
    m.fetchConnectPrompt.mockResolvedValue({ supported: true, seen: true, at: "t" });
    await mount();
    expect(container.querySelector(".connect-prompt")).toBeNull();
  });

  it("stays hidden, without marking seen, when everything is connected", async () => {
    m.fetchAgentExtensions.mockResolvedValue([
      ext({ id: "exa", displayName: "Exa", requiredSecrets: ["k"], personalSecretFields: ["k"] }),
    ]);
    await mount();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    expect(m.markConnectPromptSeen).not.toHaveBeenCalled();
  });

  it("stays hidden off agent chat routes", async () => {
    setPathname("/projects");
    await mount();
    expect(container.querySelector(".connect-prompt")).toBeNull();
  });

  it("reopens on request even when seen and all connected, and closes on Escape", async () => {
    m.fetchConnectPrompt.mockResolvedValue({ supported: true, seen: true, at: "t" });
    m.fetchAgentExtensions.mockResolvedValue([
      ext({ id: "exa", displayName: "Exa", requiredSecrets: ["k"], personalSecretFields: ["k"] }),
    ]);
    await mount();
    openConnectPrompt("scribe");
    await flush();
    expect(container.querySelector('[data-row="ext:exa"]')?.textContent).toContain("Connected");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(container.querySelector(".connect-prompt")).toBeNull();
    expect(m.markConnectPromptSeen).toHaveBeenCalledWith("scribe");
  });

  it("shows a loader while a manually opened prompt loads its rows", async () => {
    let releaseMcp: (value: { servers: never[]; canConfigureTeam: boolean }) => void = () => undefined;
    await mount();
    m.fetchMcpServers.mockReturnValue(new Promise((resolve) => (releaseMcp = resolve)));
    openConnectPrompt("scribe");
    await flush();
    expect(container.querySelector(".connect-prompt-loading")).not.toBeNull();
    expect(container.querySelector(".connect-prompt-row")).toBeNull();
    releaseMcp({ servers: [], canConfigureTeam: true });
    await flush();
    expect(container.querySelector(".connect-prompt-loading")).toBeNull();
    expect(container.querySelector('[data-row="ext:gmail"]')).not.toBeNull();
  });
});
