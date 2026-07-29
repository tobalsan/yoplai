// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ExtensionCatalogEntry } from "../api/extensions";

const {
  fetchAgentExtensionMock,
  patchAgentExtensionMock,
  useSessionMock,
  useParamsMock,
  navigateMock,
} = vi.hoisted(() => ({
  fetchAgentExtensionMock: vi.fn(),
  patchAgentExtensionMock: vi.fn(),
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
    fetchAgentExtension: fetchAgentExtensionMock,
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

import { ExtensionConfigForm } from "./ExtensionConfigForm";

function exaEntry(
  partial: Partial<ExtensionCatalogEntry> = {}
): ExtensionCatalogEntry {
  return {
    id: "exa",
    displayName: "Exa",
    description: "Exa web search",
    builtIn: false,
    enabled: false,
    configured: false,
    missingConfig: [],
    configurable: true,
    configJsonSchema: {
      type: "object",
      properties: { apiKey: { type: "string" } },
      required: ["apiKey"],
    },
    requiredSecrets: ["apiKey"],
    advancedConfigFields: [],
    configValues: {},
    configRoutePath: null,
    tier: "auto-form",
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
  dispose = render(() => <ExtensionConfigForm />, container);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fetchAgentExtensionMock.mockReset();
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

describe("ExtensionConfigForm", () => {
  it("renders a masked secret input for the exa apiKey field", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(exaEntry());
    await mount("scribe", "exa");

    expect(fetchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa");
    expect(container.querySelector(".ext-config-title")?.textContent).toBe(
      "Configure Exa"
    );
    const input = container.querySelector<HTMLInputElement>(
      "#ext-field-apiKey"
    )!;
    expect(input).not.toBeNull();
    // requiredSecrets fields render as masked/secret inputs.
    expect(input.type).toBe("password");
  });

  it("submits secrets via the write path and enables the extension", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(exaEntry());
    patchAgentExtensionMock.mockResolvedValue([exaEntry({ enabled: true })]);
    await mount("scribe", "exa");

    const input = container.querySelector<HTMLInputElement>(
      "#ext-field-apiKey"
    )!;
    input.value = "sk-exa-123";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = container.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: true,
      config: {},
      secrets: { apiKey: "sk-exa-123" },
    });
    expect(container.querySelector(".ext-config-saved")?.textContent).toBe(
      "Saved ✓"
    );
  });

  it("prefills existing config values and redacts existing secrets", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(
      exaEntry({
        configJsonSchema: {
          type: "object",
          properties: {
            apiKey: { type: "string" },
            baseUrl: { type: "string" },
          },
          required: ["apiKey"],
        },
        configValues: { apiKey: "********", baseUrl: "https://api.exa.ai" },
      })
    );
    patchAgentExtensionMock.mockResolvedValue([exaEntry({ enabled: true })]);
    await mount("scribe", "exa");

    expect(container.querySelector<HTMLInputElement>("#ext-field-apiKey")?.value).toBe(
      "********"
    );
    expect(container.querySelector<HTMLInputElement>("#ext-field-baseUrl")?.value).toBe(
      "https://api.exa.ai"
    );

    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: true,
      config: { baseUrl: "https://api.exa.ai" },
      secrets: {},
    });
  });

  it("blocks submit and warns when a required field is blank", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(exaEntry());
    await mount("scribe", "exa");

    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).not.toHaveBeenCalled();
    expect(container.querySelector(".ext-config-form-error")?.textContent).toContain(
      "Api Key"
    );
  });

  it("persists non-secret fields as plain config values", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(
      exaEntry({
        configJsonSchema: {
          type: "object",
          properties: {
            apiKey: { type: "string" },
            baseUrl: { type: "string" },
          },
          required: ["apiKey"],
        },
      })
    );
    patchAgentExtensionMock.mockResolvedValue([exaEntry({ enabled: true })]);
    await mount("scribe", "exa");

    const apiKey = container.querySelector<HTMLInputElement>(
      "#ext-field-apiKey"
    )!;
    apiKey.value = "sk-1";
    apiKey.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const baseUrl = container.querySelector<HTMLInputElement>(
      "#ext-field-baseUrl"
    )!;
    // Non-secret field renders as a plain text input.
    expect(baseUrl.type).toBe("text");
    baseUrl.value = "https://api.exa.ai";
    baseUrl.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchAgentExtensionMock).toHaveBeenCalledWith("scribe", "exa", {
      enabled: true,
      config: { baseUrl: "https://api.exa.ai" },
      secrets: { apiKey: "sk-1" },
    });
  });

  it("collapses advanced fields behind a uniform disclosure", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(
      exaEntry({
        configJsonSchema: {
          type: "object",
          properties: {
            apiKey: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["apiKey"],
        },
        advancedConfigFields: ["timeoutMs"],
      })
    );
    await mount("scribe", "exa");

    expect(container.querySelector("#ext-field-apiKey")).not.toBeNull();
    expect(container.querySelector("#ext-field-timeoutMs")).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(
      ".ext-config-advanced-toggle"
    )!;
    expect(toggle.textContent).toContain("See advanced settings");
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector(".ext-config-advanced-note")?.textContent).toContain(
      "only be edited if you know exactly what you're doing"
    );
    expect(container.querySelector("#ext-field-timeoutMs")).not.toBeNull();
  });

  it("shows an error when the save fails", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(exaEntry());
    patchAgentExtensionMock.mockRejectedValue(new Error("write failed"));
    await mount("scribe", "exa");

    const input = container.querySelector<HTMLInputElement>(
      "#ext-field-apiKey"
    )!;
    input.value = "sk-x";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector(".ext-config-form-error")?.textContent).toBe(
      "write failed"
    );
  });

  it("shows not-found when the extension is absent from the catalog", async () => {
    setSession("admin");
    fetchAgentExtensionMock.mockResolvedValue(null);
    await mount("scribe", "ghost");

    expect(container.textContent).toContain("Extension not found");
  });

  it("allows a non-admin to configure an accessible team agent", async () => {
    setSession("user");
    fetchAgentExtensionMock.mockResolvedValue(exaEntry());
    await mount("scribe", "exa");

    expect(navigateMock).not.toHaveBeenCalledWith("/", { replace: true });
    expect(container.querySelector(".ext-config-form")).not.toBeNull();
  });
});
