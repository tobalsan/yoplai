import { describe, expect, it } from "vitest";
import { buildDeliveryGuidance } from "./index.js";

describe("scheduler delivery guidance", () => {
  it("adds nothing when no DM or channel is usable", () => {
    expect(buildDeliveryGuidance([])).toBeUndefined();
    expect(buildDeliveryGuidance([{ target: "fixture", label: "Fixture" }])).toBeUndefined();
  });

  it("asks once for meaningful create/update changes and explains delivery noise", () => {
    const guidance = buildDeliveryGuidance([{ target: "slack", label: "Slack", dm: { user: "U_FIXTURE_1" } }]);

    expect(guidance).toContain('unless the user already named a destination or already declined');
    expect(guidance).toContain("Do not ask again in this conversation after a decline");
    expect(guidance).toContain("update_job");
    expect(guidance).toContain("payload, schedule or credentialMode");
    expect(guidance).toContain("not for name or enabled changes alone");
    expect(guidance).toContain("every run's result, not only errors");
    expect(guidance).toContain("silent tick or empty script stdout delivers nothing; errors always deliver");
    expect(guidance).toContain("Offer nothing outside this list");
    expect(guidance).toContain("Team options: none; do not ask, create without deliver.");
  });

  it("keeps private jobs out of shared channels while offering team channels", () => {
    const guidance = buildDeliveryGuidance([{ target: "telegram", label: "Telegram", channel: true }]);

    expect(guidance).toContain("Owner (private) options: none; do not ask, create without deliver.");
    expect(guidance).toContain("Team options:");
    expect(guidance).toContain("Team channel on Telegram");
    expect(guidance).toContain("ask the user which channel, never guess an id");
    expect(guidance).toContain("Only ask when an option fits the job's credentialMode");
  });
});
