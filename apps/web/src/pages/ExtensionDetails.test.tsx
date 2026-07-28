// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ExtensionCatalogEntry } from "../api/extensions";

const { fetchAgentExtensionsMock, useSessionMock, useParamsMock, navigateMock } =
  vi.hoisted(() => ({
    fetchAgentExtensionsMock: vi.fn(),
    useSessionMock: vi.fn(),
    useParamsMock: vi.fn(),
    navigateMock: vi.fn(),
  }));

vi.mock("../api/extensions", async () => {
  const actual = await vi.importActual<typeof import("../api/extensions")>(
    "../api/extensions"
  );
  return {
    ...actual,
    fetchAgentExtensions: fetchAgentExtensionsMock,
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

function entry(partial: Partial<ExtensionCatalogEntry> = {}): ExtensionCatalogEntry {
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

  it("renders a Configure link to the auto-form route for auto-form tier", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([entry({ tier: "auto-form" })]);
    await mount("scribe", "exa");

    const link = container.querySelector<HTMLAnchorElement>(
      "a.ext-details-configure"
    );
    expect(link?.getAttribute("href")).toBe(
      "/agents/scribe/extensions/exa/config"
    );
    expect(container.querySelector(".ext-details-settings")).toBeNull();
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

  it("renders the placeholder for toggle-only tier", async () => {
    setSession("admin");
    fetchAgentExtensionsMock.mockResolvedValue([entry({ tier: "toggle-only" })]);
    await mount("scribe", "exa");

    expect(
      container.querySelector(".ext-details-settings")?.textContent
    ).toContain("hasn't adopted the configuration contract");
    expect(container.querySelector(".ext-details-configure")).toBeNull();
  });
});
