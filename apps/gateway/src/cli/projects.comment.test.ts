import { describe, it, expect } from "vitest";
const projectsExtensionSpecifier = "@yoplai/extension-projects";
const { createProjectCommentHandler } = (await import(
  projectsExtensionSpecifier
)) as {
  createProjectCommentHandler: (options: {
    baseUrl: string;
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  }) => (args: {
    projectId: string;
    author: string;
    message: string;
  }) => Promise<void>;
};

describe("projects CLI comment", () => {
  it("posts comment to project thread endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };

    const handler = createProjectCommentHandler({
      baseUrl: "http://localhost:4000",
      fetchImpl,
    });

    await handler({
      projectId: "PRO-7",
      author: "human",
      message: "Hello.",
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "http://localhost:4000/api/projects/PRO-7/comments"
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body.author).toBe("human");
    expect(body.message).toBe("Hello.");
  });
});
