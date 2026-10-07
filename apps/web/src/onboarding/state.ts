import { createSignal } from "solid-js";
import { clearOnboarding } from "../api/onboarding";

const STEP_KEY = "yoplai.onboarding.step";

function readStep(): number | null {
  try {
    const raw = sessionStorage.getItem(STEP_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

const [tourStep, setTourStepSignal] = createSignal<number | null>(readStep());

export { tourStep };

export function setTourStep(step: number | null): void {
  setTourStepSignal(step);
  try {
    if (step === null) sessionStorage.removeItem(STEP_KEY);
    else sessionStorage.setItem(STEP_KEY, String(step));
  } catch {
    // sessionStorage unavailable: tour state lives in memory only.
  }
}

/** Clears the saved flag and starts the tour from the welcome card. */
export async function restartTour(): Promise<void> {
  await clearOnboarding();
  setTourStep(0);
}
