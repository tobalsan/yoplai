// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, within } from "@testing-library/dom";

vi.mock("../components/LeftNavShell", () => ({ LeftNavShell: (props: { children: unknown }) => props.children }));

import type { LinkRow } from "../api/relay-link";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";
import { RemoteGateways } from "./RemoteGateways";

/** The local gateway is a scripted fake at the fetch edge. Each request is recorded with its URL, headers and body. */
type Sent = { url: string; headers: Headers; body: Record<string, unknown> | undefined };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, error: string, message: string) => json(status, { error, message });

let sent: Sent[];
let rows: LinkRow[];
/** The answers of the status route, in order. The last one repeats. */
let statuses: Array<Response>;
let startAnswer: Response;
let cancelAnswer: Response;
let disconnectAnswers: Response[];
let metadataAnswer: (() => Response) | undefined;
/** While set, the metadata route answers only after this promise settles. */
let metadataHold: Promise<void> | undefined;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  sent.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
  if (url === "/api/relay/link/metadata") {
    const signal = init?.signal;
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    await Promise.race([metadataHold, aborted]);
    return metadataAnswer ? metadataAnswer() : json(200, { gateways: rows });
  }
  if (url === "/api/relay/link/start") return startAnswer.clone();
  if (url.startsWith("/api/relay/link/status/")) return (statuses.length > 1 ? statuses.shift()! : statuses[0]).clone();
  if (url === "/api/relay/link/cancel") return cancelAnswer.clone();
  if (url === "/api/relay/link/disconnect") return (disconnectAnswers.length > 1 ? disconnectAnswers.shift()! : disconnectAnswers[0]).clone();
  throw new Error(`unexpected request ${url}`);
});
const requestsTo = (prefix: string) => sent.filter((request) => request.url.startsWith(prefix));
let openedPages: string[];

const REMOTE = "https://remote.example.test";
const browserRow = (overrides: Partial<LinkRow> = {}): LinkRow => ({
  name: "work",
  remote: REMOTE,
  kind: "browser",
  account: "alice@example.test",
  deviceLabel: "Work laptop",
  linkId: "link-1",
  expiresAt: "2026-04-02T00:00:00.000Z",
  keyState: "active",
  connection: "connected",
  ...overrides,
});
const manualRow: LinkRow = { name: "manual", remote: "https://manual.example.test", kind: "token", account: null, deviceLabel: null, linkId: null, expiresAt: null, keyState: "unknown", connection: "offline" };
const pendingStart = { attemptId: "a".repeat(43), controlToken: "c".repeat(43), expiresAt: "2026-01-01T00:05:00.000Z", consentUrl: `${REMOTE}/gateway-link?request=req-1` };
const pending = { status: "pending", name: "work", remote: REMOTE };

let root: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount() {
  const history = createMemoryHistory();
  history.set({ value: "/remote-gateways", replace: true });
  dispose = render(
    () => (
      <MemoryRouter history={history} root={(props: { children?: JSX.Element }) => <Suspense>{props.children}</Suspense>}>
        <Route path="/remote-gateways" component={RemoteGateways} />
      </MemoryRouter>
    ),
    root,
  );
  return within(root);
}

