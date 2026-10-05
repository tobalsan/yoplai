// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { fetchSchedulesMock, updateScheduleMock } = vi.hoisted(() => ({
  fetchSchedulesMock: vi.fn(),
  updateScheduleMock: vi.fn(),
}));

vi.mock("../api/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: updateScheduleMock,
}));

import { describeSchedule, SchedulesPanel } from "./SchedulesPanel";

let container: HTMLElement;
let dispose: () => void;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchSchedulesMock.mockReset().mockResolvedValue([{
    id: "job-1", agentId: "scribe", name: "Digest", credentialMode: "team",
    ownerUserId: "alice", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Send digest" },
  }]);
  updateScheduleMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  dispose?.();
  container.remove();
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
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "job-1", "owner");
  });
});
