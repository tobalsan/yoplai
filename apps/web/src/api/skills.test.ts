// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSkillId } from "@yoplai/shared/skill-id-wire";
import {
  checkSkillDefault, deleteSkill, fetchSkill, fetchSkillVersions, makeSkillDefault, restoreSkillVersion, saveSkillShares, setSkillAdminDisabled,
  setSkillEnabled, setSkillSystem, SkillRequestError, transferSkillOwner, uploadSkill,
} from "./skills";

const ids = ["plain", "agent:hr:category/folder-name", "100%25 literal/%2F", "Ünï/日本語:x@east", "import", "../import", "agent:ams@east:a/b"];
const calls: Array<{ method: string; url: string }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url: typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const file = () => new File(["x"], "SKILL.md");
const helpers: Array<[string, (id: string, gateway?: string) => Promise<unknown>, string, string]> = [
  ["fetchSkill", (id, g) => fetchSkill(id, g), "GET", ""],
  ["setSkillEnabled", (id, g) => setSkillEnabled(id, true, g), "PUT", "/enabled"],
  ["uploadSkill (replace)", (id, g) => uploadSkill([file()], false, id, g), "PUT", "/content"],
  ["saveSkillShares", (id, g) => saveSkillShares(id, [], g), "PUT", "/shares"],
  ["deleteSkill", (id, g) => deleteSkill(id, g), "DELETE", ""],
  ["fetchSkillVersions", (id, g) => fetchSkillVersions(id, g), "GET", "/versions"],
  ["restoreSkillVersion", (id, g) => restoreSkillVersion(id, "v 1", g), "POST", "/versions/v%201/restore"],
  ["transferSkillOwner", (id, g) => transferSkillOwner(id, "u1", g), "PUT", "/owner"],
  ["checkSkillDefault", (id, g) => checkSkillDefault(id, g), "GET", "/default"],
  ["makeSkillDefault", (id, g) => makeSkillDefault(id, g), "POST", "/default"],
  ["setSkillSystem", (id, g) => setSkillSystem(id, true, g), "PUT", "/system"],
  ["setSkillAdminDisabled", (id, g) => setSkillAdminDisabled(id, true, g), "PUT", "/admin"],
];

describe("skill object helpers", () => {
  it.each(helpers)("%s sends the alias with the canonical wire ID to a linked gateway", async (_name, call, method, suffix) => {
    for (const id of ids) {
      calls.length = 0;
      await call(id, "east");
      expect(calls).toEqual([{ method, url: `/api/relay/gateways/east/api/skill-ids/${encodeSkillId(id)}${suffix}` }]);
    }
  });

  it.each(helpers)("%s keeps the legacy route on the local gateway", async (_name, call, method, suffix) => {
    for (const id of ids) {
      calls.length = 0;
      await call(id);
      expect(calls).toEqual([{ method, url: `/api/skills/${encodeURIComponent(id)}${suffix}` }]);
    }
  });

  it("creates an upload on the collection route, not the alias", async () => {
    await uploadSkill([file()], false, undefined, "east");
    expect(calls).toEqual([{ method: "POST", url: "/api/relay/gateways/east/api/skills" }]);
  });

  it("never puts a decoded ID, a slash, or a percent escape of the ID into the alias path", async () => {
    await fetchSkill("agent:hr:category/folder-name%2F..", "east");
    const url = calls[0].url;
    expect(url).not.toMatch(/%/);
    expect(url.slice("/api/relay/gateways/east/api/skill-ids/".length)).toMatch(/^v1_[A-Za-z0-9_-]+$/);
  });
});

const failureOf = async (run: () => Promise<unknown>): Promise<SkillRequestError> => {
  try { await run(); } catch (cause) { return cause as SkillRequestError; }
  throw new Error("The request did not fail.");
};

describe("old peer errors", () => {
  const answer = (status: number, body: BodyInit | null, type = "text/plain") => vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));

  it("reports an explicit upgrade error for a plain 404 or a refused relay route on an alias request, once", async () => {
    for (const mock of [answer(404, "404 Not Found"), answer(405, JSON.stringify({ error: "relay_route_not_allowed" }), "application/json"), answer(405, "no")]) {
      vi.stubGlobal("fetch", mock);
      const failure = await failureOf(() => setSkillEnabled("agent:hr:a/b", true, "east"));
      expect(failure).toBeInstanceOf(SkillRequestError);
      expect(failure.code).toBe("remote_skill_route_unsupported");
      expect(failure.message).toContain("Upgrade both gateways");
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the remote answer when the remote reports its own JSON error", async () => {
    vi.stubGlobal("fetch", answer(404, JSON.stringify({ error: "not_found" }), "application/json"));
    const failure = await failureOf(() => fetchSkill("agent:hr:a/b", "east"));
    expect(failure.code).toBe("not_found");
    vi.stubGlobal("fetch", answer(403, JSON.stringify({ error: "forbidden" }), "application/json"));
    expect((await failureOf(() => setSkillSystem("agent:hr:a/b", true, "east"))).code).toBe("forbidden");
  });

  it("does not use the upgrade error for a local plain 404, and does not call another route", async () => {
    const mock = answer(404, "404 Not Found");
    vi.stubGlobal("fetch", mock);
    const failure = await failureOf(() => fetchSkill("plain"));
    expect(failure.code).not.toBe("remote_skill_route_unsupported");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
