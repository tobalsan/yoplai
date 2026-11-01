// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense } from "solid-js";
import type { JSX } from "solid-js";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

vi.mock("@solidjs/router", () => ({
  A: (props: { href: string; children?: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));

const { fetchSchedulesMock, updateScheduleMock, deleteScheduleMock, sessionUser, sessionPresent } = vi.hoisted(() => ({
  fetchSchedulesMock: vi.fn(),
  deleteScheduleMock: vi.fn(),
  updateScheduleMock: vi.fn(),
  sessionUser: { id: "alice", role: "user" as string | undefined },
  sessionPresent: { value: true },
}));

vi.mock("../auth/client", () => ({
  useSession: () => () => ({ data: sessionPresent.value ? { user: sessionUser } : null }),
}));

vi.mock("../api/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: updateScheduleMock,
  deleteSchedule: deleteScheduleMock,
}));

import { describeSchedule, SchedulesPanel } from "./SchedulesPanel";

let container: HTMLElement;
let dispose: () => void;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetCapabilitiesForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchSchedulesMock.mockReset().mockResolvedValue([{
    id: "job-1", agentId: "scribe", name: "Digest", credentialMode: "team",
    ownerUserId: "alice", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Send digest" },
  }]);
  updateScheduleMock.mockReset().mockResolvedValue({});
  sessionUser.role = "user";
  sessionPresent.value = true;
  deleteScheduleMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  dispose?.();
  container.remove();
  resetCapabilitiesForTests();
  vi.useRealTimers();
});

describe("describeSchedule", () => {
  it("reads cron recurrences in plain language", () => {
    expect(describeSchedule({ cron: "45 5 * * *", tz: "UTC" })).toMatch(/^Every day at /);
    expect(describeSchedule({ cron: "30 7 * * 1,4", tz: "UTC" })).toMatch(/^Monday and Thursday at /);
    expect(describeSchedule({ cron: "0 9 * * 1-5", tz: "UTC" })).toMatch(/^Monday through Friday at /);
    expect(describeSchedule({ cron: "*/15 * * * *", tz: "UTC" })).toBe("Every 15 minutes");
  });

  it("describes one-off runs and falls back to the raw expression", () => {
    expect(describeSchedule({ runAt: "2026-10-05T14:00:00Z" })).toMatch(/^Once, /);
    expect(describeSchedule({ cron: "not a cron", tz: "UTC" })).toBe("not a cron");
  });
});

