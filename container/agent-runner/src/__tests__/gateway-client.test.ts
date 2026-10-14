import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool, fetchOAuthToken } from "../gateway-client.js";

describe("fetchOAuthToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /internal/oauth-token with identity headers and body", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        Response.json(
          { accessToken: "new-token", expiresAt: 1_700_000_000_000 },
          { status: 200 }
        )
      );

    const result = await fetchOAuthToken(
      {
        gatewayUrl: "http://gateway:3000",
        agentToken: "token-1",
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
      },
      "openai-codex"
    );

    expect(result).toEqual({
      accessToken: "new-token",
      expiresAt: 1_700_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "http://gateway:3000/internal/oauth-token",
      }),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "X-Agent-Id": "agent-1",
          "X-Agent-Token": "token-1",
        }),
        body: JSON.stringify({
          provider: "openai-codex",
          agentId: "agent-1",
          agentToken: "token-1",
          sessionId: "session-1",
          runId: "run-1",
        }),
      })
    );
  });

  it("throws with the server error field on a non-2xx response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json({ error: "no stored oauth credential" }, { status: 404 })
    );

    await expect(
      fetchOAuthToken(
        {
          gatewayUrl: "http://gateway:3000",
          agentToken: "token-1",
          agentId: "agent-1",
        },
        "openai-codex"
      )
    ).rejects.toThrow(
      "Gateway oauth-token for openai-codex failed with 404: no stored oauth credential"
    );
  });

  it("throws a clean status-only error on a non-JSON error body instead of a JSON parse failure", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("<html>Internal Server Error</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      })
    );

    await expect(
      fetchOAuthToken(
        {
          gatewayUrl: "http://gateway:3000",
          agentToken: "token-1",
          agentId: "agent-1",
        },
        "openai-codex"
      )
    ).rejects.toThrow("Gateway oauth-token for openai-codex failed with 500");
  });
});

describe("gateway socket transport", () => {
  const servers: http.Server[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function socketServer(
    reply: unknown
  ): Promise<{ socketPath: string; requests: Array<{ url?: string; body: string }> }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygc-"));
    dirs.push(dir);
    const socketPath = path.join(dir, "gateway.sock");
    const requests: Array<{ url?: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ url: req.url, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { socketPath, requests };
  }

  it("sends tool calls through the socket, whatever the URL host", async () => {
    const { socketPath, requests } = await socketServer({ result: "done" });

    const result = await callGatewayTool(
      // Unresolvable on purpose: only the socket can carry this request.
      "http://host.docker.internal:4000",
      "token-1",
      "dashboard_link",
      { slug: "scout" },
      "agent-1",
      "session-1",
      "run-1",
      socketPath
    );

    expect(result).toEqual({ result: "done" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/internal/tools");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      tool: "dashboard_link",
      agentToken: "token-1",
    });
  });

  it("renews OAuth tokens through the socket", async () => {
    const { socketPath, requests } = await socketServer({
      accessToken: "fresh",
      expiresAt: 1,
    });

    const token = await fetchOAuthToken(
      {
        gatewayUrl: "http://host.docker.internal:4000",
        gatewaySocketPath: socketPath,
        agentToken: "token-1",
        agentId: "agent-1",
      },
      "anthropic"
    );

    expect(token).toEqual({ accessToken: "fresh", expiresAt: 1 });
    expect(requests[0].url).toBe("/internal/oauth-token");
  });
});
