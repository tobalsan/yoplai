import type { ExtensionContext } from "@yoplai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getGatewayBaseUrl } from "./index.js";

function context(config: unknown): ExtensionContext {
  return {
    getConfig: () => config,
  } as ExtensionContext;
}

describe("webhooks extension", () => {
  const originalDev = process.env.YOPLAI_DEV;
  const originalGatewayPort = process.env.YOPLAI_GATEWAY_PORT;

  afterEach(() => {
    if (originalDev === undefined) delete process.env.YOPLAI_DEV;
    else process.env.YOPLAI_DEV = originalDev;
    if (originalGatewayPort === undefined) delete process.env.YOPLAI_GATEWAY_PORT;
    else process.env.YOPLAI_GATEWAY_PORT = originalGatewayPort;
  });

  it("logs the gateway URL in dev even when server baseUrl points at web UI", () => {
    process.env.YOPLAI_DEV = "1";
    process.env.YOPLAI_GATEWAY_PORT = "4003";

    expect(
      getGatewayBaseUrl(
        context({
          server: { baseUrl: "http://localhost:3003" },
          gateway: { host: "0.0.0.0", port: 4000 },
        })
      )
    ).toBe("http://127.0.0.1:4003");
  });

  it("uses configured server baseUrl outside dev", () => {
    delete process.env.YOPLAI_DEV;
    delete process.env.YOPLAI_GATEWAY_PORT;

    expect(
      getGatewayBaseUrl(
        context({
          server: { baseUrl: "https://example.test/" },
          gateway: { port: 4003 },
        })
      )
    ).toBe("https://example.test");
  });
});
