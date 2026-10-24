import { apiFetch } from "./core";

export type McpAppViewData = {
  available: true;
  sandboxUrl: string;
  appsOrigin: string;
  server: string;
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  csp: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  prefersBorder: boolean;
};

function endpoint(agentId: string, sessionId: string, toolCallId: string, operation: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/mcp-apps/${encodeURIComponent(toolCallId)}/${operation}`;
}

export async function loadMcpAppView(agentId: string, sessionId: string, toolCallId: string, signal: AbortSignal): Promise<McpAppViewData | { available: false; reason: string }> {
  const response = await apiFetch(endpoint(agentId, sessionId, toolCallId, "view"), { method: "POST", signal });
  if (!response.ok) throw new Error("View unavailable");
  return response.json();
}

export type McpAppRpcResponse = { jsonrpc: "2.0"; id: string | number | null } & (
  { result: unknown; error?: never } | { error: { code: number; message: string; data?: unknown }; result?: never }
);

export async function relayMcpAppRequest(agentId: string, sessionId: string, toolCallId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<McpAppRpcResponse> {
  const response = await apiFetch(endpoint(agentId, sessionId, toolCallId, "rpc"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal,
  });
  if (!response.ok) throw new Error("View request failed");
  return response.json();
}

export async function logMcpAppEvent(agentId: string, sessionId: string, toolCallId: string, event: { level: string; message: string }, signal: AbortSignal): Promise<void> {
  const response = await apiFetch(endpoint(agentId, sessionId, toolCallId, "log"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event), signal,
  });
  if (!response.ok) throw new Error("View log failed");
}