describe("SchedulesPanel", () => {
  it.each(["superadmin", "admin", "user"])("labels foreign Mine jobs and locks management independently of viewer role: %s", async (role) => {
    sessionUser.role = role;
    setCapabilitiesForTests({ enableCronMonitoring: true });
    const job = { agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "foreign", name: "Bob's digest", credentialMode: "owner", ownerUserId: "bob", ownerDisplayName: "Bob" },
      { ...job, id: "unnamed", name: "Private reminder", credentialMode: "owner", ownerUserId: "charlie" },
      { ...job, id: "mine", name: "My digest", credentialMode: "owner", ownerUserId: "alice" },
      { ...job, id: "team", name: "Shared digest", credentialMode: "team", createdByUserId: "bob", createdByDisplayName: "Bob" },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const [foreign, unnamed, mine, team] = container.querySelectorAll(".schedule");
    expect(foreign!.textContent).toContain("Owned by Bob");
    expect(unnamed!.textContent).toContain("Owned by another user");
    expect(mine!.textContent).not.toContain("Owned by");
    expect(team!.textContent).toContain("Created by Bob");
    expect(team!.textContent).not.toContain("Owned by");
    expect(foreign!.querySelector(".schedule-title a")?.getAttribute("href")).toBe("/agents/scribe/schedules/foreign/runs");
    for (const row of [foreign!, unnamed!]) {
      expect(row.querySelector('[role="switch"]')).not.toBeNull();
      expect(row.querySelector('.schedule-delete')).not.toBeNull();
      expect(row.querySelectorAll('[role="radio"]')).toHaveLength(2);
      for (const control of row.querySelectorAll<HTMLButtonElement>('button')) {
        expect(control.disabled).toBe(true);
        expect(control.title).toBe("Only the owner can change this job");
        control.click();
      }
    }
    expect(updateScheduleMock).not.toHaveBeenCalled();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    for (const control of mine!.querySelectorAll<HTMLButtonElement>('button')) expect(control.disabled).toBe(false);
    expect(team!.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(role === "user");
    expect(team!.querySelector<HTMLButtonElement>('.schedule-delete')!.disabled).toBe(role === "user");
    for (const control of team!.querySelectorAll<HTMLButtonElement>('[role="radio"]')) expect(control.disabled).toBe(false);
  });

  it("keeps all management controls available without a session", async () => {
    sessionPresent.value = false;
    fetchSchedulesMock.mockResolvedValue([
      { id: "old-mine", agentId: "scribe", name: "Local reminder", credentialMode: "owner", ownerUserId: "bob", schedule: {}, payload: {} },
      { id: "team", agentId: "scribe", name: "Shared digest", credentialMode: "team", schedule: {}, payload: {} },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    expect(container.textContent).not.toContain("Owned by");
    const controls = container.querySelectorAll<HTMLButtonElement>('.schedule button');
    expect(controls).toHaveLength(8);
    for (const control of controls) expect(control.disabled).toBe(false);
  });

  it.each([0, 65_000])("shows elapsed time for a running job, including zero: %s", async (runningForMs) => {
    setCapabilitiesForTests({ enableCronMonitoring: true });
    fetchSchedulesMock.mockResolvedValue([{ id: "running", name: "Running job", schedule: {}, payload: {}, state: { runningForMs } }]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    expect(container.querySelector(".schedule-running")?.textContent).toBe(`Running ${runningForMs === 0 ? "0s" : "1m 5s"}`);
  });

  it("polls idle jobs to discover a run, updates elapsed time, and removes the badge on completion", async () => {
    vi.useFakeTimers();
    setCapabilitiesForTests({ enableCronMonitoring: true });
    const job = { id: "job", name: "Digest", schedule: {}, payload: {} };
    fetchSchedulesMock.mockResolvedValueOnce([{ ...job }])
      .mockResolvedValueOnce([{ ...job, state: { runningForMs: 0 } }])
      .mockResolvedValueOnce([{ ...job, state: { runningForMs: 2_000 } }])
      .mockResolvedValue([job]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".schedule-running")).toBeNull();
    const title = container.querySelector<HTMLAnchorElement>(".schedule-title a")!;
    title.focus();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector(".schedule-running")?.textContent).toBe("Running 0s");
    expect(document.activeElement).toBe(title);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector(".schedule-running")?.textContent).toBe("Running 2s");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector(".schedule-running")).toBeNull();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, false])("does not show a running badge or poll with flag %s", async (enabled) => {
    vi.useFakeTimers();
    setCapabilitiesForTests({ enableCronMonitoring: enabled });
    fetchSchedulesMock.mockResolvedValue([{ id: "job", name: "Digest", schedule: {}, payload: {}, state: { runningForMs: 4_000 } }]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.querySelector(".schedule-running")).toBeNull();
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps cards visible during pending and failed polls, avoids overlap, and recovers", async () => {
    vi.useFakeTimers();
    setCapabilitiesForTests({ enableCronMonitoring: true });
    dispose = render(() => <Suspense fallback={<p>Suspended</p>}><SchedulesPanel agentId="scribe" agentName="Scribe" /></Suspense>, container);
    await vi.advanceTimersByTimeAsync(0);
    let rejectPoll!: (error: Error) => void;
    fetchSchedulesMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPoll = reject; }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".schedule-title")?.textContent).toContain("Digest");
    expect(container.textContent).not.toContain("Suspended");
    rejectPoll(new Error("Connection lost"));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    expect(container.querySelector(".schedule-title")?.textContent).toContain("Digest");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stops polling and hides the badge when monitoring is disabled while mounted", async () => {
    vi.useFakeTimers();
    setCapabilitiesForTests({ enableCronMonitoring: true });
    fetchSchedulesMock.mockResolvedValue([{ id: "job", name: "Digest", schedule: {}, payload: {}, state: { runningForMs: 4_000 } }]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".schedule-running")).not.toBeNull();
    setCapabilitiesForTests({ enableCronMonitoring: false });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(container.querySelector(".schedule-running")).toBeNull();
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, false, true])("links job titles only when monitoring is enabled: %s", async (enabled) => {
    setCapabilitiesForTests({ enableCronMonitoring: enabled });
    fetchSchedulesMock.mockResolvedValue([{
      id: "once/job", agentId: "scribe", name: "Completed reminder", enabled: false,
      schedule: { runAt: "2026-10-05T14:00:00Z" }, payload: {},
    }]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const title = container.querySelector(".schedule-title")!;
    expect(title.textContent).toContain("Completed reminder");
    expect(title.textContent).toContain("Paused");
    expect(title.querySelector("a")?.getAttribute("href")).toBe(enabled ? "/agents/scribe/schedules/once%2Fjob/runs" : undefined);
    expect(title.textContent).not.toContain("Running");
  });

  it("recovers from a failed mode change and keeps jobs usable", async () => {
    updateScheduleMock.mockRejectedValueOnce(new Error("Connection lost"));
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const mine = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
    mine.click();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    expect(mine.disabled).toBe(false);
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(2);
    mine.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledTimes(2);
  });

  it("shows creator attribution only on shared jobs with a creator", async () => {
    const job = { id: "job", agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "mine", name: "Own shared", credentialMode: "team", createdByUserId: "alice", createdByDisplayName: "Alice" },
      { ...job, id: "other", name: "Other shared", credentialMode: "team", createdByUserId: "bob", createdByDisplayName: "Bob" },
      { ...job, id: "legacy", name: "Legacy", credentialMode: "team" },
      { ...job, id: "private", name: "Private", credentialMode: "owner", createdByUserId: "alice", createdByDisplayName: "Alice" },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const cards = container.querySelectorAll("li.schedule");
    expect(cards[0]!.textContent).toContain("Created by you");
    expect(cards[1]!.textContent).toContain("Created by Bob");
    expect(cards[2]!.textContent).not.toContain("Created by");
    expect(cards[3]!.textContent).not.toContain("Created by");
    expect(container.querySelector('button[title*="visible to everyone on the agent"]')).not.toBeNull();
  });

  it("lists jobs in plain language and switches their credentials", async () => {
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    expect(container.textContent).toContain("Digest");
    expect(container.textContent).toMatch(/Every day at /);
    expect(container.textContent).not.toContain("0 8 * * *");
    expect(container.textContent).toContain("Send digest");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("If you want to add a new job, just ask Scribe!");

    const group = container.querySelector('[aria-label="Credentials for Digest"]')!;
    const [mine, team] = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(team!.getAttribute("aria-checked")).toBe("true");
    mine!.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "job-1", { credentialMode: "owner" });
  });

  it("pauses own jobs but locks Team job toggles for non-admins", async () => {
    const job = { agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "mine", name: "Mine", credentialMode: "owner", ownerUserId: "alice", enabled: true },
      { ...job, id: "team", name: "Shared", credentialMode: "team", enabled: true },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const [mine, team] = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(team!.disabled).toBe(true);
    expect(team!.title).toContain("Only admins");
    mine!.click();
    expect(mine!.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("li.schedule")!.textContent).toContain("Paused");
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "mine", { enabled: false });
  });

  it("lets admins resume Team jobs", async () => {
    sessionUser.role = "admin";
    fetchSchedulesMock.mockResolvedValue([
      { id: "team", agentId: "scribe", name: "Shared", credentialMode: "team", enabled: false, schedule: { cron: "0 8 * * *" }, payload: {} },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(false);
    toggle.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "team", { enabled: true });
  });

  it("deletes only after confirmation and locks Team deletes for non-admins", async () => {
    const job = { agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "mine", name: "Mine", credentialMode: "owner", ownerUserId: "alice" },
      { ...job, id: "team", name: "Shared", credentialMode: "team" },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const [mine, team] = container.querySelectorAll<HTMLButtonElement>(".schedule-delete");
    expect(team!.disabled).toBe(true);
    mine!.click();
    const dialog = () => container.querySelector('[role="alertdialog"]');
    expect(dialog()!.textContent).toContain("Delete “Mine”?");
    dialog()!.querySelector<HTMLButtonElement>(".schedule-dialog-cancel")!.click();
    expect(dialog()).toBeNull();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    mine!.click();
    dialog()!.querySelector<HTMLButtonElement>(".schedule-dialog-danger")!.click();
    await settle();
    expect(deleteScheduleMock).toHaveBeenCalledWith("scribe", "mine");
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open with an error when delete fails", async () => {
    sessionUser.role = "admin";
    deleteScheduleMock.mockRejectedValueOnce(new Error("Only admins can delete Team jobs."));
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    container.querySelector<HTMLButtonElement>(".schedule-delete")!.click();
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("removes it for everyone");
    dialog.querySelector<HTMLButtonElement>(".schedule-dialog-danger")!.click();
    await settle();
    expect(container.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain("Only admins");
  });
});
