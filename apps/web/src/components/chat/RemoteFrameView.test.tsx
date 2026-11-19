// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, getByTitle, queryByRole, queryByText } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { FrameView, type FrameViewProps } from "./FrameView";
import { createDashboardAnnotations, DashboardAnnotationsContext } from "./dashboardAnnotations";
import { PREPARE_TIMEOUT_MS, READY_TIMEOUT_MS } from "./remoteDashboardHost";
import { setThemeChoice } from "../../theme";

const ID = "d".repeat(32);
const NEXT = "e".repeat(32);
const origin = window.location.origin;
const defaultMeta = { dashboardId: ID, agentId: "agent-7", canWrite: true, canEdit: true, chat: { sessionId: "sess-1" }, annotation: true };

type Call = { path: string; body: Record<string, unknown>; signal: AbortSignal; answer(response: Response): void; fail(error: unknown): void };
let calls: Call[];
let container: HTMLDivElement;
let dispose: (() => void) | undefined;
let writeText: ReturnType<typeof vi.fn>;
/** A transport that keeps answering after an abort, so the generation checks of the host must hold. */
let ignoreAbort = false;

const handleOf = (n: number) => String(n).padStart(43, "h");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pathsOf = (path: string) => calls.filter((call) => call.path === path);
const prepares = () => pathsOf("/api/relay/dashboard-views");
const reads = () => pathsOf("/api/relay/dashboard-views/read");
const releases = () => pathsOf("/api/relay/dashboard-views/release");
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls = [];
  ignoreAbort = false;
  history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    // A release request has no signal.
    const signal = init!.signal ?? new AbortController().signal;
    if (!ignoreAbort) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    calls.push({ path: String(input), body: JSON.parse(String(init!.body)), signal, answer: resolve, fail: reject });
  })));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setThemeChoice("dark");
});

type Props = Partial<FrameViewProps> & { chatAgent?: string };
function mount(props: Props = {}) {
  const annotations = createDashboardAnnotations(() => props.chatAgent ?? "agent-7@east");
  const [target, setTarget] = createSignal(props.target ?? { kind: "dashboard" as const, id: ID, title: "Garden", gateway: "east" });
  dispose = render(() => (
    <Router>
      <Route path="*" component={() => (
        <DashboardAnnotationsContext.Provider value={annotations}>
          <FrameView mode="inline" {...props} target={target()} />
        </DashboardAnnotationsContext.Provider>
      )} />
    </Router>
  ), container);
  return { annotations, setTarget };
}

async function answerPrepare(call: Call, n = 1, over: Record<string, unknown> = {}) {
  call.answer(json(201, {
    handle: handleOf(n), instance: `instance-${n}`, shellUrl: `/api/relay/dashboard-views/${handleOf(n)}/shell`,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), gateway: "east", dashboardId: call.body.dashboardId, ...over,
  }));
  await settle();
}
async function answerRead(call: Call, meta: Record<string, unknown> = defaultMeta, over: Record<string, unknown> = {}) {
  call.answer(json(200, { expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), state: "delivered", gateway: "east", dashboardId: ID, meta, ...over }));
  await settle();
}
const shellFrame = () => getByTitle(container, "Garden dashboard") as HTMLIFrameElement;
function fromShell(frame: HTMLIFrameElement, event: string, extra: Record<string, unknown> = {}, over: { instance?: string; channel?: string; source?: Window | null; origin?: string } = {}) {
  window.dispatchEvent(new MessageEvent("message", {
    data: { channel: over.channel ?? "yoplai-shell", instance: over.instance ?? "instance-1", event, ...extra },
    source: over.source === undefined ? frame.contentWindow : over.source,
    origin: over.origin ?? origin,
  }));
}
/** Shell started and renderer ready with a delivered, checked read. */
async function showReady(n = 1, meta: Record<string, unknown> = defaultMeta) {
  await answerPrepare(prepares()[n - 1], n);
  const frame = shellFrame();
  fromShell(frame, "shell-started", {}, { instance: `instance-${n}` });
  fromShell(frame, "renderer-loaded", {}, { instance: `instance-${n}` });
  fromShell(frame, "renderer-ready", {}, { instance: `instance-${n}` });
  await settle();
  await answerRead(reads()[n - 1], meta);
  return frame;
}
const chat = () => queryByRole(container, "link", { name: "Chat" });
const chatButton = () => queryByRole(container, "button", { name: "Chat" }) as HTMLButtonElement | null;

