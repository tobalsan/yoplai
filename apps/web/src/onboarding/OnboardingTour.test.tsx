// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const highlight = vi.fn();
const destroy = vi.fn();
let config: { onDestroyStarted?: () => void } = {};
vi.mock("driver.js", () => ({
  driver: (c: typeof config) => {
    config = c;
    return { highlight, destroy };
  },
}));
vi.mock("driver.js/dist/driver.css", () => ({}));
vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/" }),
}));
const fetchOnboarding = vi.fn();
const saveOnboarding = vi.fn();
vi.mock("../api/onboarding", () => ({
  fetchOnboarding: () => fetchOnboarding(),
  saveOnboarding: (s: string) => saveOnboarding(s),
  clearOnboarding: vi.fn(),
}));

import { setCapabilitiesForTests } from "../lib/capabilities";
import { OnboardingTour } from "./OnboardingTour";
import { setTourStep, tourStep } from "./state";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("OnboardingTour", () => {
  let dispose: () => void;
  beforeEach(() => {
    highlight.mockReset();
    destroy.mockReset();
    saveOnboarding.mockReset().mockResolvedValue({});
    setTourStep(null);
    setCapabilitiesForTests({ multiUser: true, user: { id: "u" } } as never);
  });
  afterEach(() => dispose?.());

  it("starts for users without a saved flag and skip persists", async () => {
    fetchOnboarding.mockResolvedValue({ supported: true, status: null, at: null });
    dispose = render(() => <OnboardingTour />, document.body);
    await flush();
    await flush();
    expect(tourStep()).toBe(0);
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(highlight.mock.calls[0][0].popover.title).toMatch(/Welcome/);
    config.onDestroyStarted?.();
    expect(saveOnboarding).toHaveBeenCalledWith("skipped");
    expect(tourStep()).toBeNull();
  });

  it("stays off when the flag is saved", async () => {
    fetchOnboarding.mockResolvedValue({ supported: true, status: "done", at: "x" });
    dispose = render(() => <OnboardingTour />, document.body);
    await flush();
    await flush();
    expect(tourStep()).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
  });
});
