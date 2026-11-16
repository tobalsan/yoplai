import fs from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// Approved seam: ALG-493 comment a70f1a86-1365-4939-b563-0fea11128f5e.
// Public session.prompt + native transports + offline fetch catches serialized
// declarations and tool changes; it misses live provider acceptance/cache hits.
const sessions: AgentSession[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function eventStream(events: Record<string, unknown>[]) {
  return new Response(
    events
      .map(
        (event) =>
          `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function finishedResponse(api: Api) {
  if (api === "anthropic-messages") {
    return eventStream([
      {
        type: "message_start",
        message: {
          id: "msg-fixture",
          type: "message",
          role: "assistant",
          content: [],
          model: "offline",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);
  }
  if (api === "openai-completions") {
    return eventStream([
      {
        id: "chat-fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Done" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);
  }
  const message = {
    id: "msg-fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done", annotations: [] }],
  };
  return eventStream([
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "response-fixture",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function nativeSession(api: Api, compat?: Model<Api>["compat"]) {
  const directory = await fs.mkdtemp(
    path.join(process.cwd(), ".deferral-provider-")
  );
  directories.push(directory);
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const compressed =
        new Headers(init?.headers).get("content-encoding") === "zstd";
      const body =
        compressed && init?.body instanceof Uint8Array
          ? zstdDecompressSync(init.body).toString("utf8")
          : String(init?.body);
      requests.push(JSON.parse(body));
      return finishedResponse(api);
    })
  );
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("deferral-offline", {
    api,
    baseUrl: "https://provider.invalid/v1",
    // Synthetic JWT: Codex's transport requires an account claim even offline.
    apiKey:
      api === "openai-codex-responses"
        ? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64url")}.fixture`
        : "offline-fixture-key",
    models: [
      {
        id: "offline",
        name: "Offline transport fixture",
        api,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 100,
        compat,
      },
    ],
  });
  const settings = SettingsManager.inMemory({
    transport: "sse",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createToolSearchExtension()],
    systemPromptOverride: () => "Offline provider fixture.",
  });
  await loader.reload();
  const model = runtime.getModel("deferral-offline", "offline");
  if (!model) throw new Error("Offline fixture model missing");
  const fixtureTool: ToolDefinition = {
    name: "fixture_lookup",
    label: "Fixture lookup",
    description: "UNLOADED_SCHEMA_MARKER_493",
    exposure: "deferred",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "fixture result" }],
      details: {},
    }),
  };
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: ["tool_search", "fixture_lookup"],
    customTools: [fixtureTool],
  });
  sessions.push(session);
  session.setActiveToolsByName(["tool_search"]);
  return { session, requests, fixtureTool };
}

async function prompt(session: AgentSession, text: string) {
  await session.prompt(text);
  const last = session.messages.at(-1);
  expect(
    last,
    last?.role === "assistant" ? last.errorMessage : undefined
  ).toMatchObject({ role: "assistant", stopReason: "stop" });
}

