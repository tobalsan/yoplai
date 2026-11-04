// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { getByRole, queryByRole, queryByText } from "@testing-library/dom";
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
    for (const text of ["ChatGPT · Plus", "ab12", "42% used", "25% used", "Pace 0.50×", "Resets in 1h 0m", "(1m ago) · Source: ChatGPT usage endpoint", "Updated", "Fresh"]) expect(container.textContent).toContain(text);
    for (const [label, percent] of [["5-hour window", "42"], ["Weekly window", "25"]]) {
      const bar = getByRole(container, "progressbar", { name: label });
      expect(bar.getAttribute("aria-valuenow")).toBe(percent);
      expect(bar.getAttribute("aria-valuemin")).toBe("0");
      expect(bar.getAttribute("aria-valuemax")).toBe("100");
    }
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
    expect(rows[0].textContent).toContain("none");
    expect(queryByRole(rows[0] as HTMLElement, "progressbar", { name: "5-hour window" })).toBeNull();
    expect(queryByText(rows[0] as HTMLElement, "0% used")).toBeNull();
    expect(rows[1].textContent).toContain("Exhausted");
    for (const text of ["Stale", "Error: timeout", "Last known:", "42%", "—", "Claude response headers"]) expect(rows[2].textContent).toContain(text);
    expect(rows[2].querySelector(".quota-numbers--stale")).not.toBeNull();
    expect(getByRole(rows[2] as HTMLElement, "progressbar", { name: "Weekly window" }).getAttribute("data-dimmed")).toBe("true");
    expect(queryByRole(rows[2] as HTMLElement, "progressbar", { name: "5-hour window" })).toBeNull();
    expect(rows[2].textContent).toContain("Pace —");
    expect(rows[3].textContent).toContain("Error: invalid_payload"); expect(rows[3].textContent).not.toContain("Fresh");
    expect(queryByRole(rows[3] as HTMLElement, "progressbar")).toBeNull();
    expect(rows[3].textContent).not.toContain("Pace");
    expect(rows[3].textContent).toContain("Updated — · Source: —");
  });
  it("uses raw usage for warning and critical thresholds, rounding only the displayed value", async () => {
    const base = { provider: "anthropic", source: "headers", updatedAt: 1800000000, stale: false, error: null, weekly: null, weeklyPace: null, fiveHourState: "ok" };
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [74, 75, 89, 90, 74.6, 89.6].map((usedPercent) => ({ ...base, accountRef: `usage-${usedPercent}`, fiveHour: { usedPercent, resetAt: 1800003600 } })) });
    const container = mount(); await flush();
    const cards = container.querySelectorAll("article");
    for (const [index, tone, rounded] of [[0, "normal", "74"], [1, "warning", "75"], [2, "warning", "89"], [3, "critical", "90"], [4, "normal", "75"], [5, "warning", "90"]] as const) {
      const bar = getByRole(cards[index] as HTMLElement, "progressbar", { name: "5-hour window" });
      expect(bar.getAttribute("data-tone")).toBe(tone);
      expect(bar.getAttribute("aria-valuenow")).toBe(rounded);
      expect(cards[index].textContent).toContain(`${rounded}% used`);
      expect(queryByRole(cards[index] as HTMLElement, "progressbar", { name: "Weekly window" })).toBeNull();
      expect(cards[index].textContent).not.toContain("Pace");
    }
  });
  it("shows reset minutes, hours and days, and distinguishes due resets", async () => {
    const base = { provider: "anthropic", source: "headers", updatedAt: null, stale: false, error: null, weekly: null, weeklyPace: null, fiveHourState: "ok" };
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [1800000040, 1800001800, 1800016800, 1800003600, 1800183600, 1799999999, 1800000000].map((resetAt) => ({ ...base, accountRef: `reset-${resetAt}`, fiveHour: { usedPercent: 42, resetAt } })) });
    const container = mount(); await flush();
    const cards = container.querySelectorAll("article");
    for (const [index, expected] of ["Resets in <1m", "Resets in 30m", "Resets in 4h 40m", "Resets in 1h 0m", "Resets in 2d 3h", "Reset due", "Reset due"].entries()) {
      const time = cards[index].querySelector("time[title]")!;
      expect(time.textContent).toBe(expected);
      expect(time.getAttribute("title")).toBeTruthy();
      expect(time.getAttribute("dateTime")).toBeTruthy();
    }
  });
  it("keeps exhausted usage critical below 100 and dims both stale windows", async () => {
    const base = { provider: "anthropic", source: "headers", updatedAt: 1800000000, stale: true, error: "limited", weekly: { usedPercent: 75, resetAt: 1800086400 }, weeklyPace: 2.48, fiveHourState: "exhausted" };
    m.fetchModelQuota.mockResolvedValue({ generatedAt: 1800000000, pollingEnabled: true, logins: [
      { ...base, accountRef: "limited", fiveHour: { usedPercent: 50, resetAt: 1800003600 } },
      { ...base, accountRef: "full", fiveHour: { usedPercent: 100, resetAt: 1800003600 } },
    ] });
    const container = mount(); await flush();
    const cards = container.querySelectorAll("article");
    for (const [index, percent] of ["50", "100"].entries()) {
      const fiveHour = getByRole(cards[index] as HTMLElement, "progressbar", { name: "5-hour window" });
      const weekly = getByRole(cards[index] as HTMLElement, "progressbar", { name: "Weekly window" });
      expect(fiveHour.getAttribute("data-tone")).toBe("critical");
      expect(fiveHour.getAttribute("aria-valuenow")).toBe(percent);
      expect(weekly.getAttribute("data-tone")).toBe("warning");
      for (const bar of [fiveHour, weekly]) expect(bar.getAttribute("data-dimmed")).toBe("true");
      expect(cards[index].textContent).toContain("Exhausted");
      expect(cards[index].textContent).toContain("Pace 2.48×");
      expect(cards[index].textContent).not.toContain("Claude ·");
    }
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
