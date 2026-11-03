// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
const m = vi.hoisted(() => ({ fetchModelQuota: vi.fn() }));
vi.mock("../../api/model-quota", () => m);
vi.mock("@solidjs/router", () => ({ A: (props: Record<string, unknown>) => <a {...props} />, useLocation: () => ({ pathname: "/admin/quota" }) }));
const { default: AdminLayout } = await import("./AdminLayout");
const { default: Quota } = await import("./Quota");
const { setCapabilitiesForTests, resetCapabilitiesForTests } = await import("../../lib/capabilities");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("Quota", () => {
  let dispose: () => void;
  const mount = (caps: Record<string, unknown> = { multiUser: false }) => {
    setCapabilitiesForTests(caps as never);
    const container = document.createElement("div"); document.body.append(container);
    dispose = render(() => <Quota />, container); return container;
  };
  afterEach(() => { dispose?.(); document.body.innerHTML = ""; vi.resetAllMocks(); vi.useRealTimers(); resetCapabilitiesForTests(); });
  it("loads and displays a local reading for the operator", async () => {
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [{ provider: "openai-codex", accountRef: "ab12", plan: "Plus", source: "wham-usage", updatedAt: 1799999940, stale: false, error: null, fiveHour: { usedPercent: 42, resetAt: 1800003600 }, weekly: { usedPercent: 25, resetAt: 1800086400 }, weeklyPace: 0.5, fiveHourState: "ok" }] });
    const container = mount(); await flush();
    for (const text of ["ChatGPT", "ab12", "Plus", "42%", "25%", "0.50×", "resets in 1h", "1m ago", "ChatGPT usage endpoint", "Fresh"]) expect(container.textContent).toContain(text);
    expect(container.querySelector("time[title]")).not.toBeNull();
  });
  it("distinguishes absent, exhausted and unknown windows while retaining stale readings", async () => {
    const base = { provider: "anthropic", accountRef: "host", source: "headers", updatedAt: 1799999900, stale: false, error: null, weekly: { usedPercent: 70, resetAt: 1800086400 }, weeklyPace: null };
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [
      { ...base, accountRef: "pro", plan: "Pro", fiveHour: null, fiveHourState: "absent" },
      { ...base, accountRef: "blocked", fiveHour: { usedPercent: 100, resetAt: 1800003600 }, fiveHourState: "exhausted" },
      { ...base, accountRef: "old", stale: true, error: "timeout", fiveHour: { usedPercent: 42, resetAt: 1800003600 }, fiveHourState: "unknown" },
      { ...base, accountRef: "failed", updatedAt: null, source: null, error: "invalid_payload", fiveHour: null, weekly: null, fiveHourState: "unknown" },
    ] });
    const container = mount({ multiUser: true, user: { role: "superadmin" } }); await flush();
    const rows = container.querySelectorAll("article");
    expect(rows[0].textContent).toContain("none"); expect(rows[0].querySelectorAll("dd")[1].textContent).toBe("none");
    expect(rows[1].textContent).toContain("Exhausted");
    for (const text of ["Stale", "Error: timeout", "Last known:", "42%", "—", "Claude response headers"]) expect(rows[2].textContent).toContain(text);
    expect(rows[2].querySelector(".quota-numbers--stale")).not.toBeNull();
    expect(rows[3].textContent).toContain("Error: invalid_payload"); expect(rows[3].textContent).not.toContain("Fresh");
  });
  it("explains initial loading and an empty store with polling disabled or enabled", async () => {
    let resolve!: (value: unknown) => void;
    m.fetchModelQuota.mockReturnValue(new Promise((done) => { resolve = done; }));
    const container = mount(); expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading quota…");
    resolve({ generatedAt: 1800000000, pollingEnabled: false, logins: [] }); await flush();
    expect(container.textContent).toContain("No quota readings yet."); expect(container.textContent).toContain("modelQuota");
    dispose(); container.remove(); m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [] });
    const enabled = mount(); await flush(); expect(enabled.textContent).toContain("No quota readings yet."); expect(enabled.textContent).not.toContain("modelQuota");
  });
  it("polls every 20 seconds, skips pending work, retains data on failure and stops after unmount", async () => {
    vi.useFakeTimers();
    m.fetchModelQuota.mockResolvedValueOnce({ generatedAt: 1800000000, pollingEnabled: true, logins: [{ provider: "anthropic", accountRef: "retained", source: "usage-endpoint", updatedAt: 1800000000, stale: false, error: null, fiveHour: null, weekly: null, weeklyPace: null, fiveHourState: "unknown" }] });
    const container = mount(); await flush();
    let reject!: (cause: Error) => void;
    m.fetchModelQuota.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(19999); expect(m.fetchModelQuota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(m.fetchModelQuota).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000); expect(m.fetchModelQuota).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("retained");
    reject(new Error("Network timeout")); await flush();
    expect(container.textContent).toContain("retained"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to refresh quota.");
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [] });
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    retry.click(); await flush(); expect(m.fetchModelQuota).toHaveBeenCalledTimes(3); expect(container.querySelector('[role="alert"]')).toBeNull();
    dispose(); await vi.advanceTimersByTimeAsync(40000); expect(m.fetchModelQuota).toHaveBeenCalledTimes(3);
  });
  it("recovers from a hung refresh, ignores its late response and cleans up a pending request", async () => {
    vi.useFakeTimers();
    const initial = { generatedAt: 1800000000, pollingEnabled: true, logins: [{ provider: "anthropic", accountRef: "last-good", source: "headers", updatedAt: 1800000000, stale: false, error: null, fiveHour: null, weekly: null, weeklyPace: null, fiveHourState: "unknown" }] };
    m.fetchModelQuota.mockResolvedValueOnce(initial);
    const container = mount(); await flush();
    let late!: (value: unknown) => void;
    m.fetchModelQuota.mockReturnValueOnce(new Promise((resolve) => { late = resolve; }));
    await vi.advanceTimersByTimeAsync(20000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(container.textContent).toContain("last-good");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to refresh quota.");
    m.fetchModelQuota.mockResolvedValueOnce({ ...initial, logins: [] });
    await vi.advanceTimersByTimeAsync(10000); expect(m.fetchModelQuota).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("No quota readings yet.");
    late(initial); await flush(); expect(container.textContent).not.toContain("last-good");
    m.fetchModelQuota.mockReturnValueOnce(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(20000);
    const pendingSignal = m.fetchModelQuota.mock.calls[3][0] as AbortSignal;
    dispose(); expect(pendingSignal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("shows the Quota tab only to single-user operators and superadmins", () => {
    for (const [caps, expected] of [[{ multiUser: false }, true], [{ multiUser: true, user: { role: "superadmin" } }, true], [{ multiUser: true, user: { role: "admin" } }, false], [{ multiUser: true, user: { role: "member" } }, false]] as const) {
      setCapabilitiesForTests(caps as never);
      const container = document.createElement("div"); document.body.append(container);
      dispose = render(() => <AdminLayout title="Admin" description="" />, container);
      expect(container.querySelector('a[href="/admin/quota"]') !== null).toBe(expected);
      dispose(); container.remove();
    }
  });
  it("denies admins, members and anonymous users without reading quota", async () => {
    for (const role of ["admin", "member", undefined]) {
      const container = mount({ multiUser: true, user: role ? { role } : undefined });
      await flush(); expect(container.textContent).toContain("Superadmin access required.");
      expect(m.fetchModelQuota).not.toHaveBeenCalled(); dispose(); container.remove();
    }
  });
});