describe("Pi deferred tools through native provider serialization (offline)", () => {
  it("anchors Anthropic's first request with a placeholder and adds loaded schemas inline", async () => {
    const { session, requests } = await nativeSession("anthropic-messages", {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    });
    await prompt(session, "First request");
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([
      expect.objectContaining({ name: "tool_search" }),
      expect.objectContaining({
        name: "__pi_deferred_placeholder__",
        defer_loading: true,
      }),
    ]);
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: expect.objectContaining({
                  name: "fixture_lookup",
                  description: "UNLOADED_SCHEMA_MARKER_493",
                }),
              },
            }),
          ]),
        }),
      ])
    );
  });

  it("sends Responses additions inline when supportsAdditionalTools is enabled", async () => {
    const { session, requests } = await nativeSession("openai-responses", {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    });
    await prompt(session, "First request");
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].input).toEqual(
      expect.arrayContaining([
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            expect.objectContaining({ type: "function", name: "tool_search" }),
          ],
        },
      ])
    );
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            expect.objectContaining({
              type: "function",
              name: "fixture_lookup",
              description: "UNLOADED_SCHEMA_MARKER_493",
            }),
          ],
        },
      ])
    );
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"tool_search_call"'
    );
  });

  it("represents Responses additions as client tool search when only supportsToolSearch is enabled", async () => {
    const { session, requests } = await nativeSession("openai-responses", {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: false,
      supportsToolSearch: true,
    });
    await prompt(session, "First request");
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_search_call",
          execution: "client",
          arguments: { query: "fixture_lookup", limit: 1 },
        }),
        expect.objectContaining({
          type: "tool_search_output",
          execution: "client",
          tools: [
            expect.objectContaining({
              type: "function",
              name: "fixture_lookup",
              description: "UNLOADED_SCHEMA_MARKER_493",
            }),
          ],
        }),
      ])
    );
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"additional_tools"'
    );
  });

  it("resends the current tool list for Responses without either inline capability", async () => {
    const { session, requests } = await nativeSession("openai-responses", {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
    });
    await prompt(session, "First request");
    expect(requests[0].tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" }),
    ]);
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests[1].tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" }),
      expect.objectContaining({
        type: "function",
        name: "fixture_lookup",
        description: "UNLOADED_SCHEMA_MARKER_493",
      }),
    ]);
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"additional_tools"'
    );
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"tool_search_output"'
    );
  });

  it("uses the Codex fallback with inline capabilities left at their defaults", async () => {
    const { session, requests } = await nativeSession("openai-codex-responses");
    await prompt(session, "First request");
    expect(requests[0].tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" }),
    ]);
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual([
      expect.objectContaining({ type: "function", name: "tool_search" }),
      expect.objectContaining({
        type: "function",
        name: "fixture_lookup",
        description: "UNLOADED_SCHEMA_MARKER_493",
      }),
    ]);
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"additional_tools"'
    );
    expect(JSON.stringify(requests[1].input)).not.toContain(
      '"type":"tool_search_output"'
    );
  });

  it("sends the current active schemas at the top level for openai-completions", async () => {
    const { session, requests } = await nativeSession("openai-completions");
    await prompt(session, "First request");
    expect(requests[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "tool_search" }),
      }),
    ]);
    expect(JSON.stringify(requests[0])).not.toContain(
      "UNLOADED_SCHEMA_MARKER_493"
    );
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "Use the loaded tool");
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "tool_search" }),
      }),
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "fixture_lookup",
          description: "UNLOADED_SCHEMA_MARKER_493",
        }),
      }),
    ]);
    session.setActiveToolsByName(["tool_search"]);
    await prompt(session, "After removing the tool");
    expect(requests[2].tools).toEqual(requests[0].tools);
  });

  it("announces a removed Responses tool while retaining its inline declaration", async () => {
    const { session, requests } = await nativeSession("openai-responses", {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    });
    await prompt(session, "First request");
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "With the loaded tool");
    expect(JSON.stringify(requests[1].input)).toContain(
      '"type":"additional_tools"'
    );
    session.setActiveToolsByName(["tool_search"]);
    await prompt(session, "After removing the tool");
    expect(requests).toHaveLength(3);
    expect(requests[2].tools).toBeUndefined();
    expect(requests[2].input).toEqual(
      expect.arrayContaining([
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            expect.objectContaining({
              type: "function",
              name: "fixture_lookup",
              description: "UNLOADED_SCHEMA_MARKER_493",
            }),
          ],
        },
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "The following tools are no longer available. Do not call them:\n- fixture_lookup"
          ),
        }),
      ])
    );
    expect(JSON.stringify(requests[2].input)).not.toContain(
      '"type":"tool_search_output"'
    );
  });

  it("sends Responses' replacement schema inline after a same-name tool redefinition", async () => {
    const { session, requests, fixtureTool } = await nativeSession(
      "openai-responses",
      {
        supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
      }
    );
    await prompt(session, "First request");
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "With the loaded tool");
    expect(JSON.stringify(requests[1].input)).toContain(
      '"type":"additional_tools"'
    );
    fixtureTool.description = "REDEFINED_SCHEMA_MARKER_493";
    fixtureTool.parameters = Type.Object({ reference: Type.String() });
    await session.reload();
    session.setActiveToolsByName(["tool_search", "fixture_lookup"]);
    await prompt(session, "After redefining the tool");
    expect(requests).toHaveLength(3);
    expect(requests[2].tools).toBeUndefined();
    expect(requests[2].input).toEqual(
      expect.arrayContaining([
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            expect.objectContaining({
              type: "function",
              name: "fixture_lookup",
              description: "REDEFINED_SCHEMA_MARKER_493",
              parameters: {
                type: "object",
                properties: { reference: { type: "string" } },
                required: ["reference"],
              },
            }),
          ],
        },
      ])
    );
    expect(JSON.stringify(requests[2].input)).not.toContain(
      '"type":"tool_search_output"'
    );
  });
});
