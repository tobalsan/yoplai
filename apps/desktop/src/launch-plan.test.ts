import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createDevHome } from "./dev-home.js";
import { createDevLaunchPlan } from "./launch-plan.js";

it.each(["persistent", "fresh"])("isolates config overrides and child environments in %s mode", (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-launch-plan-"));
  try {
    const env = {
      HOME: root, YOPLAI_HOME: "~/selected", YOPLAI_DESKTOP_DEV_PARENT: root,
      YOPLAI_CONFIG: path.join(root, "not-yoplai.json"), AIHUB_CONFIG: path.join(root, "not-aihub.json"),
      YOPLAI_DESKTOP_KEYCHAIN: "1", OAUTH_ENCRYPTION_KEY: "sentinel", CUSTOM_KEY: "custom-sentinel",
    };
    const home = createDevHome(env, mode === "fresh" ? ["--fresh"] : [], root);
    const plan = createDevLaunchPlan({ gatewayPort: 4001, uiPort: 3001, appsPort: 4002 }, home, env, "CUSTOM_KEY");
    const gateway = plan.children.find((child) => child.name === "gateway")!;
    const web = plan.children.find((child) => child.name === "web")!;
    expect(gateway.env.YOPLAI_DESKTOP).toBe("1");
    expect(gateway.env.YOPLAI_APPS_PORT).toBe("4002");
    expect(gateway.env.YOPLAI_DESKTOP_KEYCHAIN).toBe(mode === "persistent" ? "1" : "0");
    expect(gateway.env.OAUTH_ENCRYPTION_KEY).toBe("sentinel");
    expect(gateway.env.CUSTOM_KEY).toBe("custom-sentinel");
    expect(web.env.OAUTH_ENCRYPTION_KEY).toBeUndefined();
    expect(web.env.CUSTOM_KEY).toBeUndefined();
    expect(web.env.YOPLAI_DESKTOP_KEYCHAIN).toBeUndefined();
    expect(plan.uiUrl).toBe("http://127.0.0.1:3001");
    for (const child of plan.children) {
      expect(child.env.HOME).toBe(mode === "persistent" ? root : path.dirname(home.home));
      expect(child.env.YOPLAI_HOME).toBe(home.home);
      expect(child.env.YOPLAI_CONFIG).toBeUndefined();
      expect(child.env.AIHUB_CONFIG).toBeUndefined();
      expect(child.env.YOPLAI_UI_HOST).toBe("127.0.0.1");
      expect(child.env.YOPLAI_GATEWAY_HOST).toBe("127.0.0.1");
      expect(child.env.YOPLAI_UI_PORT).toBe("3001");
      expect(child.env.YOPLAI_GATEWAY_PORT).toBe("4001");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
