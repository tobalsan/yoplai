// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Router, Route } from "@solidjs/router";

window.matchMedia = vi.fn().mockReturnValue({ matches: false });
const { AgentSidebar } = await import("./AgentSidebar");
const { TurnNotifier } = await import("./TurnNotifier");
const { setCapabilitiesForTests, resetCapabilitiesForTests } =
  await import("../lib/capabilities");

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Socket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

let sessions: Record<string, unknown>[];
let testId = 0;
let sessionId: string;
let dispose: (() => void) | undefined;
const play = vi.fn(() => Promise.resolve());
let audioSources: string[];
const completion = (id = "answer-1", endedAt = 200) => ({
  type: "status",
  agentId: "assistant",
  sessionId,
  status: "idle",
  sessionStatus: "idle",
  completion: { id, endedAt },
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <Router>
        <Route
          path="*"
          component={() => (
            <>
              <AgentSidebar
                collapsed={() => false}
                onToggleCollapse={() => {}}
              />
              <TurnNotifier enabled={true} />
            </>
          )}
        />
      </Router>
    ),
    host
  );
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionId = `test-session-${++testId}`;
  Socket.instances = [];
  audioSources = [];
  localStorage.clear();
  localStorage.setItem("yoplai:chat-read-init:local", "1");
  setCapabilitiesForTests({ multiUser: false });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  sessions = [
    {
      agentId: "assistant",
      agentName: "Assistant",
      sessionId,
      sessionKey: "main",
      lastActivity: 100,
      title: "A long answer",
      firstUserMessage: "Hello",
      isMain: true,
    },
  ];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "Audio",
    class {
      volume = 0;
      constructor(public src: string) { audioSources.push(src); }
      play = play;
    }
  );
  play.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string) =>
        new Response(
          JSON.stringify(
            input.includes("/agents/sessions")
              ? { items: sessions }
              : { items: [] }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    )
  );
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  resetCapabilitiesForTests();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each(["/", "/yoplai", "/yoplai/"])("loads the chime beneath UI base %s", async (base) => {
  vi.stubEnv("BASE_URL", base);
  mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion(`base-${base}`, 150));
  await vi.advanceTimersByTimeAsync(200);
  expect(audioSources).toEqual([base === "/" ? "/notify.mp3" : "/yoplai/notify.mp3"]);
});

it("chimes and shows an unread dot for a live answer elsewhere", async () => {
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion());
  await vi.advanceTimersByTimeAsync(200);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
});

it("retains every unknown-session completion through one ownership refetch", async () => {
  sessions = [];
  const host = mount();
  await flush();
  const ws = Socket.instances.at(-1)!;
  ws.emit(completion("unknown-1", 300));
  ws.emit({ ...completion("unknown-2", 301), sessionId: "session-2" });
  ws.emit({ ...completion("foreign", 302), sessionId: "foreign" });
  sessions = [sessionId, "session-2"].map((sessionId) => ({
    agentId: "assistant",
    sessionId,
    createdAt: 1,
    lastActivity: 1,
    firstUserMessage: sessionId,
    messageCount: 1,
    pinned: null,
    archived: null,
    isMain: false,
  }));
  await vi.advanceTimersByTimeAsync(500);
  expect(host.querySelectorAll('[aria-label="Unread messages"]')).toHaveLength(
    2
  );
  expect(play).toHaveBeenCalledTimes(2);
});

it("baselines old history but keeps a live answer received during the baseline unread", async () => {
  localStorage.removeItem("yoplai:chat-read-init:local");
  let respond!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input).includes("/agents/sessions")
      ? response.then((value) => value.clone())
      : new Response('{"items":[]}')
  );
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion("baseline-live", 400));
  sessions[0].lastWebCompletion = { id: "baseline-live", endedAt: 400 };
  sessions.push({
    ...sessions[0],
    sessionId: "old-session",
    title: "Old answer",
    lastWebCompletion: { id: "old-answer", endedAt: 50 },
  });
  respond(new Response(JSON.stringify({ items: sessions })));
  await vi.advanceTimersByTimeAsync(500);
  expect(host.querySelectorAll('[aria-label="Unread messages"]')).toHaveLength(
    1
  );
  expect(
    localStorage.getItem("yoplai:chat-read:local:assistant:old-session")
  ).toBe("old-answer");
  expect(play).toHaveBeenCalledTimes(1);
});

