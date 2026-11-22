import { describe, expect, it } from "vitest";
import { agentManagementPolicy, effectiveAgentManagement, type AgentManagementValue } from "./policy.js";

describe("agent management policy", () => {
  it.each([
    [undefined, "127.0.0.2", true],
    [undefined, "::1", true],
    [undefined, "0.0.0.0", false],
    [undefined, undefined, false],
    [false, "127.0.0.1", false],
    [true, "0.0.0.0", true],
    ["admin", "0.0.0.0", true],
    ["superadmin", "0.0.0.0", true],
    ["anyone", "0.0.0.0", true],
  ] as const)("evaluates single-user setting %s on listener %s", (value, listenerAddress, allowed) => {
    const policy = agentManagementPolicy({ value, listenerAddress, multiUser: false, desktop: false });
    expect(policy.canCreate).toBe(allowed);
    expect(policy.canEditAgent()).toBe(allowed);
  });

  it.each([
    [undefined, [false, false, false]],
    [false, [false, false, false]],
    [true, [false, true, true]],
    ["admin", [false, true, true]],
    ["superadmin", [false, false, true]],
    ["anyone", [true, true, true]],
  ] satisfies [AgentManagementValue, boolean[]][])("restricts multi-user creation and editing in %s", (value, allowed) => {
    for (const [index, role] of ["user", "admin", "superadmin"].entries()) {
      const policy = agentManagementPolicy({ value, multiUser: true, desktop: false, listenerAddress: "127.0.0.1", actor: { userId: "mira", role } });
      expect(policy.canCreate).toBe(allowed[index]);
      expect(policy.canEditAgent("mira")).toBe(allowed[index]);
      expect(policy.canEditAgent("noel")).toBe(allowed[index] && role !== "user");
      expect(policy.canEditAgent()).toBe(allowed[index] && role !== "user");
    }
  });

  it("requires an eligible account in multi-user mode", () => {
    const policy = agentManagementPolicy({ value: "anyone", multiUser: true, desktop: false });
    expect(policy.canCreate).toBe(false);
    expect(policy.canEditAgent()).toBe(false);
  });

  it.each([undefined, false, true, "admin", "superadmin", "anyone"] satisfies AgentManagementValue[])("keeps desktop management on with %s and a non-loopback listener", (value) => {
    const policy = agentManagementPolicy({ value, multiUser: false, desktop: true, listenerAddress: "0.0.0.0" });
    expect(policy.canCreate).toBe(true);
    expect(policy.canEditAgent()).toBe(true);
  });

  it("prefers the config value, then the saved UI mode, then the default", () => {
    expect(effectiveAgentManagement(false, "anyone")).toEqual({ value: false, mode: "off", source: "config", locked: true });
    expect(effectiveAgentManagement(true, "off")).toEqual({ value: true, mode: "admin", source: "config", locked: true });
    expect(effectiveAgentManagement(undefined, "anyone")).toEqual({ value: "anyone", mode: "anyone", source: "ui", locked: false });
    expect(effectiveAgentManagement(undefined, "off")).toEqual({ value: false, mode: "off", source: "ui", locked: false });
    expect(effectiveAgentManagement(undefined, undefined)).toEqual({ value: undefined, mode: "off", source: "default", locked: false });
  });
});
