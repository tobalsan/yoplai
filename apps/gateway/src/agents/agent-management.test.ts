import { expect, it } from "vitest";
import {
  canCreateAgent,
  canEditAgentConfig,
  effectiveAgentManagementMode,
} from "./agent-management.js";

it("lets single-user gateways create and edit by default", () => {
  expect(effectiveAgentManagementMode(false)).toBe("anyone");
  expect(canCreateAgent("anyone", null)).toBe(true);
  expect(canEditAgentConfig("anyone", null, { canManage: true })).toBe(true);
});

it("defaults multi-user gateways to disabled", () => {
  expect(effectiveAgentManagementMode(true)).toBe("disabled");
  expect(canCreateAgent("disabled", "superadmin")).toBe(false);
});

it("reads the configured mode on multi-user gateways", () => {
  expect(
    effectiveAgentManagementMode(true, { agentManagement: "admin" })
  ).toBe("admin");
});

it("gates admin mode on staff and superadmin mode on superadmin", () => {
  expect(canCreateAgent("admin", "admin")).toBe(true);
  expect(canCreateAgent("admin", "superadmin")).toBe(true);
  expect(canCreateAgent("admin", "user")).toBe(false);
  expect(canCreateAgent("superadmin", "admin")).toBe(false);
  expect(canCreateAgent("superadmin", "superadmin")).toBe(true);
});

it("lets the creator edit in anyone mode without a manager role", () => {
  expect(canEditAgentConfig("anyone", "user", { isCreator: true })).toBe(true);
  expect(canEditAgentConfig("anyone", "user", { canManage: false })).toBe(false);
  expect(canEditAgentConfig("anyone", "user", { canManage: true })).toBe(true);
  expect(canEditAgentConfig("admin", "admin")).toBe(true);
  expect(canEditAgentConfig("superadmin", "admin")).toBe(false);
  expect(canEditAgentConfig("disabled", "user", { isCreator: true })).toBe(true);
  expect(canEditAgentConfig("disabled", "user")).toBe(false);
});