it("does not undo another tab's newer read with a delayed completion or stale list", async () => {
  sessions[0].lastWebCompletion = { id: "stale-answer", endedAt: 500 };
  localStorage.setItem(
    `yoplai:chat-read:local:assistant:${sessionId}`,
    "stale-answer"
  );
  const host = mount();
  await flush();
  let respond!: (value: Response) => void;
  const stale = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const staleItems = JSON.stringify({ items: sessions });
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementationOnce(() => stale);
  window.dispatchEvent(new Event("chat-projects-changed"));
  const key = `yoplai:chat-read:local:assistant:${sessionId}`;
  localStorage.setItem(key, "read-in-other-tab");
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: "read-in-other-tab" })
  );
  expect(host.querySelector('[aria-label="Unread messages"]')).toBeNull();
  sessions[0].lastWebCompletion = { id: "read-in-other-tab", endedAt: 600 };
  vi.mocked(fetch).mockImplementation(originalFetch);
  Socket.instances.at(-1)!.emit(completion("stale-answer", 500));
  expect(host.querySelector('[aria-label="Unread messages"]')).toBeNull();
  respond(new Response(staleItems));
  await vi.advanceTimersByTimeAsync(200);
  expect(host.querySelector('[aria-label="Unread messages"]')).toBeNull();
  expect(localStorage.getItem(key)).toBe("read-in-other-tab");
});

it("deduplicates live deliveries across tabs, expires claims, and never waits for playback", async () => {
  localStorage.setItem(
    "yoplai:notify-claim:expired",
    JSON.stringify({ at: Date.now() - 600_000, owner: "closed-tab" })
  );
  const host = mount();
  const other = document.createElement("div");
  document.body.append(other);
  const stopOther = render(() => <TurnNotifier enabled={true} />, other);
  play.mockImplementation(() => new Promise<void>(() => {}));
  await flush();
  for (const socket of Socket.instances)
    socket.emit(completion("sound-one", 700));
  for (const socket of Socket.instances)
    socket.emit(completion("sound-two", 701));
  await vi.advanceTimersByTimeAsync(200);
  expect(play).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  for (const socket of Socket.instances)
    socket.emit(completion("sound-one", 700));
  await vi.advanceTimersByTimeAsync(200);
  expect(play).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem("yoplai:notify-claim:expired")).toBeNull();
  stopOther();
});

it("refetches after an unknown completion outlives an in-flight list that does not own it yet", async () => {
  let respond!: (value: Response) => void;
  const initial = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  let lists = 0;
  const next = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("/agents/sessions") && ++lists <= 2)
      return initial.then((response) => response.clone());
    return next(input, init);
  });
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion("arrived-during-fetch", 800));
  await vi.advanceTimersByTimeAsync(150);
  respond(new Response('{"items":[]}'));
  await vi.advanceTimersByTimeAsync(400);
  expect(play).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
});

it("shows a new completion with a different id even when its server millisecond matches the read answer", async () => {
  sessions[0].lastWebCompletion = { id: "same-millisecond-old", endedAt: 900 };
  localStorage.setItem(
    `yoplai:chat-read:local:assistant:${sessionId}`,
    "same-millisecond-old"
  );
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion("same-millisecond-new", 900));
  await vi.advanceTimersByTimeAsync(200);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
});

it("keeps a read answer ahead of an unseen stale marker from the same millisecond", async () => {
  const host = mount();
  await flush();
  let respond!: (value: Response) => void;
  const stale = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const oldItems = JSON.stringify({
    items: [
      { ...sessions[0], lastWebCompletion: { id: "tie-stale", endedAt: 950 } },
    ],
  });
  vi.mocked(fetch).mockImplementationOnce(() => stale);
  window.dispatchEvent(new Event("chat-projects-changed"));
  sessions[0].lastWebCompletion = { id: "tie-read", endedAt: 950 };
  Socket.instances.at(-1)!.emit(completion("tie-read", 950));
  await flush();
  const key = `yoplai:chat-read:local:assistant:${sessionId}`;
  localStorage.setItem(key, "tie-read");
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: "tie-read" })
  );
  respond(new Response(oldItems));
  await vi.advanceTimersByTimeAsync(200);
  expect(host.querySelector('[aria-label="Unread messages"]')).toBeNull();
  expect(localStorage.getItem(key)).toBe("tie-read");
});

