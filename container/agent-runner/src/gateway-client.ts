export async function callGatewayTool(
  gatewayUrl: string,
  agentToken: string,
  tool: string,
  args: unknown,
  agentId = "",
  sessionId?: string,
  runId?: string
): Promise<unknown> {
  const response = await fetch(new URL("/internal/tools", gatewayUrl), {
    method: "POST",
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
    }),
  });

  const result = (await response.json()) as unknown;
  if (!response.ok) {
    const detail =
      result && typeof result === "object" && "error" in result
        ? (result as { error: unknown }).error
        : undefined;
    throw new Error(
      `Gateway tool ${tool} failed with ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  return result;
}