const flush = () => vi.advanceTimersByTimeAsync(1600);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  sent = [];
  rows = [];
  statuses = [json(200, pending)];
  startAnswer = json(201, pendingStart);
  cancelAnswer = json(200, { status: "cancelled", name: "work", remote: REMOTE });
  disconnectAnswers = [json(200, { name: "work", revoked: "remote" })];
  metadataAnswer = undefined;
  metadataHold = undefined;
  openedPages = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  vi.spyOn(window, "open").mockImplementation((url) => {
    openedPages.push(String(url));
    return null;
  });
  setCapabilitiesForTests({ relayLink: { available: true } });
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RemoteGateways", () => {
  it("shows the link form with no saved gateway, and an empty list", async () => {
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole("textbox", { name: /Remote gateway address/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link gateway" })).toBeTruthy();
    expect(screen.getByText("No gateway is linked.")).toBeTruthy();
  });

  it("hides the form and says why when this gateway cannot receive the callback", async () => {
    setCapabilitiesForTests({ relayLink: { available: false } });
    rows = [browserRow()];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("button", { name: "Link gateway" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("127.0.0.1");
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link work again" })).toBeNull();
  });

  it("lists each link with account, device, key state, and connection state, and unknown fields for a manual link", async () => {
    rows = [browserRow({ connection: "replaced" }), manualRow, browserRow({ name: "old", keyState: "expired", connection: "unauthorized" })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getAllByText(/Account: alice@example.test · Device: Work laptop/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Account: unknown · Device: unknown/)).toBeTruthy();
    expect(screen.getByText(/Key state unknown/)).toBeTruthy();
    expect(screen.getByText(/Device link replaced/)).toBeTruthy();
    expect(screen.getByText(/Key expired: link again/)).toBeTruthy();
    expect(screen.getByText(/Device link refused by the remote/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link work again" })).toBeTruthy();
    // A manual link has no browser key, so it has no link-again control.
    expect(screen.queryByRole("button", { name: "Link manual again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect manual" })).toBeTruthy();
  });

  it("starts a link, opens the sign-in page, and shows the linked gateway after approval", async () => {
    statuses = [json(200, pending), json(200, { status: "linked", name: "work", remote: REMOTE })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: ` ${REMOTE} ` } });
    fireEvent.input(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(requestsTo("/api/relay/link/start").map((request) => request.body)).toEqual([{ remote: REMOTE, name: "work" }]);
    expect(openedPages).toEqual([pendingStart.consentUrl]);
    expect(screen.getByRole("link", { name: "Open the sign-in page" }).getAttribute("href")).toBe(pendingStart.consentUrl);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    rows = [browserRow()];
    await flush();
    await flush();
    expect(screen.getByText("Linked work.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect work" })).toBeTruthy();
    // The page sends the control token to the status route and nothing else secret.
    const polls = requestsTo("/api/relay/link/status/");
    expect(polls.length).toBeGreaterThan(1);
    for (const poll of polls) {
      expect(poll.url).toBe(`/api/relay/link/status/${pendingStart.attemptId}`);
      expect(poll.headers.get("x-link-control")).toBe(pendingStart.controlToken);
    }
  });

  it("cancels a pending link", async () => {
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(1);
    const [cancel] = requestsTo("/api/relay/link/cancel");
    expect(cancel.body).toEqual({ attemptId: pendingStart.attemptId });
    expect(cancel.headers.get("x-link-control")).toBe(pendingStart.controlToken);
    expect(screen.getByText("The link was cancelled.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows a refusal on the remote", async () => {
    statuses = [json(200, { status: "denied", name: "work", remote: REMOTE })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await flush();
    expect(screen.getByText("The link was refused on the remote gateway.")).toBeTruthy();
  });

  it("tells the user to revoke at the owner page after an unconfirmed key", async () => {
    statuses = [json(200, {
      status: "uncertain", name: "work", remote: REMOTE,
      message: `The remote gateway may have made a key. Revoke it at ${REMOTE}/account/gateway-links, then link again.`,
      ownerPageUrl: `${REMOTE}/account/gateway-links`,
    })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Revoke it");
    expect(screen.getByRole("link", { name: /linked devices page/ }).getAttribute("href")).toBe(`${REMOTE}/account/gateway-links`);
  });

  it("shows the recovery step of a link that failed on a lock that a dead process left", async () => {
    const message = "Cannot lock remote-gateways.json. Process 4242 died and left the lock file /home/user/.yoplai/remote-gateways.json.lock. Delete that file, then try again. The key of this link was revoked. When the lock is clear, start a new link.";
    statuses = [json(200, { status: "failed", name: "work", remote: REMOTE, message })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await flush();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows the recovery note when a fresh start finds an unconfirmed key", async () => {
    startAnswer = json(201, { ...pendingStart, recoveryNote: "Revoke the old key first." });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("Revoke the old key first.")).toBeTruthy();
  });

  it("links a single-user remote at once with no sign-in page", async () => {
    startAnswer = json(200, { status: "linked", name: "open" });
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(openedPages).toEqual([]);
    expect(screen.getByText(/Linked open/)).toBeTruthy();
  });

  it("shows the gateway message when the start fails", async () => {
    startAnswer = apiError(400, "invalid_remote", "The remote gateway must use https://.");
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: "http://x.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole("alert").textContent).toContain("must use https://");
  });

  it("links a saved gateway again under its own name", async () => {
    rows = [browserRow()];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.click(screen.getByRole("button", { name: "Link work again" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(requestsTo("/api/relay/link/start").map((request) => request.body)).toEqual([{ remote: REMOTE, name: "work" }]);
  });

  it("disconnects a link, and offers a local-only removal with a warning when the remote does not confirm", async () => {
    rows = [browserRow()];
    disconnectAnswers = [apiError(502, "revoke_failed", "The remote gateway did not confirm the revoke. The link stays."), json(200, { name: "work", revoked: "skipped" })];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("button", { name: /from this computer only/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect work" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(requestsTo("/api/relay/link/disconnect").map((request) => request.body)).toEqual([{ name: "work", localOnly: false }]);
    expect(screen.getByRole("alert").textContent).toContain("did not confirm the revoke");
    expect(screen.getByText("The remote key remains valid until revocation or expiry.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove work from this computer only" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(requestsTo("/api/relay/link/disconnect").map((request) => request.body)).toEqual([
      { name: "work", localOnly: false },
      { name: "work", localOnly: true },
    ]);
    expect(screen.getByText(/Removed work from this computer/)).toBeTruthy();
  });

  it("reads the saved links again after a reload, with no attempt in memory", async () => {
    rows = [browserRow()];
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("work")).toBeTruthy();
    expect(requestsTo("/api/relay/link/status/")).toEqual([]);
  });

  it("explains a gateway with linked gateways turned off", async () => {
    metadataAnswer = () => apiError(403, "relay_unavailable", "Linked gateways are off for this gateway.");
    const screen = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByText("Linked gateways are off for this gateway.")).toBeTruthy();
  });

  describe("after a link", () => {
    const metadataReads = () => requestsTo("/api/relay/link/metadata").length;
    const linkAtOnce = async (screen: ReturnType<typeof mount>) => {
      fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
      fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
      await vi.advanceTimersByTimeAsync(1);
    };

    it("reads connecting as Device connecting and offline as Device not connected", async () => {
      rows = [browserRow({ name: "a", connection: "connecting" }), browserRow({ name: "b", connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      expect(screen.getAllByText("Device connecting…")).toHaveLength(1);
      expect(screen.getAllByText("Device not connected")).toHaveLength(1);
    });

    it("shows offline, then connecting, then connected, and stops reading when connected", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      rows = [browserRow({ connection: "offline" })];
      await linkAtOnce(screen);
      expect(screen.getByText("Device connecting…")).toBeTruthy();
      expect(screen.queryByText("Device not connected")).toBeNull();
      rows = [browserRow({ connection: "connecting" })];
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connecting…")).toBeTruthy();
      rows = [browserRow({ connection: "connected" })];
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connected")).toBeTruthy();
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(20000);
      expect(metadataReads()).toBe(reads);
    });

    it("stops on replaced and on unauthorized", async () => {
      for (const connection of ["replaced", "unauthorized"] as const) {
        startAnswer = json(200, { status: "linked", name: "work" });
        rows = [browserRow({ connection: "offline" })];
        const screen = mount();
        await vi.advanceTimersByTimeAsync(1);
        await linkAtOnce(screen);
        rows = [browserRow({ connection })];
        await vi.advanceTimersByTimeAsync(2000);
        const reads = metadataReads();
        await vi.advanceTimersByTimeAsync(20000);
        expect(metadataReads()).toBe(reads);
        dispose?.();
        dispose = undefined;
        sent = [];
      }
    });

    it("gives up after 30 reads while the row stays offline, and a new link starts a new cycle", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      await linkAtOnce(screen);
      const before = metadataReads();
      await vi.advanceTimersByTimeAsync(2000 * 40);
      expect(metadataReads() - before).toBe(30);
      await vi.advanceTimersByTimeAsync(20000);
      expect(metadataReads() - before).toBe(30);
      await linkAtOnce(screen);
      const restarted = metadataReads();
      await vi.advanceTimersByTimeAsync(2000 * 3);
      expect(metadataReads()).toBeGreaterThan(restarted + 1);
    });

    it("starts a cycle on page load when a row is connecting", async () => {
      rows = [browserRow({ connection: "connecting" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      expect(screen.getByText("Device connecting…")).toBeTruthy();
      rows = [browserRow({ connection: "connected" })];
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connected")).toBeTruthy();
    });

    it("reads offline as Device not connected again when the cycle gives up", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      await linkAtOnce(screen);
      expect(screen.getByText("Device connecting…")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2000 * 40);
      expect(screen.getByText("Device not connected")).toBeTruthy();
    });

    it("starts no cycle on page load when no row is connecting", async () => {
      rows = [browserRow({ connection: "offline" })];
      mount();
      await vi.advanceTimersByTimeAsync(1);
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(10000);
      expect(metadataReads()).toBe(reads);
    });

    it("stops reading when the page closes", async () => {
      rows = [browserRow({ connection: "connecting" })];
      mount();
      await vi.advanceTimersByTimeAsync(1);
      dispose?.();
      dispose = undefined;
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(10000);
      expect(metadataReads()).toBe(reads);
    });

    /** Holds the next metadata reads until the returned function runs. */
    const holdReads = () => {
      let release = () => {};
      metadataHold = new Promise<void>((resolve) => { release = resolve; });
      return () => { metadataHold = undefined; release(); };
    };
    /** Links through the sign-in path: the status route answers `linked` on the first poll. */
    const linkAfterApproval = async (screen: ReturnType<typeof mount>) => {
      startAnswer = json(201, pendingStart);
      statuses = [json(200, { status: "linked", name: "work", remote: REMOTE })];
      fireEvent.input(screen.getByRole("textbox", { name: /Remote gateway address/ }), { target: { value: REMOTE } });
      fireEvent.click(screen.getByRole("button", { name: "Link gateway" }));
      await vi.advanceTimersByTimeAsync(1600);
    };

    it("reads no more after the page closes during the read that follows an immediate link", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      const release = holdReads();
      await linkAtOnce(screen);
      dispose?.();
      dispose = undefined;
      release();
      await vi.advanceTimersByTimeAsync(1);
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(10000);
      expect(metadataReads()).toBe(reads);
    });

    it("reads no more after the page closes during the read that follows an approved link", async () => {
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      const release = holdReads();
      await linkAfterApproval(screen);
      dispose?.();
      dispose = undefined;
      release();
      await vi.advanceTimersByTimeAsync(1);
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(10000);
      expect(metadataReads()).toBe(reads);
    });

    it("still reads again when the first read after an immediate link fails", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      metadataAnswer = () => { metadataAnswer = undefined; return apiError(500, "failed", "The read failed."); };
      await linkAtOnce(screen);
      rows = [browserRow({ connection: "connected" })];
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connected")).toBeTruthy();
    });

    it("still reads again when the first read after an approved link fails", async () => {
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      metadataAnswer = () => { metadataAnswer = undefined; return apiError(500, "failed", "The read failed."); };
      await linkAfterApproval(screen);
      rows = [browserRow({ connection: "connected" })];
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connected")).toBeTruthy();
    });

    it("starts no second read when a link finishes while a timer read is pending", async () => {
      rows = [browserRow({ connection: "connecting" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      const release = holdReads();
      await vi.advanceTimersByTimeAsync(2000);
      const reads = metadataReads();
      startAnswer = json(200, { status: "linked", name: "work" });
      await linkAtOnce(screen);
      expect(metadataReads()).toBe(reads);
      rows = [browserRow({ connection: "connected" })];
      release();
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByText("Device connected")).toBeTruthy();
    });

    it("ends a metadata read that never answers, keeps one read in flight, and recovers on the next read", async () => {
      startAnswer = json(200, { status: "linked", name: "work" });
      rows = [browserRow({ connection: "offline" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      holdReads();
      const before = metadataReads();
      await linkAtOnce(screen);
      await vi.advanceTimersByTimeAsync(9000);
      expect(metadataReads() - before).toBe(1);
      expect((screen.getByRole("button", { name: "Link gateway" }) as HTMLButtonElement).disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect((screen.getByRole("button", { name: "Link gateway" }) as HTMLButtonElement).disabled).toBe(false);
      metadataHold = undefined;
      rows = [browserRow({ connection: "connected" })];
      await vi.advanceTimersByTimeAsync(2500);
      expect(screen.getByText("Device connected")).toBeTruthy();
      expect(screen.queryByText("Loading linked gateways…")).toBeNull();
    });

    it("stops reading when the user disconnects", async () => {
      rows = [browserRow({ connection: "connecting" })];
      const screen = mount();
      await vi.advanceTimersByTimeAsync(1);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect work" }));
      rows = [];
      await vi.advanceTimersByTimeAsync(1);
      const reads = metadataReads();
      await vi.advanceTimersByTimeAsync(10000);
      expect(metadataReads()).toBe(reads);
    });
  });
});
