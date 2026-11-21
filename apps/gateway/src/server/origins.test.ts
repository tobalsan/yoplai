import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayLinkService } from "../relay/link.js";
import { relayLinkApi } from "../relay/link-routes.js";
import { createFileRemoteGatewayStore } from "../relay/store.js";
import { allowedCorsOrigins } from "./origins.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
});

describe("allowedCorsOrigins", () => {
  it("accepts the UI and gateway ports chosen by the launcher", () => {
    vi.stubEnv("YOPLAI_UI_PORT", "3777");
    vi.stubEnv("YOPLAI_GATEWAY_PORT", "4777");
    const origins = allowedCorsOrigins();
    expect(origins).toContain("http://localhost:3777");
    expect(origins).toContain("http://127.0.0.1:3777");
    expect(origins).toContain("http://localhost:4777");
  });

  it("lets a relay link write from the chosen UI port pass and refuses a foreign origin", async () => {
    vi.stubEnv("YOPLAI_UI_PORT", "3777");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "origins-"));
    const store = createFileRemoteGatewayStore(path.join(dir, "remote-gateways.json"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new RelayLinkService({
      store: () => store,
      now: Date.now,
      callbackPort: () => 4010,
      deviceLabel: () => "Laptop",
      connections: () => [],
      fetch: async () => new Response("{}", { status: 500 }),
    });
    const app = new Hono();
    app.use(
      "*",
      relayLinkApi({
        service: () => service,
        isEnabled: () => true,
        listener: () => ({ address: "127.0.0.1", port: 4010 }),
        configuredOrigins: allowedCorsOrigins,
        peerAddress: () => "127.0.0.1",
      })
    );
    const post = (origin: string) =>
      app.request("http://127.0.0.1:4010/api/relay/link/start", {
        method: "POST",
        headers: { host: "127.0.0.1:4010", origin, "content-type": "application/json" },
        body: JSON.stringify({ remote: "https://remote.example.test", name: "work" }),
      });
    const trusted = await post("http://localhost:3777");
    expect(await trusted.text()).not.toContain("untrusted_origin");
    const foreign = await post("https://evil.example.test");
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain("untrusted_origin");
  });
});
