// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFullHistory } from "./agents";
import { archiveAgentSession, deleteAgentSession, pinAgentSession, postAbort, postCompact, renameAgentSession } from "./chat";

const RAW_ID = "a#b?c/d%e@east";
const RAW_SESSION = "s#1?x/y";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The request URL as the server sees it: path and query, with the fragment dropped. */
function serverView(url: string) {
  const parsed = new URL(url, "http://gateway.test");
  return { path: parsed.pathname, hasFragment: parsed.hash !== "" };
}

describe("raw agent IDs in chat HTTP paths", () => {
  it("keeps one path segment for the agent and the session in every request", async () => {
    const fetchMock = stubFetch();
    await fetchFullHistory(RAW_ID, "main");
    await postAbort(RAW_ID, "main", RAW_SESSION);
    await postCompact(RAW_ID, "main", RAW_SESSION);
    await deleteAgentSession(RAW_ID, RAW_SESSION);
    await renameAgentSession(RAW_ID, RAW_SESSION, "Title");
    await pinAgentSession(RAW_ID, RAW_SESSION, true);
    await archiveAgentSession(RAW_ID, RAW_SESSION, true);

    const agent = encodeURIComponent(RAW_ID);
    const session = encodeURIComponent(RAW_SESSION);
    const seen = fetchMock.mock.calls.map(([url]) => serverView(url as string));
    expect(seen.map((s) => s.path)).toEqual([
      `/api/agents/${agent}/history`,
      `/api/agents/${agent}/messages`,
      `/api/agents/${agent}/compact`,
      ...Array(4).fill(`/api/agents/${agent}/sessions/${session}`),
    ]);
    expect(seen.some((s) => s.hasFragment)).toBe(false);
    // The server decodes each segment back to the raw ID.
    for (const { path } of seen) expect(decodeURIComponent(path.split("/")[3])).toBe(RAW_ID);
  });
});
