import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appsAvailable,
  capabilities,
  capabilitiesReady,
  loadCapabilities,
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "./capabilities";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

describe("capabilities store", () => {
  const fetchMock = vi.fn<() => Promise<FetchResponse>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetCapabilitiesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCapabilitiesForTests();
  });

  it("distinguishes loading, enabled and unavailable app views", async () => {
    expect(appsAvailable()).toBeUndefined();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 2, extensions: {}, agents: [], multiUser: false, apps: { available: true } }) });
    await loadCapabilities();
    expect(appsAvailable()).toBe(true);
    setCapabilitiesForTests({ apps: { available: false } });
    expect(appsAvailable()).toBe(false);
    setCapabilitiesForTests({ apps: { available: true } });
    resetCapabilitiesForTests();
    expect(appsAvailable()).toBeUndefined();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 2, extensions: {}, agents: [], multiUser: false }) });
    await loadCapabilities();
    expect(appsAvailable()).toBe(false);
  });

  it("loads capabilities normally", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        version: 2,
        extensions: { projects: true },
        agents: ["main"],
        multiUser: false,
      }),
    });

    const result = await loadCapabilities();

    expect(result.multiUser).toBe(false);
    expect(capabilities.multiUser).toBe(false);
    expect(capabilitiesReady()).toBe(true);
    expect(capabilities.enableCronMonitoring).toBe(false);
  });

  it("defaults monitoring off when a later response omits the flag", async () => {
    setCapabilitiesForTests({ enableCronMonitoring: true });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ version: 2, extensions: {}, agents: [], multiUser: false }),
    });
    await loadCapabilities();
    expect(capabilities.enableCronMonitoring).toBe(false);
  });

  it("loads an enabled monitoring flag", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ version: 2, extensions: {}, agents: [], multiUser: false, enableCronMonitoring: true }),
    });
    await loadCapabilities();
    expect(capabilities.enableCronMonitoring).toBe(true);
  });

  it("keeps monitoring defaults off after enabling and resetting the store", () => {
    setCapabilitiesForTests({ enableCronMonitoring: true });
    resetCapabilitiesForTests();
    expect(capabilities.enableCronMonitoring).toBe(false);
    setCapabilitiesForTests({ enableCronMonitoring: true });
    setCapabilitiesForTests({});
    expect(capabilities.enableCronMonitoring).toBe(false);
  });

  it("treats 401 capabilities as multi-user boot state", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });

    const result = await loadCapabilities();

    expect(result.multiUser).toBe(true);
    expect(capabilities.multiUser).toBe(true);
    expect(capabilitiesReady()).toBe(true);
  });
});
