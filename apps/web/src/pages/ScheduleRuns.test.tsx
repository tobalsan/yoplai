// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";
import type { JSX } from "solid-js";
import type { ScheduleRun } from "@yoplai/shared/types";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

const { fetchRunsMock } = vi.hoisted(() => ({ fetchRunsMock: vi.fn() }));
vi.mock("../api/schedules", () => ({ fetchScheduleRuns: fetchRunsMock }));
vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children?: JSX.Element }) => <a href={props.href}>{props.children}</a>,
  useParams: () => ({ agentId: "scribe", jobId: "once-job" }),
}));

import { ScheduleRuns } from "./ScheduleRuns";

let container: HTMLElement;
let dispose: (() => void) | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const run = (patch: Partial<ScheduleRun>): ScheduleRun => ({
  id: "run-1", jobId: "once-job", agentId: "scribe", firedAt: "2026-10-05T08:00:00Z",
  startedAt: "2026-10-05T08:00:00Z", finishedAt: "2026-10-05T08:01:05Z",
  status: "ok", runKind: "woke_agent", prompt: "Send digest", storageOwnerId: null,
  ...patch,
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  setCapabilitiesForTests({ extensions: { scheduler: true }, enableCronMonitoring: true });
  fetchRunsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  resetCapabilitiesForTests();
  vi.useRealTimers();
});

