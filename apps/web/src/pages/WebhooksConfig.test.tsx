// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal, type JSX } from "solid-js";

const { fetchWebhooksMock, updateWebhookMock, session, route } = vi.hoisted(
  () => ({
    fetchWebhooksMock: vi.fn(),
    updateWebhookMock: vi.fn(),
    route: { agentId: undefined as (() => string) | undefined },
    session: {
      user: { id: "alice", role: "user" } as {
        id: string;
        role: string;
      } | null,
    },
  })
);

vi.mock("@solidjs/router", () => ({
  useParams: () => ({
    get agentId() {
      return route.agentId?.() ?? "scribe";
    },
  }),
  A: (props: { href: string; children?: JSX.Element }) => (
    <a href={props.href}>{props.children}</a>
  ),
}));
vi.mock("../components/LeftNavShell", () => ({
  LeftNavShell: (props: { children?: JSX.Element }) => (
    <div>{props.children}</div>
  ),
}));
vi.mock("../auth/client", () => ({
  useSession: () => () => ({
    data: session.user ? { user: session.user } : null,
  }),
}));
vi.mock("../api/webhooks", () => ({
  fetchWebhooks: fetchWebhooksMock,
  updateWebhook: updateWebhookMock,
}));

import WebhooksConfigPage from "./WebhooksConfig";

let container: HTMLElement;
let dispose: (() => void) | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const WEBHOOK_URL = "https://example.test/hooks/scribe/triage";
const radio = (name: string) =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  ).find((button) => button.textContent === name)!;
const checked = (name: string) =>
  radio(name).getAttribute("aria-checked") === "true";
