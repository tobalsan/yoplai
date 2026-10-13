export async function callGatewayTool(
  gatewayUrl: string,
  agentToken: string,
  tool: string,
  args: unknown,
  agentId = "",
  sessionId?: string,
  runId?: string,
  options: {
    toolCallId?: string;
    timeoutSeconds?: number;
    modelToolName?: string;
    signal?: AbortSignal;
  } = {}
): Promise<unknown> {
  const response = await fetch(new URL("/internal/tools", gatewayUrl), {
    method: "POST",
    signal: options.signal,
    headers: {
      "content-type": "application/json",
      "X-Agent-Id": agentId,
      "X-Agent-Token": agentToken,
    },
    body: JSON.stringify({
      tool,
      args,
      agentId,
      agentToken,
      sessionId,
      runId,
      toolCallId: options.toolCallId,
      timeoutSeconds: options.timeoutSeconds,
      modelToolName: options.modelToolName,
    }),
  });

  if (!response.ok) {
    const result = await readJsonBody(response);
    const detail =
      result && typeof result === "object" && "error" in result
        ? (result as { error: unknown }).error
        : undefined;
    throw new Error(
      `Gateway tool ${tool} failed with ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  const result = await readJsonBody(response);
  if (result === undefined) {
    throw new Error(`Gateway tool ${tool} failed with ${response.status}`);
  }

  return result;
}

export interface OAuthTokenInput {
  gatewayUrl: string;
  agentToken: string;
  agentId: string;
  sessionId?: string;
  runId?: string;
}

export async function fetchOAuthToken(
  input: OAuthTokenInput,
  provider: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch(
    new URL("/internal/oauth-token", input.gatewayUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Agent-Id": input.agentId,
        "X-Agent-Token": input.agentToken,
      },
      body: JSON.stringify({
        provider,
        agentId: input.agentId,
        agentToken: input.agentToken,
        sessionId: input.sessionId,
        runId: input.runId,
      }),
    }
  );

  const result = await readJsonBody(response);
  if (!response.ok) {
    const detail =
      result && typeof result === "object" && "error" in result
        ? (result as { error: unknown }).error
        : undefined;
    throw new Error(
      `Gateway oauth-token for ${provider} failed with ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  return result as { accessToken: string; expiresAt: number };
}

/** Tolerates a non-JSON error body (e.g. a framework's default 500 page) instead of masking the real status/error with a JSON parse failure. */
async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