describe("ScheduleRuns", () => {
  it("keeps the run list visible inside Suspense while a background poll is pending", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ScheduleRun[]) => void;
    fetchRunsMock.mockResolvedValueOnce([run({})])
      .mockReturnValueOnce(new Promise<ScheduleRun[]>((done) => { resolve = done; }));
    dispose = render(() => <Suspense fallback={<p data-poll-fallback>Loading app</p>}><ScheduleRuns /></Suspense>, container);
    await vi.advanceTimersByTimeAsync(0);
    const row = container.querySelector(".schedule-run")!;
    expect(row).not.toBeNull();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchRunsMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-poll-fallback]")).toBeNull();
    expect(container.querySelector(".schedule-run")).toBe(row);
    resolve([run({}), run({ id: "new", status: "running", finishedAt: undefined })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(2);
    expect(container.querySelector(".schedule-run")!.getAttribute("data-status")).toBe("running");
  });

  it("polls new runs into the list, pins running first, and stops polling on disposal", async () => {
    vi.useFakeTimers();
    fetchRunsMock.mockResolvedValueOnce([run({ id: "finished" })])
      .mockResolvedValue([run({ id: "finished" }), run({ id: "new", status: "running", finishedAt: undefined })]);
    dispose = render(() => <ScheduleRuns />, container);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const rows = container.querySelectorAll(".schedule-run");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-status")).toBe("running");
    expect(rows[0]!.querySelector(".schedule-run-status")!.textContent).toBe("Running");
    dispose();
    dispose = undefined;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchRunsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps runs visible through poll failures and does not overlap pending polls", async () => {
    vi.useFakeTimers();
    let reject!: (cause: Error) => void;
    fetchRunsMock.mockResolvedValueOnce([run({})])
      .mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce([run({}), run({ id: "new" })]);
    dispose = render(() => <ScheduleRuns />, container);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchRunsMock).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(1);
    reject(new Error("Loading run history timed out. Try again."));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(2);
  });

  it("loads per-job history, orders running first then newest, and displays outcomes", async () => {
    fetchRunsMock.mockResolvedValue([
      run({ id: "old", runKind: "silent_tick", gateOutput: "No updates", exitCode: 0 }),
      run({ id: "interrupted", startedAt: "2026-10-05T10:00:00Z", finishedAt: "2026-10-05T10:00:02Z", status: "interrupted", error: "Gateway restarted" }),
      run({ id: "running", startedAt: "2026-10-05T07:00:00Z", finishedAt: undefined, status: "running" }),
      run({ id: "failed", startedAt: "2026-10-05T09:00:00Z", finishedAt: "2026-10-05T09:00:03Z", status: "error", runKind: "script_only", exitCode: 1, gateOutput: "<script>unsafe</script>", error: "Script failed" }),
    ]);
    dispose = render(() => <ScheduleRuns />, container);
    await settle();
    expect(fetchRunsMock).toHaveBeenCalledWith("scribe", "once-job", undefined);
    const rows = container.querySelectorAll(".schedule-run");
    expect(Array.from(rows, (row) => row.getAttribute("data-status"))).toEqual(["running", "interrupted", "error", "ok"]);
    expect(rows[0]!.textContent).toContain("(ongoing)");
    expect(rows[1]!.textContent).toContain("Gateway restarted");
    expect(rows[2]!.textContent).toContain("script_only");
    expect(rows[2]!.textContent).toContain("Script failed");
    expect(rows[2]!.querySelector("pre")!.textContent).toBe("<script>unsafe</script>");
    expect(rows[2]!.querySelector("script")).toBeNull();
    expect(rows[3]!.textContent).toContain("1m 5s");
    expect(rows[3]!.textContent).toContain("silent_tick");
    expect(rows[3]!.textContent).toContain("Exit code0");
    expect(rows[3]!.textContent).toContain("No updates");
    expect(rows[3]!.querySelector("time")!.dateTime).toBe("2026-10-05T08:00:00Z");
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/agents/scribe/edit");
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("/agents/scribe/schedules/once-job/runs/running");
  });

  it.each([undefined, false])("does not fetch history when monitoring is %s", async (enabled) => {
    setCapabilitiesForTests({ extensions: { scheduler: true }, enableCronMonitoring: enabled });
    dispose = render(() => <ScheduleRuns />, container);
    await settle();
    expect(fetchRunsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Run history is unavailable.");
  });

  it("does not fetch history when the scheduler is disabled", async () => {
    setCapabilitiesForTests({ enableCronMonitoring: true, extensions: {} });
    dispose = render(() => <ScheduleRuns />, container);
    await settle();
    expect(fetchRunsMock).not.toHaveBeenCalled();
  });

  it("shows loading without an empty result while a request is pending", async () => {
    let resolve!: (runs: ScheduleRun[]) => void;
    fetchRunsMock.mockReturnValue(new Promise<ScheduleRun[]>((done) => { resolve = done; }));
    dispose = render(() => <ScheduleRuns />, container);
    expect(container.querySelector('[role="status"]')!.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("No runs yet");
    expect(container.querySelector("button")!.disabled).toBe(true);
    resolve([]);
    await settle();
    expect(container.textContent).toContain("No runs yet.");
    expect(container.querySelector("button")!.disabled).toBe(false);
  });

  it("recovers from a failed request using Retry", async () => {
    fetchRunsMock.mockRejectedValueOnce(new Error("Loading run history timed out. Try again."));
    dispose = render(() => <ScheduleRuns />, container);
    await settle();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("timed out");
    const retry = container.querySelector("button")!;
    expect(retry.textContent).toBe("Retry");
    expect(retry.disabled).toBe(false);
    fetchRunsMock.mockResolvedValue([run({})]);
    retry.click();
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll(".schedule-run")).toHaveLength(1);
  });

  it("refreshes a running outcome", async () => {
    fetchRunsMock.mockResolvedValueOnce([run({ status: "running", finishedAt: undefined })]);
    dispose = render(() => <ScheduleRuns />, container);
    await settle();
    expect(container.querySelector('.schedule-run[data-status="running"]')).not.toBeNull();
    fetchRunsMock.mockResolvedValue([run({ status: "ok" })]);
    container.querySelector("button")!.click();
    await settle();
    expect(container.querySelector('.schedule-run[data-status="ok"]')).not.toBeNull();
    expect(fetchRunsMock).toHaveBeenCalledTimes(2);
  });
});