const toggle = () =>
  container.querySelector<HTMLButtonElement>('[role="switch"]')!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  session.user = { id: "alice", role: "user" };
  route.agentId = undefined;
  fetchWebhooksMock.mockReset().mockResolvedValue([
    {
      name: "triage",
      enabled: true,
      url: WEBHOOK_URL,
      credentialMode: "team",
    },
  ]);
  updateWebhookMock.mockReset().mockResolvedValue({
    name: "triage",
    enabled: true,
    url: WEBHOOK_URL,
    credentialMode: "owner",
    ownerUserId: "alice",
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebhooksConfigPage", () => {
  it("lets a signed-in user run a Team webhook as Mine", async () => {
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Webhooks");
    expect(checked("Team")).toBe(true);
    radio("Mine").click();
    await settle();
    expect(updateWebhookMock).toHaveBeenCalledWith("scribe", "triage", {
      credentialMode: "owner",
    });
    expect(checked("Mine")).toBe(true);
    expect(container.textContent).toContain("Owned by you");
  });
  it.each(["user", "superadmin"])(
    "keeps another owner's webhook read-only for %s",
    async (role) => {
      session.user = { id: "alice", role };
      fetchWebhooksMock.mockResolvedValue([
        {
          name: "triage",
          enabled: true,
          url: WEBHOOK_URL,
          credentialMode: "owner",
          ownerUserId: "bob",
          ownerDisplayName: "Bob",
        },
      ]);
      dispose = render(() => <WebhooksConfigPage />, container);
      await settle();
      expect(container.textContent).toContain("Owned by Bob");
      for (const control of container.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]'
      )) {
        expect(control.disabled).toBe(true);
        control.click();
      }
      expect(updateWebhookMock).not.toHaveBeenCalled();
    }
  );

  it("shows the URL and a disabled switch on another owner's webhook", async () => {
    fetchWebhooksMock.mockResolvedValue([
      {
        name: "triage",
        enabled: true,
        url: WEBHOOK_URL,
        credentialMode: "owner",
        ownerUserId: "bob",
        ownerDisplayName: "Bob",
      },
    ]);
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(toggle().disabled).toBe(true);
    expect(toggle().title).toBe("Only the owner can change this webhook");
    toggle().click();
    expect(updateWebhookMock).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Webhook URL for triage"]'
      )?.value
    ).toBe(WEBHOOK_URL);
  });

  it("lists Mine before Team", async () => {
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    const labels = Array.from(container.querySelectorAll('[role="radio"]')).map(
      (button) => button.textContent
    );
    expect(labels).toEqual(["Mine", "Team"]);
  });

  it("turns a webhook off with the switch", async () => {
    updateWebhookMock.mockResolvedValue({
      name: "triage",
      enabled: false,
      url: WEBHOOK_URL,
      credentialMode: "team",
    });
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(toggle().getAttribute("aria-label")).toBe("Enable triage webhook");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    toggle().click();
    await settle();
    expect(updateWebhookMock).toHaveBeenCalledWith("scribe", "triage", {
      enabled: false,
    });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Disabled");
  });

  it("shows the URL and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Webhook URL for triage"]'
    )!;
    expect(input.value).toBe(WEBHOOK_URL);
    expect(input.readOnly).toBe(true);
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Copy URL for triage"]'
      )!
      .click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(WEBHOOK_URL);
    expect(container.textContent).toContain("Copied");
  });

  it("disables Mine and explains why without an authenticated user", async () => {
    session.user = null;
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(radio("Mine").disabled).toBe(true);
    expect(radio("Team").disabled).toBe(false);
    expect(container.textContent).toContain(
      "Mine requires an authenticated user in multi-user mode."
    );
    radio("Mine").click();
    expect(updateWebhookMock).not.toHaveBeenCalled();
  });

  it("keeps the saved mode and disables duplicate edits while saving", async () => {
    let resolveUpdate!: (value: unknown) => void;
    updateWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    radio("Mine").click();
    await settle();
    expect(radio("Team").disabled).toBe(true);
    expect(radio("Mine").disabled).toBe(true);
    resolveUpdate({
      name: "triage",
      enabled: true,
      url: WEBHOOK_URL,
      credentialMode: "owner",
      ownerUserId: "alice",
    });
    await settle();
    expect(radio("Mine").disabled).toBe(false);
    expect(checked("Mine")).toBe(true);
  });

  it("blocks the switch while a mode save is in flight", async () => {
    let resolveUpdate!: (value: unknown) => void;
    updateWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    radio("Mine").click();
    await settle();
    expect(toggle().disabled).toBe(true);
    toggle().click();
    expect(updateWebhookMock).toHaveBeenCalledTimes(1);
    resolveUpdate({
      name: "triage",
      enabled: true,
      url: WEBHOOK_URL,
      credentialMode: "owner",
      ownerUserId: "alice",
    });
    await settle();
    expect(toggle().disabled).toBe(false);
  });

  it("blocks Runs with while a switch save is in flight", async () => {
    let resolveUpdate!: (value: unknown) => void;
    updateWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    toggle().click();
    await settle();
    expect(radio("Mine").disabled).toBe(true);
    expect(radio("Team").disabled).toBe(true);
    radio("Mine").click();
    expect(updateWebhookMock).toHaveBeenCalledTimes(1);
    resolveUpdate({
      name: "triage",
      enabled: false,
      url: WEBHOOK_URL,
      credentialMode: "team",
    });
    await settle();
    expect(radio("Mine").disabled).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("shows a failed save, keeps Team selected, and allows a retry", async () => {
    updateWebhookMock.mockRejectedValueOnce(
      new Error("Connection lost. Try again.")
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    radio("Mine").click();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Connection lost. Try again."
    );
    expect(checked("Team")).toBe(true);
    expect(radio("Mine").disabled).toBe(false);
    radio("Mine").click();
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(checked("Mine")).toBe(true);
  });

  it("shows loading, reports a failed load, and reloads on Retry", async () => {
    let rejectLoad!: (error: Error) => void;
    fetchWebhooksMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        })
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    expect(container.textContent).toContain("Loading webhooks…");
    rejectLoad(new Error("Webhooks unavailable. Try again."));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Webhooks unavailable. Try again."
    );
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(checked("Team")).toBe(true);
  });

  it("explains an empty webhook list", async () => {
    fetchWebhooksMock.mockResolvedValue([]);
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(container.textContent).toContain(
      "No webhooks configured for this agent."
    );
    expect(container.querySelector('[role="radio"]')).toBeNull();
  });

  it("releases a timed-out save and lets the user retry", async () => {
    vi.useFakeTimers();
    const actual =
      await vi.importActual<typeof import("../api/webhooks")>(
        "../api/webhooks"
      );
    updateWebhookMock.mockImplementation(actual.updateWebhook);
    const request = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "triage",
            enabled: true,
            url: WEBHOOK_URL,
            credentialMode: "owner",
            ownerUserId: "alice",
          })
        )
      );
    vi.stubGlobal("fetch", request);
    dispose = render(() => <WebhooksConfigPage />, container);
    await vi.advanceTimersByTimeAsync(0);
    radio("Mine").click();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Updating webhook timed out. Try again."
    );
    expect(radio("Mine").disabled).toBe(false);
    radio("Mine").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(checked("Mine")).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      "/api/agents/scribe/webhooks/triage",
      expect.objectContaining({
        method: "PATCH",
        body: '{"credentialMode":"owner"}',
        credentials: "include",
      })
    );
  });

  it("times out a stalled load and lets Retry load the list", async () => {
    vi.useFakeTimers();
    const actual =
      await vi.importActual<typeof import("../api/webhooks")>(
        "../api/webhooks"
      );
    fetchWebhooksMock.mockImplementation(actual.fetchWebhooks);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError"))
              );
            })
        )
        .mockResolvedValue(
          new Response(
            JSON.stringify([
              {
                name: "triage",
                enabled: true,
                url: WEBHOOK_URL,
                credentialMode: "team",
              },
            ])
          )
        )
    );
    dispose = render(() => <WebhooksConfigPage />, container);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Loading webhooks timed out. Try again."
    );
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click();
    await vi.advanceTimersByTimeAsync(0);
    expect(checked("Team")).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a previous agent's pending save after navigation", async () => {
    const [agentId, setAgentId] = createSignal("scribe");
    route.agentId = agentId;
    let resolveUpdate!: (value: unknown) => void;
    updateWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    fetchWebhooksMock
      .mockResolvedValueOnce([
        {
          name: "triage",
          enabled: true,
          url: WEBHOOK_URL,
          credentialMode: "team",
        },
      ])
      .mockResolvedValue([
        {
          name: "triage",
          enabled: true,
          url: WEBHOOK_URL,
          credentialMode: "owner",
          ownerUserId: "bob",
          ownerDisplayName: "Bob",
        },
      ]);
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    radio("Mine").click();
    setAgentId("archive");
    await settle();
    expect(container.textContent).toContain("Owned by Bob");
    resolveUpdate({
      name: "triage",
      enabled: true,
      url: WEBHOOK_URL,
      credentialMode: "owner",
      ownerUserId: "alice",
    });
    await settle();
    expect(container.textContent).toContain("Owned by Bob");
    expect(container.textContent).not.toContain("Owned by you");
    expect(radio("Mine").disabled).toBe(true);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/agents/archive/edit"
    );
  });

  it("lets the owner switch back to Team", async () => {
    fetchWebhooksMock.mockResolvedValue([
      {
        name: "triage",
        enabled: true,
        url: WEBHOOK_URL,
        credentialMode: "owner",
        ownerUserId: "alice",
      },
    ]);
    updateWebhookMock.mockResolvedValue({
      name: "triage",
      enabled: true,
      url: WEBHOOK_URL,
      credentialMode: "team",
    });
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    radio("Team").click();
    await settle();
    expect(updateWebhookMock).toHaveBeenCalledWith("scribe", "triage", {
      credentialMode: "team",
    });
    expect(checked("Team")).toBe(true);
    expect(container.textContent).not.toContain("Owned by");
  });
  it("labels a missing owner without claiming anonymous ownership", async () => {
    session.user = null;
    fetchWebhooksMock.mockResolvedValue([
      {
        name: "triage",
        enabled: true,
        url: WEBHOOK_URL,
        credentialMode: "owner",
      },
    ]);
    dispose = render(() => <WebhooksConfigPage />, container);
    await settle();
    expect(container.textContent).toContain("Owner missing");
    expect(container.textContent).not.toContain("Owned by you");
    expect(radio("Team").disabled).toBe(true);
    expect(radio("Mine").disabled).toBe(true);
  });
});
