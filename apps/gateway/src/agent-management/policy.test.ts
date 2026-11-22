import type { GatewayConfig } from "@yoplai/shared";
import { describe, expect, it } from "vitest";
import { canCreate, canEdit, resolveMode, type Requester } from "./policy.js";

const config = (extra: Partial<GatewayConfig> = {}) => ({ agents: [], extensions: {}, ...extra }) as unknown as GatewayConfig;
const user = (roles: string[], userId = "u1"): Requester => ({ multiUser: true, userId, roles });
const local: Requester = { multiUser: false, roles: [] };

describe("resolveMode", () => {
  it("is on for a local single-user gateway by default", () => {
    expect(resolveMode(config(), false)).toBe("single");
    expect(resolveMode(config({ gateway: { host: "127.0.0.1" } }), false)).toBe("single");
  });
  it("is off by default for a remote or multi-user gateway", () => {
    expect(resolveMode(config({ gateway: { bind: "lan" } }), false)).toBe("off");
    expect(resolveMode(config({ gateway: { host: "0.0.0.0" } }), false)).toBe("off");
    expect(resolveMode(config(), true)).toBe("off");
  });
  it("lets yoplai.json turn it on for a remote gateway or off for a local one", () => {
    expect(resolveMode(config({ gateway: { bind: "lan" }, agentManagement: true }), false)).toBe("single");
    expect(resolveMode(config({ agentManagement: false }), false)).toBe("off");
  });
  it("reads the multi-user modes", () => {
    expect(resolveMode(config({ agentManagement: "anyone" }), true)).toBe("anyone");
    expect(resolveMode(config({ agentManagement: "superadmin" }), true)).toBe("superadmin");
    expect(resolveMode(config({ agentManagement: true }), true)).toBe("admin");
  });
  it("stays off with pooled agents", () => {
    expect(resolveMode(config({ forkedAgents: true, agentManagement: true }), false)).toBe("off");
  });
});

describe("permissions", () => {
  it("never allows anyone when off", () => {
    expect(canCreate("off", local)).toBe(false);
    expect(canCreate("off", user(["superadmin"]))).toBe(false);
  });
  it("allows the local operator in single mode", () => {
    expect(canCreate("single", local)).toBe(true);
    expect(canEdit("single", local, undefined)).toBe(true);
  });
  it("limits superadmin mode to superadmins", () => {
    expect(canCreate("superadmin", user(["admin"]))).toBe(false);
    expect(canCreate("superadmin", user(["superadmin"]))).toBe(true);
  });
  it("lets admin mode include superadmins and exclude users", () => {
    expect(canCreate("admin", user(["user"]))).toBe(false);
    expect(canCreate("admin", user(["admin"]))).toBe(true);
    expect(canCreate("admin", user(["superadmin"]))).toBe(true);
    expect(canEdit("admin", user(["admin"]), "someone-else")).toBe(true);
  });
  it("lets anyone create, edit their own agents, and lets staff edit all", () => {
    expect(canCreate("anyone", user(["user"]))).toBe(true);
    expect(canEdit("anyone", user(["user"]), "u1")).toBe(true);
    expect(canEdit("anyone", user(["user"]), "u2")).toBe(false);
    expect(canEdit("anyone", user(["user"]), undefined)).toBe(false);
    expect(canEdit("anyone", user(["admin"]), "u2")).toBe(true);
  });
});