describe("remote dashboard host: preparation", () => {
  it("prepares one view with the gateway, the dashboard, the query, and the theme, and shows only the shell", async () => {
    mount({ target: { kind: "dashboard", id: ID, title: "Garden", gateway: "east", query: "?week=3&__yoplai_x=1" } });
    expect(getByRole(container, "status").textContent).toBe("Loading dashboard…");
    expect(container.querySelector("iframe")).toBeNull();
    expect(prepares()).toHaveLength(1);
    expect(prepares()[0].body).toEqual({ gateway: "east", dashboardId: ID, query: "week=3", theme: "dark" });
    await answerPrepare(prepares()[0]);
    expect(shellFrame().getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`);
    expect(shellFrame().hasAttribute("srcdoc")).toBe(false);
  });

  it("keeps handles and instances out of public links, the clipboard, and the visible text", async () => {
    mount({ target: { kind: "dashboard", id: ID, title: "Garden", gateway: "east", query: "week=3" } });
    await showReady();
    const open = getByRole(container, "link", { name: "Open in browser" });
    expect(open.getAttribute("href")).toBe(`/remote-dashboards/east/${ID}?week=3`);
    getByRole(container, "button", { name: "Copy link" }).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(`${origin}/remote-dashboards/east/${ID}?week=3`);
    expect(getByRole(container, "status").textContent).toBe("Link copied");
    expect(container.textContent).not.toContain(handleOf(1));
    expect(container.textContent).not.toContain("instance-1");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(handleOf(1));
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(handleOf(1));
  });

  it("shows a typed failure with Reload and prepares again", async () => {
    mount();
    prepares()[0].answer(json(403, { error: "forbidden", ownerName: "Ada" }));
    await settle();
    expect(getByRole(container, "alert").textContent).toContain("You have no access to this dashboard. Owner: Ada.");
    expect(container.querySelector("iframe")).toBeNull();
    getByRole(container, "button", { name: "Reload" }).click();
    expect(prepares()).toHaveLength(2);
    expect(queryByRole(container, "alert")).toBeNull();
    await answerPrepare(prepares()[1], 2);
    expect(shellFrame()).toBeTruthy();
  });

  it.each([
    [409, { error: "remote_update_required", reason: "asset_version" }, "too old"],
    [404, { error: "canvas_disabled" }, "off on the linked gateway"],
    [404, { error: "unknown_gateway" }, "No linked gateway"],
    [429, { error: "too_many_dashboard_views" }, "Too many dashboards"],
    [504, { error: "remote_timeout" }, "did not answer in time"],
    [502, { error: "gateway_offline" }, "offline"],
  ])("explains a %i refusal %j in visible text", async (status, body, text) => {
    mount();
    prepares()[0].answer(json(status, body));
    await settle();
    expect(getByRole(container, "alert").textContent).toContain(text);
    expect(getByRole(container, "button", { name: "Reload" })).toBeTruthy();
  });

  it("shows a bounded error when the local gateway cannot be reached or does not answer", async () => {
    mount();
    prepares()[0].fail(new TypeError("fetch failed"));
    await settle();
    expect(getByRole(container, "alert").textContent).toContain("local gateway did not answer");
    vi.useFakeTimers();
    getByRole(container, "button", { name: "Reload" }).click();
    await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS);
    expect(getByRole(container, "alert").textContent).toContain("did not answer in time");
    expect(prepares()[1].signal.aborted).toBe(true);
  });

  it("refuses an invalid dashboard ID without a request", () => {
    mount({ target: { kind: "dashboard", id: "short", title: "Garden", gateway: "east" } });
    expect(prepares()).toHaveLength(0);
    expect(getByRole(container, "alert").textContent).toContain("not valid");
  });
});

describe("remote dashboard host: identity controls", () => {
  const standalone = { standalone: true, mode: "panel" as const };

  it("keeps Chat disabled until readiness and a delivered read prove the view, then links the suffixed agent", async () => {
    mount(standalone);
    expect(chatButton()?.disabled).toBe(true);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    expect(chatButton()?.disabled).toBe(true);
    fromShell(frame, "shell-started");
    fromShell(frame, "renderer-loaded");
    expect(chatButton()?.disabled).toBe(true);
    fromShell(frame, "renderer-ready");
    expect(chatButton()?.disabled).toBe(true);
    expect(reads()).toHaveLength(1);
    expect(reads()[0].body).toEqual({ handle: handleOf(1) });
    await answerRead(reads()[0]);
    expect(chatButton()).toBeNull();
    expect(chat()?.getAttribute("href")).toBe(`/chat/agent-7%40east?session=sess-1&dashboard=${ID}`);
  });

  it("starts a new chat when the dashboard has no session, and offers no Chat without agent access", async () => {
    mount(standalone);
    await showReady(1, { ...defaultMeta, chat: { sessionId: null } });
    expect(chat()?.getAttribute("href")).toBe(`/chat/agent-7%40east?dashboard=${ID}&new=1`);
    dispose!();
    container.innerHTML = "";
    calls = [];
    mount(standalone);
    await showReady(1, { ...defaultMeta, chat: null, annotation: false });
    expect(chat()).toBeNull();
    expect(chatButton()).toBeNull();
  });

  it("ignores messages from another window, origin, channel, or instance", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded", {}, { source: window });
    fromShell(frame, "renderer-loaded", {}, { source: null });
    fromShell(frame, "renderer-loaded", {}, { origin: "null" });
    fromShell(frame, "renderer-loaded", {}, { origin: "http://evil.example" });
    fromShell(frame, "renderer-loaded", {}, { channel: "yoplai-annotate" });
    fromShell(frame, "renderer-loaded", {}, { instance: "instance-9" });
    fromShell(frame, "renderer-ready", {}, { source: window });
    fromShell(frame, "renderer-ready", {}, { instance: "instance-9" });
    window.dispatchEvent(new MessageEvent("message", { data: "renderer-ready", source: frame.contentWindow, origin }));
    window.dispatchEvent(new MessageEvent("message", { data: null, source: frame.contentWindow, origin }));
    await settle();
    expect(reads()).toHaveLength(0);
    expect(queryByRole(container, "alert")).toBeNull();
    // None of them counted: the genuine load and ready events still make the one read.
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    await settle();
    expect(reads()).toHaveLength(1);
    expect(queryByRole(container, "alert")).toBeNull();
  });

  it("ignores a second shell in the page that sends the same instance", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const rival = document.createElement("iframe");
    container.append(rival);
    fromShell(shellFrame(), "renderer-loaded");
    fromShell(rival, "renderer-ready");
    await settle();
    expect(reads()).toHaveLength(0);
    expect(chatButton()?.disabled).toBe(true);
  });

  it("fails closed when readiness comes before the load, or the load comes twice", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    fromShell(shellFrame(), "renderer-ready");
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    expect(container.querySelector("iframe")).toBeNull();
    getByRole(container, "button", { name: "Reload" }).click();
    await answerPrepare(prepares()[1], 2);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded", {}, { instance: "instance-2" });
    fromShell(frame, "renderer-loaded", {}, { instance: "instance-2" });
    expect(getByRole(container, "alert")).toBeTruthy();
    expect(reads()).toHaveLength(0);
  });

  it("keeps controls off when the read says ready, names another dashboard, or fails", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    await answerRead(reads()[0], defaultMeta, { state: "ready" });
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    expect(chat()).toBeNull();
    for (const [index, answer] of [
      [{ meta: { ...defaultMeta, dashboardId: NEXT } }],
      [{ dashboardId: NEXT }],
      [{ gateway: "west" }],
      [{ expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ].entries()) {
      getByRole(container, "button", { name: "Reload" }).click();
      const n = index + 2;
      await answerPrepare(prepares()[n - 1], n);
      const next = shellFrame();
      fromShell(next, "renderer-loaded", {}, { instance: `instance-${n}` });
      fromShell(next, "renderer-ready", {}, { instance: `instance-${n}` });
      await answerRead(reads()[n - 1], defaultMeta, answer[0]);
      expect(getByRole(container, "alert")).toBeTruthy();
      expect(chat()).toBeNull();
    }
    getByRole(container, "button", { name: "Reload" }).click();
    await answerPrepare(prepares()[5], 6);
    const last = shellFrame();
    fromShell(last, "renderer-loaded", {}, { instance: "instance-6" });
    fromShell(last, "renderer-ready", {}, { instance: "instance-6" });
    reads()[5].answer(json(500, { error: "x" }));
    await settle();
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    expect(chat()).toBeNull();
  });

  it("does not let a later message or read clear a failed state", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    fromShell(frame, "ended", { reason: "extra_load" });
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    await answerRead(reads()[0]).catch(() => undefined);
    fromShell(frame, "renderer-ready");
    fromShell(frame, "renderer-loaded");
    expect(getByRole(container, "alert")).toBeTruthy();
    expect(chat()).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows an expired state with Reload when the checked view expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount(standalone);
    prepares()[0].answer(json(201, {
      handle: handleOf(1), instance: "instance-1", shellUrl: `/api/relay/dashboard-views/${handleOf(1)}/shell`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: "east", dashboardId: ID,
    }));
    await vi.advanceTimersByTimeAsync(0);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    reads()[0].answer(json(200, { expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "delivered", gateway: "east", dashboardId: ID, meta: defaultMeta }));
    await vi.advanceTimersByTimeAsync(0);
    expect(chat()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(chat()).toBeNull();
    expect(getByRole(container, "alert").textContent).toContain("expired");
    expect(container.querySelector("iframe")).toBeNull();
    getByRole(container, "button", { name: "Reload" }).click();
    expect(prepares()).toHaveLength(2);
  });

  it("reports an expired read answer of the gateway", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    reads()[0].answer(json(410, { state: "expired", error: "dashboard_view_expired", status: 410 }));
    await settle();
    expect(getByRole(container, "alert").textContent).toContain("expired");
  });

  it("ends with an error and Reload when the renderer never becomes ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount(standalone);
    prepares()[0].answer(json(201, {
      handle: handleOf(1), instance: "instance-1", shellUrl: `/api/relay/dashboard-views/${handleOf(1)}/shell`,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), gateway: "east", dashboardId: ID,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(shellFrame()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1);
    expect(getByRole(container, "alert").textContent).toContain("did not finish loading");
    expect(container.querySelector("iframe")).toBeNull();
    expect(chatButton()?.disabled).toBe(true);
  });

  it("ends the view and disables controls when the shell reports an extra load", async () => {
    mount(standalone);
    const frame = await showReady();
    expect(chat()).toBeTruthy();
    const end = vi.spyOn(frame.contentWindow!, "postMessage");
    fromShell(frame, "ended", { reason: "extra_load" });
    expect(chat()).toBeNull();
    expect(chatButton()?.disabled).toBe(true);
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    expect(end).toHaveBeenCalledWith({ channel: "yoplai-shell", instance: "instance-1", event: "end" }, origin);
  });
});

describe("remote dashboard host: loads of the shell", () => {
  const standalone = { standalone: true, mode: "panel" as const };
  const load = (frame: HTMLIFrameElement) => frame.dispatchEvent(new Event("load"));

  it("accepts the first shell load before or after readiness", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    let frame = shellFrame();
    load(frame);
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    await settle();
    await answerRead(reads()[0]);
    expect(chat()).toBeTruthy();
    expect(queryByRole(container, "alert")).toBeNull();
    dispose!();
    container.innerHTML = "";
    calls = [];
    mount(standalone);
    frame = await showReady();
    load(frame);
    expect(chat()).toBeTruthy();
    expect(queryByRole(container, "alert")).toBeNull();
  });

  it("clears authority, notes, and the iframe on an extra shell load after readiness, with no message from the shell", async () => {
    const { annotations } = mount(standalone);
    const frame = await showReady();
    fromShell(frame, "annotation", { message: { channel: "yoplai-annotate", type: "ready", id: "x", slug: "home.html", agentId: "agent-7@east", title: "Home", params: {} } });
    queryByRole(container, "button", { name: "Annotate" })!.click();
    fromShell(frame, "annotation", { message: { channel: "yoplai-annotate", type: "note", id: "n1", selector: "p", tag: "p", text: "", heading: "", ancestor: "", note: "Bolder" } });
    expect(annotations.notes()).toHaveLength(1);
    load(frame);
    load(frame);
    expect(chat()).toBeNull();
    expect(chatButton()?.disabled).toBe(true);
    expect(annotations.notes()).toHaveLength(0);
    expect(queryByRole(container, "button", { name: "Annotate" })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(getByRole(container, "alert").textContent).toContain("unknown state");
    // Late events of the old instance change nothing.
    fromShell(frame, "renderer-ready");
    fromShell(frame, "link-request", { href: "https://example.com/" });
    await settle();
    expect(chat()).toBeNull();
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
    expect(getByRole(container, "alert")).toBeTruthy();
  });

  it("ignores the late metadata answer of an instance that an extra load ended, and Reload succeeds", async () => {
    ignoreAbort = true;
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    load(frame);
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    const read = reads()[0];
    load(frame);
    expect(read.signal.aborted).toBe(true);
    await answerRead(read);
    expect(chat()).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    getByRole(container, "button", { name: "Reload" }).click();
    expect(prepares()).toHaveLength(2);
    await answerPrepare(prepares()[1], 2);
    const fresh = shellFrame();
    expect(fresh).not.toBe(frame);
    load(fresh);
    fromShell(fresh, "renderer-loaded", {}, { instance: "instance-2" });
    fromShell(fresh, "renderer-ready", {}, { instance: "instance-2" });
    await settle();
    await answerRead(reads()[1]);
    expect(chat()).toBeTruthy();
    expect(queryByRole(container, "alert")).toBeNull();
  });

  it("fails closed on an extra shell load before readiness", async () => {
    mount(standalone);
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    load(frame);
    load(frame);
    expect(getByRole(container, "alert")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    await settle();
    expect(reads()).toHaveLength(0);
    expect(chat()).toBeNull();
  });
});

describe("remote dashboard host: replacement and late results", () => {
  it("aborts a pending preparation on disposal and ignores its late answer", async () => {
    mount({ standalone: true, mode: "panel" });
    const pending = prepares()[0];
    dispose!();
    dispose = undefined;
    expect(pending.signal.aborted).toBe(true);
    pending.answer(json(201, { handle: handleOf(1), instance: "instance-1", shellUrl: `/api/relay/dashboard-views/${handleOf(1)}/shell`, expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: "east", dashboardId: ID }));
    await settle();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("ignores a late prepare answer and a late metadata answer from a transport that ignores the abort", async () => {
    ignoreAbort = true;
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    const stale = prepares()[0];
    setTarget({ kind: "dashboard", id: NEXT, title: "Garden", gateway: "east" });
    await answerPrepare(stale, 1);
    expect(container.querySelector("iframe")).toBeNull();
    await answerPrepare(prepares()[1], 2, { dashboardId: NEXT });
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded", {}, { instance: "instance-2" });
    fromShell(frame, "renderer-ready", {}, { instance: "instance-2" });
    const read = reads()[0];
    setTarget({ kind: "dashboard", id: ID, title: "Garden", gateway: "east" });
    await answerRead(read, { ...defaultMeta, dashboardId: NEXT }, { dashboardId: NEXT });
    expect(chat()).toBeNull();
    expect(chatButton()?.disabled).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("ignores a late failure of an older preparation", async () => {
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    const stale = prepares()[0];
    setTarget({ kind: "dashboard", id: NEXT, title: "Garden", gateway: "east" });
    stale.fail(new TypeError("fetch failed"));
    await settle();
    expect(queryByRole(container, "alert")).toBeNull();
    await answerPrepare(prepares()[1], 2);
    expect(shellFrame().getAttribute("src")).toContain(handleOf(2));
  });

  it("replaces a pending preparation when the dashboard changes and ignores its late answer", async () => {
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    const stale = prepares()[0];
    setTarget({ kind: "dashboard", id: NEXT, title: "Garden", gateway: "east" });
    expect(stale.signal.aborted).toBe(true);
    expect(prepares()).toHaveLength(2);
    stale.answer(json(201, { handle: handleOf(1), instance: "instance-1", shellUrl: `/api/relay/dashboard-views/${handleOf(1)}/shell`, expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: "east", dashboardId: ID }));
    await settle();
    expect(container.querySelector("iframe")).toBeNull();
    await answerPrepare(prepares()[1], 2);
    expect(shellFrame().getAttribute("src")).toContain(handleOf(2));
  });

  it("ignores a late metadata answer of a replaced view and aborts its read", async () => {
    mount({ standalone: true, mode: "panel" });
    await answerPrepare(prepares()[0]);
    const old = shellFrame();
    fromShell(old, "renderer-loaded");
    fromShell(old, "renderer-ready");
    const read = reads()[0];
    getByRole(container, "button", { name: "Copy link" });
    setThemeChoice("light");
    await settle();
    expect(read.signal.aborted).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
    await answerRead(read).catch(() => undefined);
    expect(chat()).toBeNull();
    expect(chatButton()?.disabled).toBe(true);
    expect(prepares()).toHaveLength(2);
    expect(prepares()[1].body.theme).toBe("light");
  });

  it("does not trust messages of a replaced shell", async () => {
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    await answerPrepare(prepares()[0]);
    const old = shellFrame();
    setTarget({ kind: "dashboard", id: ID, title: "Garden", gateway: "east", query: "week=4" });
    await answerPrepare(prepares()[1], 2);
    const fresh = shellFrame();
    expect(fresh).not.toBe(old);
    fromShell(old, "renderer-loaded", {}, { instance: "instance-1" });
    fromShell(old, "renderer-ready", {}, { instance: "instance-1" });
    fromShell(fresh, "renderer-ready", {}, { instance: "instance-1" });
    await settle();
    expect(reads()).toHaveLength(0);
  });

  it("prepares a fresh view for a query change and a theme change, each with a new iframe", async () => {
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    const first = await showReady();
    setTarget({ kind: "dashboard", id: ID, title: "Garden", gateway: "east", query: "week=2" });
    expect(chat()).toBeNull();
    expect(prepares()[1].body.query).toBe("week=2");
    await answerPrepare(prepares()[1], 2);
    expect(shellFrame()).not.toBe(first);
    setThemeChoice("light");
    await settle();
    expect(prepares()[2].body).toMatchObject({ query: "week=2", theme: "light" });
  });

  it("clears authority on pagehide and prepares a fresh view for a cached restoration", async () => {
    mount({ standalone: true, mode: "panel" });
    await showReady();
    expect(chat()).toBeTruthy();
    window.dispatchEvent(new Event("pagehide"));
    expect(chat()).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(prepares()).toHaveLength(1);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(prepares()).toHaveLength(2);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("releases the snapshot of a view that a new preparation, pagehide, or disposal replaces", async () => {
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    await showReady();
    expect(releases()).toHaveLength(0);
    setTarget({ kind: "dashboard", id: ID, title: "Garden", gateway: "east", query: "week=2" });
    expect(releases().map((call) => call.body)).toEqual([{ handle: handleOf(1) }]);
    await answerPrepare(prepares()[1], 2);
    window.dispatchEvent(new Event("pagehide"));
    expect(releases().map((call) => call.body)).toEqual([{ handle: handleOf(1) }, { handle: handleOf(2) }]);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await answerPrepare(prepares()[2], 3);
    dispose!();
    dispose = undefined;
    expect(releases().map((call) => call.body)).toEqual([{ handle: handleOf(1) }, { handle: handleOf(2) }, { handle: handleOf(3) }]);
  });

  it("releases the snapshot that a late preparation of a replaced view made", async () => {
    ignoreAbort = true;
    const { setTarget } = mount({ standalone: true, mode: "panel" });
    const stale = prepares()[0];
    setTarget({ kind: "dashboard", id: NEXT, title: "Garden", gateway: "east" });
    await answerPrepare(stale, 1);
    expect(releases().map((call) => call.body)).toEqual([{ handle: handleOf(1) }]);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("closes the frame and drops its listener on disposal", async () => {
    mount();
    const frame = await showReady();
    const end = vi.spyOn(frame.contentWindow!, "postMessage");
    dispose!();
    dispose = undefined;
    expect(end).toHaveBeenCalledWith({ channel: "yoplai-shell", instance: "instance-1", event: "end" }, origin);
    fromShell(frame, "link-request", { href: "https://example.com/" });
    expect(queryByText(container, /example\.com/)).toBeNull();
  });
});

describe("remote dashboard host: links", () => {
  it("prepares a new view for a dashboard link of the same gateway", async () => {
    mount();
    const frame = await showReady();
    fromShell(frame, "link-request", { href: `${origin}/api/relay/dashboard-views/${NEXT}/?week=5&__yoplai_x=1` });
    expect(prepares()).toHaveLength(2);
    expect(prepares()[1].body).toMatchObject({ gateway: "east", dashboardId: NEXT, query: "week=5" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/remote-dashboards/east/${NEXT}?week=5`);
  });

  it("hands a same-gateway link to the owner of the route when one is given", async () => {
    const onNavigate = vi.fn();
    mount({ onNavigate });
    const frame = await showReady();
    fromShell(frame, "link-request", { href: `../${NEXT}/?tab=a` });
    expect(onNavigate).toHaveBeenCalledWith({ id: NEXT, query: "tab=a" });
    expect(prepares()).toHaveLength(1);
  });

  it("opens an external address only after a click on a visible destination, without opener or referrer", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    const frame = await showReady();
    fromShell(frame, "link-request", { href: "https://example.com/report?q=1" });
    expect(open).not.toHaveBeenCalled();
    const group = getByRole(container, "group", { name: "External link" });
    expect(group.textContent).toContain("https://example.com/report");
    expect(group.textContent).not.toContain("q=1");
    getByRole(container, "button", { name: "Open link" }).click();
    expect(open).toHaveBeenCalledWith("https://example.com/report?q=1", "_blank", "noopener,noreferrer");
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
  });

  it("lets the user dismiss an external link, and drops it with the view", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount({ standalone: true, mode: "panel" });
    const frame = await showReady();
    fromShell(frame, "link-request", { href: "https://example.com/a" });
    getByRole(container, "button", { name: "Dismiss" }).click();
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
    fromShell(frame, "link-request", { href: "https://example.com/b" });
    fromShell(frame, "ended", { reason: "host" });
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects executable, credential, and local targets", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    const frame = await showReady();
    for (const href of ["javascript:alert(1)", "data:text/html,x", "blob:http://localhost:3000/x", "ftp://example.com/"]) {
      fromShell(frame, "link-request", { href });
      expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
    }
    expect(prepares()).toHaveLength(1);
    fromShell(frame, "link-request", { href: "https://user:pw@example.com/" });
    expect(getByRole(container, "status").textContent).toContain("user name or password");
    fromShell(frame, "link-request", { href: "http://localhost:4000/" });
    expect(getByRole(container, "status").textContent).toContain("this machine or network");
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores link requests before the view is proven", async () => {
    mount();
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "link-request", { href: `${origin}/api/relay/dashboard-views/${NEXT}/` });
    fromShell(frame, "link-request", { href: "https://example.com/" });
    expect(prepares()).toHaveLength(1);
    expect(queryByRole(container, "group", { name: "External link" })).toBeNull();
  });
});

