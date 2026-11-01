import { describe, expect, it } from "vitest";
import { visibleDashboards, visibleJobs } from "./private-items";

describe("private items", () => {
  it("keeps own Mine, Team and legacy-mode jobs while hiding foreign Mine jobs", () => {
    const rows = [
      { id: "own", credentialMode: "owner" as const, ownerUserId: "alice" },
      { id: "team", credentialMode: "team" as const, ownerUserId: "bob" },
      { id: "missing-mode", ownerUserId: "bob" },
      { id: "missing-owner", credentialMode: "owner" as const },
      { id: "foreign", credentialMode: "owner" as const, ownerUserId: "bob" },
    ];
    expect(visibleJobs(rows, "alice", false).map((row) => row.id))
      .toEqual(["own", "team", "missing-mode", "missing-owner"]);
    expect(visibleJobs(rows, "alice", true).map((row) => row.id))
      .toEqual(["own", "team", "missing-mode", "missing-owner", "foreign"]);
    expect(visibleJobs(rows, undefined, false).map((row) => row.id))
      .toEqual(["own", "team", "missing-mode", "missing-owner", "foreign"]);
  });
  it("keeps own, legacy and shared dashboards while hiding foreign private dashboards", () => {
    const rows = [
      { id: "own", isOwner: true, legacy: false, shared: false },
      { id: "legacy", isOwner: false, legacy: true, shared: false },
      { id: "shared-with-me", isOwner: false, legacy: false, shared: true },
      { id: "shared-with-everyone", isOwner: false, legacy: false, shared: true },
      { id: "private", isOwner: false, legacy: false, shared: false },
    ];
    expect(visibleDashboards(rows, "alice", false).map((row) => row.id))
      .toEqual(["own", "legacy", "shared-with-me", "shared-with-everyone"]);
    expect(visibleDashboards(rows, "alice", true).map((row) => row.id))
      .toEqual(["own", "legacy", "shared-with-me", "shared-with-everyone", "private"]);
    expect(visibleDashboards(rows, undefined, false).map((row) => row.id))
      .toEqual(["own", "legacy", "shared-with-me", "shared-with-everyone", "private"]);
  });
});