it.each(["idle", "muted", "hidden", "catch-up", "first-run"])(
  "handles %s without confusing read state with sound",
  async (scenario) => {
    const marker = { id: `case-${scenario}`, endedAt: 1000 };
    if (scenario === "muted")
      localStorage.setItem("yoplai:notify-sound", "off");
    if (scenario === "hidden")
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    if (scenario === "catch-up" || scenario === "first-run")
      sessions[0].lastWebCompletion = marker;
    if (scenario === "first-run")
      localStorage.removeItem("yoplai:chat-read-init:local");
    const host = mount();
    await flush();
    const socket = Socket.instances.at(-1)!;
    if (scenario === "idle")
      socket.emit({ ...completion(), completion: undefined });
    if (scenario === "muted" || scenario === "hidden")
      socket.emit(completion(marker.id, marker.endedAt));
    if (scenario === "hidden") {
      // Sidebar polling is paused; the root notifier still receives and chimes.
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(play).toHaveBeenCalledTimes(scenario === "hidden" ? 1 : 0);
    expect(Boolean(host.querySelector('[aria-label="Unread messages"]'))).toBe(
      ["muted", "hidden", "catch-up"].includes(scenario)
    );
  }
);

it.each(["failed", "empty"])(
  "initializes first-run history only after a successful %s list response",
  async (scenario) => {
    localStorage.removeItem("yoplai:chat-read-init:local");
    sessions = [];
    if (scenario === "failed")
      vi.mocked(fetch).mockResolvedValue(
        new Response("Unavailable", { status: 503 })
      );
    mount();
    await flush();
    expect(localStorage.getItem("yoplai:chat-read-init:local")).toBe(
      scenario === "empty" ? "1" : null
    );
    expect(play).not.toHaveBeenCalled();
  }
);

it("reconnects during a run, catches up silently, and hears the next live completion", async () => {
  const host = mount();
  await flush();
  const first = Socket.instances.at(-1)!;
  first.onopen?.();
  first.emit({
    ...completion(),
    status: "streaming",
    sessionStatus: "streaming",
    completion: undefined,
  });
  first.close();
  sessions[0].lastWebCompletion = {
    id: "finished-while-reconnecting",
    endedAt: 1150,
  };
  await vi.advanceTimersByTimeAsync(1000);
  const second = Socket.instances.at(-1)!;
  second.onopen?.();
  await flush();
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  expect(play).not.toHaveBeenCalled();
  second.emit(completion("live-after-reconnect", 1151));
  await vi.advanceTimersByTimeAsync(200);
  expect(play).toHaveBeenCalledTimes(1);
});

it("a timed-out list request releases its pending ownership refresh", async () => {
  const next = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (!init?.signal) return next(input, init);
    vi.mocked(fetch).mockImplementation(next);
    return new Promise<Response>((_resolve, reject) =>
      init.signal!.addEventListener("abort", () =>
        reject(new DOMException("Timed out", "AbortError"))
      )
    );
  });
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion("waiting-for-ownership", 1170));
  await vi.advanceTimersByTimeAsync(10_500);
  expect(play).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
});

it("a rejected autoplay attempt never blocks a later answer", async () => {
  const host = mount();
  await flush();
  play.mockRejectedValueOnce(new Error("Autoplay denied"));
  Socket.instances.at(-1)!.emit(completion("autoplay-denied", 1180));
  await vi.advanceTimersByTimeAsync(200);
  Socket.instances.at(-1)!.emit(completion("after-autoplay-denied", 1181));
  await vi.advanceTimersByTimeAsync(200);
  expect(play).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
});

it("keeps live dots and sound working when browser storage writes fail", async () => {
  localStorage.removeItem("yoplai:chat-read-init:local");
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  const host = mount();
  await flush();
  Socket.instances.at(-1)!.emit(completion("storage-unavailable", 1200));
  await vi.advanceTimersByTimeAsync(200);
  expect(host.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
});

it.each(["logout", "user-switch", "401", "disabled"])(
  "stops subscriptions and ignores late work after %s",
  async (scenario) => {
    setCapabilitiesForTests({ multiUser: true, user: { id: "alice" } });
    const [enabled, setEnabled] = createSignal(true);
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <TurnNotifier enabled={enabled()} />, host);
    await flush();
    const oldSocket = Socket.instances.at(-1)!;
    if (scenario === "logout") setCapabilitiesForTests({ multiUser: true });
    if (scenario === "user-switch") {
      sessions = [];
      setCapabilitiesForTests({ multiUser: true, user: { id: "bob" } });
    }
    if (scenario === "disabled") setEnabled(false);
    if (scenario === "401") {
      vi.mocked(fetch).mockResolvedValue(
        new Response("Unauthorized", { status: 401 })
      );
      oldSocket.emit({
        ...completion("trigger-refetch", 1100),
        sessionId: "not-owned",
      });
      await vi.advanceTimersByTimeAsync(150);
    }
    oldSocket.emit(completion(`late-${scenario}`, 1101));
    await vi.advanceTimersByTimeAsync(2000);
    expect(oldSocket.readyState).toBe(3);
    expect(play).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(`yoplai:notify-claim:late-${scenario}`)
    ).toBeNull();
  }
);
