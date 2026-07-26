import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";

// Media tied to an agent session must inherit that agent's access boundary:
// download and upload both consult the team-access resolver (with staff
// bypass). This exercises the multi-user path end-to-end through the api
// sub-app, driving `hasAgentAccess` per authenticated user.

type AuthCtx = {
  user: { id: string; role?: string | string[] | null };
  session: { id: string; userId: string };
} | null;

const state = vi.hoisted(() => ({
  authContext: null as AuthCtx,
  // agentId -> set of userIds allowed to chat it. Staff bypass is modeled by
  // the mock returning true for admin/superadmin roles regardless.
  access: {} as Record<string, Set<string>>,
}));

vi.mock("../extensions/registry.js", () => ({
  getLoadedExtensions: () => [{ id: "multiUser" }],
  isExtensionLoaded: (extensionId: string) => extensionId === "multiUser",
  getExtensionRuntime: () => ({
    getCapabilities: () => ({
      extensions: {},
      capabilities: {},
      multiUser: true,
      home: undefined,
    }),
    getRouteMatchers: () => [],
    isEnabled: (extensionId: string) => extensionId === "multiUser",
  }),
  isMultiUserLoaded: () => true,
  getHomeExtension: () => undefined,
}));

function hasStaffRole(role: unknown): boolean {
  const staff = ["admin", "superadmin"];
  if (Array.isArray(role)) return role.some((r) => staff.includes(String(r)));
  return typeof role === "string" && staff.includes(role);
}

vi.mock("@yoplai/extension-multi-user", () => ({
  getForwardedAuthContext: vi.fn(() => state.authContext),
  getAgentFilter: vi.fn(() => (agents: unknown[]) => agents),
  hasAgentAccess: vi.fn(
    async (
      authContext: AuthCtx,
      agentId: string
    ): Promise<boolean> => {
      if (!authContext) return false;
      if (hasStaffRole(authContext.user.role)) return true;
      return state.access[agentId]?.has(authContext.user.id) ?? false;
    }
  ),
}));

describe("media access gating (multi-user)", () => {
  let tmpDir: string;
  let api: {
    request: (
      input: RequestInfo,
      init?: RequestInit
    ) => Response | Promise<Response>;
  };
  let mediaMetadata: typeof import("../media/metadata.js");
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  const AGENT = "sales";
  const OTHER_AGENT = "support";
  const AUTHORIZED_USER = "alice";
  const UNAUTHORIZED_USER = "mallory";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-media-access-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    // alice may chat `sales`; nobody is granted `support` (both users lack it).
    state.access = {
      [AGENT]: new Set([AUTHORIZED_USER]),
      [OTHER_AGENT]: new Set<string>(),
    };

    vi.resetModules();
    const mod = await import("../server/api.core.js");
    api = mod.api;
    mediaMetadata = await import("../media/metadata.js");
    await mediaMetadata.ensureMediaDirectories();
  });

  afterAll(async () => {
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.authContext = null;
  });

  function asUser(id: string, role?: string): void {
    state.authContext = {
      user: { id, role: role ?? "user" },
      session: { id: `session-${id}`, userId: id },
    };
  }

  async function registerAgentBoundFile(fileId: string): Promise<void> {
    const storedFilename = `${fileId}.txt`;
    const filePath = path.join(
      mediaMetadata.MEDIA_OUTBOUND_DIR,
      storedFilename
    );
    await fs.writeFile(filePath, "secret");
    await mediaMetadata.registerMediaFile({
      direction: "outbound",
      fileId,
      filename: "answer.txt",
      storedFilename,
      path: filePath,
      mimeType: "text/plain",
      size: 6,
      agentId: AGENT,
    });
  }

  it("rejects download of an agent-bound file for an unauthorized user", async () => {
    const fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await registerAgentBoundFile(fileId);
    asUser(UNAUTHORIZED_USER);

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));
    expect(res.status).toBe(403);
  });

  it("allows download of an agent-bound file for an authorized user", async () => {
    const fileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await registerAgentBoundFile(fileId);
    asUser(AUTHORIZED_USER);

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret");
  });

  it("allows staff to download an agent-bound file regardless of membership", async () => {
    const fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await registerAgentBoundFile(fileId);
    // A staff user who is not a member of the agent's team.
    asUser("boss", "admin");

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));
    expect(res.status).toBe(200);
  });

  it("leaves unbound media open (no agentId)", async () => {
    const fileId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const storedFilename = `${fileId}.txt`;
    const filePath = path.join(
      mediaMetadata.MEDIA_OUTBOUND_DIR,
      storedFilename
    );
    await fs.writeFile(filePath, "open");
    await mediaMetadata.registerMediaFile({
      direction: "outbound",
      fileId,
      filename: "open.txt",
      storedFilename,
      path: filePath,
      mimeType: "text/plain",
      size: 4,
    });
    asUser(UNAUTHORIZED_USER);

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("open");
  });

  function uploadRequest(agentId: string): Request {
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "note.txt", { type: "text/plain" })
    );
    formData.set("agentId", agentId);
    return new Request("http://localhost/media/upload", {
      method: "POST",
      body: formData,
    });
  }

  it("rejects an agent-bound upload for an unauthorized user", async () => {
    asUser(UNAUTHORIZED_USER);
    const res = await Promise.resolve(api.request(uploadRequest(AGENT)));
    expect(res.status).toBe(403);
  });

  it("allows an agent-bound upload for an authorized user and binds the file", async () => {
    asUser(AUTHORIZED_USER);
    const res = await Promise.resolve(api.request(uploadRequest(AGENT)));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { filename: string };
    const fileId = path.basename(json.filename, path.extname(json.filename));
    const meta = await mediaMetadata.getMediaFileMetadata(fileId);
    expect(meta?.agentId).toBe(AGENT);

    // The bound file is then gated for the unauthorized user on download.
    asUser(UNAUTHORIZED_USER);
    const dl = await Promise.resolve(api.request(`/media/download/${fileId}`));
    expect(dl.status).toBe(403);
  });

  it("allows staff to perform an agent-bound upload regardless of membership", async () => {
    asUser("boss", "superadmin");
    const res = await Promise.resolve(api.request(uploadRequest(OTHER_AGENT)));
    expect(res.status).toBe(200);
  });
});
