// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { createScheduleMock, fetchSchedulesMock, updateScheduleMock } = vi.hoisted(() => ({
  createScheduleMock: vi.fn(),
  fetchSchedulesMock: vi.fn(),
  updateScheduleMock: vi.fn(),
}));

vi.mock("../api/schedules", () => ({
  createSchedule: createScheduleMock,
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: updateScheduleMock,
}));

import { SchedulesPanel } from "./SchedulesPanel";

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
  createScheduleMock.mockReset().mockResolvedValue({});
  updateScheduleMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  dispose?.();
  container.remove();
});

describe("SchedulesPanel", () => {
  it("shows the owner, updates credential mode, and creates owner-mode jobs by default", async () => {
    dispose = render(() => <SchedulesPanel agentId="scribe" defaultMode="owner" />, container);
    await settle();
    expect(container.textContent).toContain("Owner: Your account");

    const jobMode = container.querySelector<HTMLSelectElement>('select[aria-label="Credentials for Digest"]')!;
    jobMode.value = "owner";
    jobMode.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "job-1", "owner");

    const [name, prompt] = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".edit-agent-schedule-form input, .edit-agent-schedule-form textarea");
    name!.value = "Morning recap";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    prompt!.value = "Email my recap";
    prompt!.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector(".edit-agent-schedule-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(createScheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "scribe",
      name: "Morning recap",
      payload: { message: "Email my recap" },
      credentialMode: "owner",
    }));
  });
});
