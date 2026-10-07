import { API_BASE, apiFetch as fetch } from "./core";

export type OnboardingStatus = "done" | "skipped";

export type OnboardingState = {
  supported: boolean;
  status: OnboardingStatus | null;
  at: string | null;
};

async function parse(res: Response): Promise<OnboardingState> {
  if (!res.ok) throw new Error(`onboarding request failed: ${res.status}`);
  return res.json() as Promise<OnboardingState>;
}

export async function fetchOnboarding(): Promise<OnboardingState> {
  return parse(await fetch(`${API_BASE}/me/onboarding`));
}

export async function saveOnboarding(
  status: OnboardingStatus
): Promise<OnboardingState> {
  return parse(
    await fetch(`${API_BASE}/me/onboarding`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    })
  );
}

export async function clearOnboarding(): Promise<OnboardingState> {
  return parse(await fetch(`${API_BASE}/me/onboarding`, { method: "DELETE" }));
}
