import { createSignal } from "solid-js";

const [connectPromptRequest, setConnectPromptRequest] = createSignal<{
  agentId: string;
  nonce: number;
} | null>(null);

export { connectPromptRequest };

/** Opens the "Connect <agent> to your tools" modal for an agent regardless of seen state. */
export function openConnectPrompt(agentId: string): void {
  setConnectPromptRequest({ agentId, nonce: Date.now() });
}

export function clearConnectPromptRequest(): void {
  setConnectPromptRequest(null);
}