describe("remote dashboard host: annotation", () => {
  const note = (id: string, body: Record<string, unknown> = {}) => ({
    channel: "yoplai-annotate", type: "note", id, selector: "p.intro", tag: "p", text: "Hello", heading: "Intro", ancestor: "main", note: "Make this bolder", ...body,
  });
  const claim = { channel: "yoplai-annotate", type: "ready", id: "claimed-id", slug: "home.html", agentId: "evil@east", title: "Home", params: {} };
  const annotate = () => queryByRole(container, "button", { name: "Annotate" }) as HTMLButtonElement | null;

  it("offers Annotate only for checked annotation rights and the chat's own agent, from the held page announcement", async () => {
    mount();
    await answerPrepare(prepares()[0]);
    const frame = shellFrame();
    fromShell(frame, "renderer-loaded");
    fromShell(frame, "renderer-ready");
    fromShell(frame, "annotation", { message: claim });
    expect(annotate()).toBeNull();
    await answerRead(reads()[0]);
    expect(annotate()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("never offers Annotate without the right, for another chat agent, or without the page announcement", async () => {
    mount({ chatAgent: "other@east" });
    let frame = await showReady();
    fromShell(frame, "annotation", { message: claim });
    expect(annotate()).toBeNull();
    dispose!();
    container.innerHTML = "";
    calls = [];
    mount();
    frame = await showReady(1, { ...defaultMeta, annotation: false });
    fromShell(frame, "annotation", { message: claim });
    expect(annotate()).toBeNull();
    dispose!();
    container.innerHTML = "";
    calls = [];
    mount();
    await showReady();
    expect(annotate()).toBeNull();
  });

  it("sends mode changes to the shell, and stages notes for the checked page and agent, never the claimed ones", async () => {
    const { annotations } = mount();
    const frame = await showReady();
    fromShell(frame, "annotation", { message: claim });
    const sent = vi.spyOn(frame.contentWindow!, "postMessage");
    annotate()!.click();
    expect(sent).toHaveBeenCalledWith({ channel: "yoplai-shell", instance: "instance-1", event: "annotation", message: { channel: "yoplai-annotate", type: "set", on: true } }, origin);
    fromShell(frame, "annotation", { message: note("n1", { agentId: "evil@east", id2: 1 }) });
    fromShell(frame, "annotation", { message: note("n1") });
    fromShell(frame, "annotation", { message: { channel: "other", type: "note" } });
    fromShell(frame, "annotation", { message: "text" });
    expect(annotations.notes()).toHaveLength(1);
    expect(annotations.notes()[0].page).toMatchObject({ id: ID, agentId: "agent-7@east", slug: "home.html", title: "Home" });
    const message = annotations.compose("Fix it").text;
    expect(message).toContain(`id: ${ID}`);
    expect(message).toContain("Make this bolder");
    expect(message).not.toContain("claimed-id");
    expect(message).not.toContain("evil");
    annotate()!.click();
    expect(sent).toHaveBeenLastCalledWith({ channel: "yoplai-shell", instance: "instance-1", event: "annotation", message: { channel: "yoplai-annotate", type: "set", on: false } }, origin);
  });

  it("ignores notes while the mode is off, and clears staged notes when the instance ends", async () => {
    const { annotations } = mount();
    const frame = await showReady();
    fromShell(frame, "annotation", { message: claim });
    fromShell(frame, "annotation", { message: note("early") });
    expect(annotations.notes()).toHaveLength(0);
    annotate()!.click();
    fromShell(frame, "annotation", { message: note("n1") });
    expect(annotations.notes()).toHaveLength(1);
    fromShell(frame, "ended", { reason: "extra_load" });
    expect(annotations.notes()).toHaveLength(0);
    expect(annotate()).toBeNull();
  });

  it("clears staged notes when a new view replaces the instance", async () => {
    const { annotations, setTarget } = mount();
    const frame = await showReady();
    fromShell(frame, "annotation", { message: claim });
    annotate()!.click();
    fromShell(frame, "annotation", { message: note("n1") });
    expect(annotations.notes()).toHaveLength(1);
    setTarget({ kind: "dashboard", id: NEXT, title: "Garden", gateway: "east" });
    expect(annotations.notes()).toHaveLength(0);
    expect(annotate()).toBeNull();
  });

  it("stages at most the limit and drops the marker of a refused note", async () => {
    const { annotations } = mount();
    const frame = await showReady();
    fromShell(frame, "annotation", { message: claim });
    annotate()!.click();
    for (let index = 1; index <= 21; index++) fromShell(frame, "annotation", { message: note(`n${index}`) });
    expect(annotations.notes()).toHaveLength(20);
  });

  it("sends nothing to a view that is not proven", async () => {
    const { annotations } = mount();
    await answerPrepare(prepares()[0]);
    const sent = vi.spyOn(shellFrame().contentWindow!, "postMessage");
    annotations.reset();
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("remote dashboard frame controls", () => {
  it("keeps the panel controls and the public Open link for a remote dashboard in a panel", async () => {
    const onCollapse = vi.fn();
    mount({ mode: "panel", onCollapse });
    await showReady();
    getByRole(container, "button", { name: "Collapse" }).click();
    expect(onCollapse).toHaveBeenCalled();
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("target")).toBe("_blank");
    expect(getByRole(container, "link", { name: "Open in browser" }).getAttribute("rel")).toBe("noopener noreferrer");
    expect(chat()).toBeNull();
    expect(chatButton()).toBeNull();
  });

  it("shows the Copy failure in visible text", async () => {
    mount();
    await showReady();
    writeText.mockRejectedValue(new Error("denied"));
    getByRole(container, "button", { name: "Copy link" }).click();
    await settle();
    expect(getByRole(container, "status").textContent).toBe("Could not copy the link");
  });
});
