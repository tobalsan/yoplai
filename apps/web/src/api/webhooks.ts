import { API_BASE, apiFetch } from "./core";

export type WebhookCredentials = {
  name: string;
  credentialMode: "owner" | "team";
  enabled: boolean;
  url: string;
  ownerUserId?: string;
  ownerDisplayName?: string;
};

export async function fetchWebhooks(
  agentId: string
): Promise<WebhookCredentials[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      `${API_BASE}/agents/${encodeURIComponent(agentId)}/webhooks`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error("Failed to load webhooks. Try again.");
    return await res.json();
  } catch (cause) {
    if (controller.signal.aborted)
      throw new Error("Loading webhooks timed out. Try again.");
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateWebhook(
  agentId: string,
  name: string,
  patch: {
    credentialMode?: WebhookCredentials["credentialMode"];
    enabled?: boolean;
  }
): Promise<WebhookCredentials> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      `${API_BASE}/agents/${encodeURIComponent(agentId)}/webhooks/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to update webhook. Try again.");
    }
    return await res.json();
  } catch (cause) {
    if (controller.signal.aborted)
      throw new Error("Updating webhook timed out. Try again.");
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}
