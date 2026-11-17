import { describe, expect, it } from "vitest";
import { createDevLaunchPlan } from "./launch-plan.js";

describe("dev launch plan", () => {
  it("forces loopback hosts and the chosen ports for every child", () => {
    const plan = createDevLaunchPlan({ gatewayPort: 4001, uiPort: 3001 });
    expect(plan.uiUrl).toBe("http://127.0.0.1:3001");
    for (const child of plan.children) {
      expect(child.env.YOPLAI_UI_HOST).toBe("127.0.0.1");
      expect(child.env.YOPLAI_GATEWAY_HOST).toBe("127.0.0.1");
      expect(child.env.YOPLAI_UI_PORT).toBe("3001");
      expect(child.env.YOPLAI_GATEWAY_PORT).toBe("4001");
    }
  });
});
