import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { agentConfigAccess } from "./config-access.js";

const config = (extra: Partial<GatewayConfig> = {}) => ({ agents: [], ...extra }) as GatewayConfig;
const multi = (agentCreation?: "disabled" | "admin" | "anyone") =>
  config({ extensions: { multiUser: { enabled: true, agentCreation, oauth: { google: { clientId: "x", clientSecret: "y" } } } } as GatewayConfig["extensions"] });
const user = (role: string) => ({ role });

describe("agentConfigAccess", () => {
  it("enables a local single-user gateway by default", () => {
    expect(agentConfigAccess({ config: config(), multiUser: false, local: true, requester: null })).toEqual({ create: true, edit: true });
  });

  it("disables a remote single-user gateway by default", () => {
    expect(agentConfigAccess({ config: config(), multiUser: false, local: false, requester: null })).toEqual({ create: false, edit: false });
  });

  it("lets yoplai.json decide in both directions", () => {
    expect(agentConfigAccess({ config: config({ agentCreation: true }), multiUser: false, local: false, requester: null }).create).toBe(true);
    expect(agentConfigAccess({ config: config({ agentCreation: false }), multiUser: false, local: true, requester: null }).create).toBe(false);
  });

  it("keeps a multi-user gateway off by default", () => {
    expect(agentConfigAccess({ config: multi(), multiUser: true, local: false, requester: user("admin") })).toEqual({ create: false, edit: false });
  });

  it("limits admin mode to staff", () => {
    const access = (role: string) => agentConfigAccess({ config: multi("admin"), multiUser: true, local: false, requester: user(role) });
    expect(access("admin")).toEqual({ create: true, edit: true });
    expect(access("superadmin")).toEqual({ create: true, edit: true });
    expect(access("user")).toEqual({ create: false, edit: false });
  });

  it("lets any signed-in user in anyone mode", () => {
    expect(agentConfigAccess({ config: multi("anyone"), multiUser: true, local: false, requester: user("user") })).toEqual({ create: true, edit: true });
  });

  it("refuses anonymous requests on a multi-user gateway", () => {
    expect(agentConfigAccess({ config: multi("anyone"), multiUser: true, local: false, requester: null })).toEqual({ create: false, edit: false });
  });
});
