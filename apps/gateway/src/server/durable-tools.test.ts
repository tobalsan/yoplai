import fs from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionAgentTool } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

function fixtureExtension(id: string, ...tools: ExtensionAgentTool[]): Extension {
  return {
    id, displayName: id, description: "Fixture tools", dependencies: [], routePrefixes: [],
    configSchema: z.object({}), validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
    getAgentTools: () => tools,
  };
}

it("runs extension tools and shows their results in Durable Main history", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\ntoolDeferral: { enabled: false }",
    fixtureExtensions: [fixtureExtension("greenhouse", {
      name: "count_seedlings", description: "Count the seedlings.",
      parameters: { type: "object", properties: {} },
      async execute() { return { count: 7 }; },
    })],
  });
  try {
    gateway.script({ tool: "count_seedlings" }, "Seven seedlings.");
    const response = await gateway.send("local", "Count the seedlings.", { clientSendId: "seedlings" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payloads: [{ text: "Seven seedlings." }] });
    expect((await gateway.history("local", "?view=full")).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ type: "toolCall", name: "count_seedlings" })] }),
      expect.objectContaining({ role: "toolResult", toolName: "count_seedlings", isError: false, content: [{ type: "text", text: '{"count":7}' }] }),
    ]));
  } finally {
    await gateway.close();
  }
});

it("runs workspace tools without inheriting a legacy run's proxy settings", async () => {
  const gateway = await startDurableTestGateway();
  try {
    vi.stubEnv("HTTP_PROXY", "http://foreign.test:8000");
    vi.stubEnv("HTTPS_PROXY", "http://foreign.test:8000");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/foreign/node.pem");
    vi.stubEnv("SSL_CERT_FILE", "/foreign/ssl.pem");
    vi.stubEnv("REQUESTS_CA_BUNDLE", "/foreign/requests.pem");
    gateway.script(
      { tool: "write", args: { path: "seedlings.txt", content: "six seedlings\n" } },
      { tool: "edit", args: { path: "seedlings.txt", edits: [{ oldText: "six", newText: "seven" }] } },
      { tool: "read", args: { path: "seedlings.txt" } },
      { tool: "bash", args: { command: 'cat seedlings.txt && printf "proxies=%s\\n" "${HTTP_PROXY-}${HTTPS_PROXY-}${NODE_EXTRA_CA_CERTS-}${SSL_CERT_FILE-}${REQUESTS_CA_BUNDLE-}"' } },
      "Workspace checked.",
    );
    const response = await gateway.send("local", "Edit the greenhouse inventory.", { clientSendId: "workspace" });
    expect(response.status).toBe(200);
    const { messages } = await gateway.history("local", "?view=full");
    const results = messages.filter((message: { role: string }) => message.role === "toolResult");
    expect(results).toMatchObject([
      { toolName: "write", isError: false },
      { toolName: "edit", isError: false },
      { toolName: "read", isError: false, content: [{ type: "text", text: expect.stringContaining("seven seedlings") }] },
      { toolName: "bash", isError: false, content: [{ type: "text", text: expect.stringContaining("seven seedlings\nproxies=\n") }] },
    ]);
    expect(process.env.HTTP_PROXY).toBe("http://foreign.test:8000");
  } finally {
    await gateway.close();
  }
});

it("keeps the model and tool catalog for a running turn while blocking revoked calls", async () => {
  const barrier = latch();
  const release = latch();
  let calls = 0;
  const gateway = await startDurableTestGateway({
    fixtureExtensions: [fixtureExtension("greenhouse", {
      name: "record_seedlings", description: "Record seedlings.",
      parameters: { type: "object", properties: {} },
      async execute() { calls++; return "Recorded."; },
    }), fixtureExtension("pause", {
      name: "await_check", description: "Wait for the check.",
      parameters: { type: "object", properties: {} },
      async execute() {
        barrier.resolve();
        await release.promise;
        return "Ready.";
      },
    })],
  });
  try {
    await gateway.configure("fixture", "durable: true\ntoolDeferral: { enabled: false }");
    gateway.script({ tool: "await_check" }, { tool: "record_seedlings" }, (model) => model, (model) => model);
    const first = gateway.send("local", "Record the greenhouse inventory.", { clientSendId: "before-change" });
    await barrier.promise;
    await gateway.configure("fixture-alternate", "durable: true\ntoolDeferral: { enabled: false }\nextensions: { greenhouse: { enabled: false } }");
    const observer = await gateway.subscribe("local");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    observer.events.length = 0;
    const steer = await gateway.send("local", "Include the nursery.", { clientSendId: "steer-change" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    release.resolve();
    expect(await (await first).json()).toMatchObject({ payloads: [{ text: "fixture" }] });
    await vi.waitFor(() => expect(steer.events).toContainEqual(expect.objectContaining({ type: "done" })));
    expect(calls).toBe(0);
    const { messages } = await gateway.history("local", "?view=full");
    expect(messages).toContainEqual(expect.objectContaining({ toolName: "record_seedlings", isError: true }));
    expect(gateway.offeredTools(1)).toContain("record_seedlings");
    const next = await gateway.send("local", "Check again.", { clientSendId: "after-change" });
    expect(await next.json()).toMatchObject({ payloads: [{ text: "fixture-alternate" }] });
    expect(gateway.offeredTools(-1)).not.toContain("record_seedlings");
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("isolates concurrent direct and Code Mode calls to each Main owner's credentials and files", async () => {
  const resources = new Map<string, { token: string; label: string }>();
  const arrived: Array<{ label: string; actor: string | undefined; owner: string | null | undefined; folder: string }> = [];
  const release = latch();
  const extension = fixtureExtension("greenhouse");
  extension.requiredSecrets = ["apiToken"];
  extension.getAgentTools = (_agent, context) => {
    const token = (context?.config.extensions?.greenhouse as { apiToken?: string } | undefined)?.apiToken;
    return [{
      name: "greenhouse_resource", description: "Read the caller's greenhouse report.",
      parameters: { type: "object", properties: {} },
      async execute(_args, run) {
        const resource = resources.get(run.userId ?? "");
        if (!resource || resource.token !== token || !run.conversationFiles) throw new Error("Wrong resource scope.");
        const folder = run.conversationFiles.hostPath;
        const filename = path.join(folder, "report.txt");
        await fs.writeFile(filename, resource.label);
        arrived.push({ label: resource.label, actor: run.actorUserId, owner: run.sessionOwnerId, folder });
        await release.promise;
        return fs.readFile(filename, "utf8");
      },
    }];
  };
  const gateway = await startDurableTestGateway({
    multiUser: true,
    extraYaml: "durable: true\ncodemode: true\ntoolDeferral: { enabled: false }\nextensions: { greenhouse: { enabled: true } }",
    fixtureExtensions: [extension],
  });
  try {
    for (const [user, label] of [["alice", "Alice's basil"], ["bob", "Bob's mint"]] as const) {
      const token = "fixture-token-" + user;
      resources.set(gateway.accountId(user), { token, label });
      await gateway.seedPersonalToken(user, "greenhouse", token);
    }
    gateway.script(
      { tool: "greenhouse_resource" },
      { tool: "codemode", args: { code: "console.log(await tools.greenhouse_resource({}));" } },
      "Report checked.", "Report checked.",
    );
    const alice = gateway.send("alice", "Read my basil report.", { clientSendId: "alice-resource" });
    await vi.waitFor(() => expect(arrived).toHaveLength(1));
    const bob = gateway.send("bob", "Read my mint report.", { clientSendId: "bob-resource" });
    await vi.waitFor(() => expect(arrived).toHaveLength(2));
    expect(arrived).toMatchObject([
      { label: "Alice's basil", actor: gateway.accountId("alice"), owner: gateway.accountId("alice") },
      { label: "Bob's mint", actor: gateway.accountId("bob"), owner: gateway.accountId("bob") },
    ]);
    expect(arrived[0].folder).not.toBe(arrived[1].folder);
    release.resolve();
    const responses = await Promise.all([alice, bob]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const aliceHistory = JSON.stringify(await gateway.history("alice", "?view=full"));
    const bobHistory = JSON.stringify(await gateway.history("bob", "?view=full"));
    expect(aliceHistory).toContain("Alice's basil");
    expect(aliceHistory).not.toContain("Bob's mint");
    expect(bobHistory).toContain("Bob's mint");
    expect(bobHistory).not.toContain("Alice's basil");
    expect(aliceHistory + bobHistory).not.toContain("fixture-token-");
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("assembles the host prompt with owner-specific contributions", async () => {
  const garden = fixtureExtension("greenhouse");
  const prompts = new Map<string, string>();
  garden.getSystemPromptContributions = (_agent, context) => prompts.get(context?.userId ?? "");
  const gateway = await startDurableTestGateway({
    multiUser: true, fixtureExtensions: [garden], extraYaml: "durable: true\nreflect: true\ncodemode: true",
  });
  try {
    prompts.set(gateway.accountId("alice"), "Alice collects basil.");
    prompts.set(gateway.accountId("bob"), "Bob collects mint.");
    gateway.script("Hello Alice.", "Hello Bob.");
    expect((await gateway.send("alice", "Hello.", { clientSendId: "alice-prompt" })).status).toBe(200);
    expect((await gateway.send("bob", "Hello.", { clientSendId: "bob-prompt" })).status).toBe(200);
    expect(gateway.prompt(0)).toContain("You are an AI agent running inside Yoplai");
    expect(gateway.prompt(0)).toContain("Read `USER.md`");
    expect(gateway.prompt(0)).toContain("This appears to be your first launch in this workspace.");
    expect(gateway.prompt(0)).toContain("## Self-improvement");
    expect(gateway.prompt(0)).toContain("use send_file to share the result");
    expect(gateway.prompt(0)).toContain("User messages carry a [from <name> via web] header.");
    expect(gateway.prompt(0)).toContain("Alice collects basil.");
    expect(gateway.prompt(0)).not.toContain("Bob collects mint.");
    expect(gateway.prompt(1)).toContain("Bob collects mint.");
    expect(gateway.prompt(1)).not.toContain("Alice collects basil.");
  } finally {
    await gateway.close();
  }
});

it("finds deferred tools by namespace and keeps a loaded tool across turns", async () => {
  const gateway = await startDurableTestGateway({
    fixtureExtensions: [
      fixtureExtension("greenhouse", {
        name: "list_basil", description: "List basil in the greenhouse.",
        parameters: { type: "object", properties: {} },
        async execute() { return "Basil listed."; },
      }),
      fixtureExtension("nursery", {
        name: "list_mint", description: "List mint in the nursery.",
        parameters: { type: "object", properties: {} },
        async execute() { return "Mint listed."; },
      }),
    ],
  });
  try {
    gateway.script(
      { tool: "list_basil" },
      { tool: "tool_search", args: { query: "greenhouse", limit: 1 } },
      { tool: "list_basil" }, "Inventory ready.",
      "Still ready.",
    );
    expect((await gateway.send("local", "Find our basil.", { clientSendId: "search-tools" })).status).toBe(200);
    expect(gateway.offeredTools(0)).toContain("tool_search");
    expect(gateway.offeredTools(0)).not.toContain("list_basil");
    expect(gateway.offeredTools(2)).toContain("list_basil");
    expect(gateway.offeredTools(2)).not.toContain("list_mint");
    expect(gateway.prompt(0)).toContain("Each line lists the tools of one group.");
    const { messages } = await gateway.history("local", "?view=full");
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "list_basil", isError: true, content: [expect.objectContaining({ text: expect.stringContaining("is not loaded. Call tool_search") })] }),
      expect.objectContaining({ toolName: "list_basil", isError: false, content: [{ type: "text", text: "Basil listed." }] }),
    ]));
    expect((await gateway.send("local", "What can you check now?", { clientSendId: "loaded-tools" })).status).toBe(200);
    expect(gateway.offeredTools(-1)).toContain("list_basil");
  } finally {
    await gateway.close();
  }
});

it("shows a sent file after restart and serves the view record only to its owner", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true });
  try {
    const filename = await gateway.seedConversationFile("alice", "seedlings.txt", "Seven seedlings are ready.\n");
    gateway.script({ tool: "send_file", args: { path: filename, title: "Seedling report" }, id: "send-seedlings" }, "Report sent.");
    expect((await gateway.send("alice", "Send the report.", { clientSendId: "send-report" })).status).toBe(200);
    await gateway.restart();
    const history = await gateway.history("alice", "?view=full");
    const view = {
      server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer",
      recordId: expect.any(String),
    };
    expect(history.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: [expect.objectContaining({ name: "send_file", id: "send-seedlings", view: expect.objectContaining(view) })],
    }));
    expect(history.messages).toContainEqual(expect.objectContaining({
      toolName: "send_file", isError: false, view: expect.objectContaining({ ...view, file: expect.objectContaining({ filename: "seedlings.txt", title: "Seedling report" }) }),
    }));
    const route = "/api/agents/pilot/sessions/durable-main/mcp-apps/send-seedlings/data";
    const data = await gateway.request("alice", route, { method: "POST" });
    expect(data.status).toBe(200);
    const { result: { structuredContent: { fileId } } } = await data.json();
    const file = await gateway.request("alice", "/api/media/download/" + fileId);
    expect(await file.text()).toBe("Seven seedlings are ready.\n");
    expect((await gateway.request("bob", route, { method: "POST" })).status).toBe(404);
  } finally {
    await gateway.close();
  }
});

it("retries a transient model error but never retries or falls back on a refusal", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\nretryMaxAttempts: 2\nretryBaseDelay: 0.01\nfallback_model: { provider: faux, model: fixture-alternate }",
  });
  try {
    gateway.script({ errorMessage: "429 Provider rate limit." }, "Recovered.");
    expect(await (await gateway.send("local", "Check the inventory.", { clientSendId: "retry" })).json()).toMatchObject({
      payloads: [{ text: "Recovered." }],
    });
    expect(gateway.callCount()).toBe(2);
    gateway.script({ errorMessage: "503: The model refused to complete the request." }, "Must not be requested.");
    const response = await gateway.send("local", "Check again.", { clientSendId: "refusal" });
    expect(response.status).toBe(500);
    const { error } = await response.json();
    expect(error).not.toContain("503");
    expect(gateway.callCount()).toBe(3);
    expect((await gateway.history("local")).messages).toContainEqual(expect.objectContaining({ role: "assistant", content: error, meta: { stopReason: "error", failure: { kind: "generic" } } }));
  } finally {
    await gateway.close();
  }
});

it("uses the fallback once after primary retries and returns to the primary on the next turn", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\nretryMaxAttempts: 2\nretryBaseDelay: 0.01\nfallback_model: { provider: faux, model: fixture-alternate }",
  });
  try {
    gateway.script(
      { errorMessage: "503 Model unavailable." }, { errorMessage: "503 Model unavailable." },
      (model) => "Answered by " + model, (model) => "Answered by " + model,
    );
    const options = { clientSendId: "primary-fails" };
    const first = await gateway.send("local", "Check the seedlings.", options);
    expect(await first.json()).toMatchObject({ payloads: [{ text: "Answered by fixture-alternate" }] });
    expect(gateway.callCount()).toBe(3);
    await gateway.restart();
    expect(await (await gateway.send("local", "Check the seedlings.", options)).json()).toMatchObject({
      payloads: [{ text: "Answered by fixture-alternate" }],
    });
    expect(gateway.callCount()).toBe(3);
    expect(await (await gateway.send("local", "Check again.", { clientSendId: "primary-restored" })).json()).toMatchObject({
      payloads: [{ text: "Answered by fixture" }],
    });
    gateway.script(
      { errorMessage: "503 Model unavailable." },
      { errorMessage: "503 Model unavailable.", partial: "The first row" },
      "Must not reach fallback.",
    );
    const partial = await gateway.send("local", "Check the rows.", { clientSendId: "partial-failure" });
    expect(partial.status).toBe(500);
    expect(gateway.callCount()).toBe(6);
  } finally {
    await gateway.close();
  }
});

it("resolves the owned or environment model credential at each provider request", async () => {
  const seen: string[] = [];
  const gateway = await startDurableTestGateway({
    modelFixture: {
      provider: "openai", model: "gpt-4o-mini",
      observeKey(key) {
        seen.push(key === "fixture-owned-key" ? "owned" : key === "fixture-environment-key" ? "environment" : "unexpected");
      },
    },
  });
  try {
    vi.stubEnv("OPENAI_API_KEY", "fixture-environment-key");
    await gateway.seedModelKeys({ openai: "fixture-owned-key" });
    await gateway.configure("gpt-4o-mini", "durable: true", "owned");
    gateway.script("Used the configured model.", "Used the updated source.");
    expect((await gateway.send("local", "Verify model access.", { clientSendId: "owned-source" })).status).toBe(200);
    await gateway.configure("gpt-4o-mini", "durable: true", "environment");
    expect((await gateway.send("local", "Verify again.", { clientSendId: "environment-source" })).status).toBe(200);
    expect(seen).toEqual(["owned", "environment"]);
  } finally {
    await gateway.close();
  }
});

it("applies OneCLI settings to a bash child without mutating the gateway environment", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\nonecliToken: fixture-proxy-key\ntoolDeferral: { enabled: false }",
    extraConfig: { onecli: { enabled: true, gatewayUrl: "http://proxy.example.test:8080" } },
    fixtureExtensions: [fixtureExtension("greenhouse", {
      name: "check_process", description: "Check isolation of the fixture proxy.",
      parameters: { type: "object" },
      async execute(_args, { env }) {
        return process.env.HTTP_PROXY === undefined && env?.HTTP_PROXY === undefined ? "Process isolated." : "Unexpected proxy.";
      },
    })],
  });
  try {
    vi.stubEnv("HTTP_PROXY", undefined);
    vi.stubEnv("HTTPS_PROXY", undefined);
    gateway.script(
      { tool: "check_process" },
      { tool: "bash", args: { command: 'case "$HTTP_PROXY" in http://onecli:*@proxy.example.test:8080) test "$HTTP_PROXY" = "$HTTPS_PROXY" && echo "Child configured.";; esac' } },
      "Proxy checked.",
    );
    expect((await gateway.send("local", "Check the inspection proxy.", { clientSendId: "proxy" })).status).toBe(200);
    const history = JSON.stringify(await gateway.history("local", "?view=full"));
    expect(history).toContain("Process isolated.");
    expect(history).toContain("Child configured.");
    expect(history).not.toContain("fixture-proxy-key");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  } finally {
    await gateway.close();
  }
});

it("shows an MCP App view and hides task bookkeeping in Main history", async () => {
  let bookkeepingCalls = 0;
  const uri = "ui://fixture/seedlings.html";
  const app = fixtureExtension("mcp", {
    name: "mcp__greenhouse__open_inventory", description: "Open the seedling inventory.",
    parameters: { type: "object" },
    mcp: { server: "greenhouse", tool: "open_inventory", ui: { resourceUri: uri, visibility: ["model", "app"] } },
    async execute() { return { content: [{ type: "text", text: "Inventory is ready." }] }; },
  });
  app.mcpApps = {
    async readResource(_context, server, resource) {
      expect([server, resource]).toEqual(["greenhouse", uri]);
      return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<h1>Seedling inventory</h1>" }] };
    },
    async callTool() { throw new Error("Unexpected app tool call."); },
  };
  const gateway = await startDurableTestGateway({
    multiUser: true, appViews: true, extraYaml: "durable: true\ntoolDeferral: { enabled: false }",
    fixtureExtensions: [app, fixtureExtension("taskLifecycle", {
      name: "note_seedlings", description: "Record the inspection.",
      parameters: { type: "object" },
      async execute() { bookkeepingCalls++; return "Recorded privately."; },
    })],
  });
  try {
    gateway.script({ tool: "note_seedlings" }, { tool: "mcp__greenhouse__open_inventory", id: "open-inventory" }, "Open the inventory.");
    expect((await gateway.send("alice", "Show the inventory.", { clientSendId: "show-inventory" })).status).toBe(200);
    const history = await gateway.history("alice", "?view=full");
    const view = expect.objectContaining({ server: "greenhouse", tool: "open_inventory", resourceUri: uri });
    expect(history.messages).toContainEqual(expect.objectContaining({ toolCallId: "open-inventory", view }));
    expect(JSON.stringify(history)).not.toContain("note_seedlings");
    expect(JSON.stringify(history)).not.toContain("Recorded privately.");
    expect(bookkeepingCalls).toBe(1);
    const route = "/api/agents/pilot/sessions/durable-main/mcp-apps/open-inventory/view";
    const init = { method: "POST", headers: { Origin: "http://localhost:3000" } };
    const opened = await gateway.request("alice", route, init);
    expect(opened.status).toBe(200);
    const viewResponse = await opened.json();
    expect(viewResponse).toMatchObject({ available: true, sandboxUrl: expect.stringContaining("/sandbox/") });
    const sandbox = await fetch(viewResponse.sandboxUrl);
    expect(sandbox.status).toBe(200);
    const content = await fetch(viewResponse.sandboxUrl.replace("/sandbox/", "/content/"));
    expect(await content.text()).toBe("<h1>Seedling inventory</h1>");
    expect((await gateway.request("bob", route, init)).status).toBe(404);
  } finally {
    await gateway.close();
  }
});

it("honors an explicit Code Mode script timeout and lets a script without options finish", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\ncodemode: true",
    fixtureExtensions: [fixtureExtension("greenhouse", {
      name: "wait_for_seedlings", description: "Wait briefly and check the seedlings.",
      parameters: { type: "object" },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "Seedlings ready.";
      },
    })],
  });
  try {
    const code = "console.log(await tools.wait_for_seedlings({}));";
    gateway.script(
      { tool: "codemode", args: { code: '// @options: {"timeout_ms": 25}\n' + code } },
      { tool: "codemode", args: { code } },
      "The second check finished.",
    );
    expect((await gateway.send("local", "Check the timeout and retry.", { clientSendId: "script-timeout" })).status).toBe(200);
    const { messages } = await gateway.history("local", "?view=full");
    const results = messages.filter((message: { toolName?: string }) => message.toolName === "codemode");
    expect(results).toMatchObject([{ isError: true }, { isError: false }]);
    expect(JSON.stringify(results[0])).toMatch(/timed out|timeout/i);
    expect(JSON.stringify(results[1])).toContain("Seedlings ready.");
  } finally {
    await gateway.close();
  }
});

it("blocks nested, built-in, and core tool calls when the owner loses access mid-turn", async () => {
  const entered = latch();
  const release = latch();
  let calls = 0;
  const gateway = await startDurableTestGateway({
    multiUser: true,
    extraYaml: "durable: true\ncodemode: true\ntoolDeferral: { enabled: false }",
    fixtureExtensions: [fixtureExtension("greenhouse",
      { name: "hold_check", description: "Wait for the inspection.", parameters: { type: "object" },
        async execute() { entered.resolve(); await release.promise; return "Inspection resumed."; } },
      { name: "record_check", description: "Record the inspection.", parameters: { type: "object" },
        async execute() { calls++; return "Inspection recorded."; } },
    )],
  });
  try {
    const filename = await gateway.seedConversationFile("bob", "private-report.txt", "Fixture report.\n");
    gateway.script(
      { tool: "codemode", args: { code: "await tools.hold_check({}); await tools.record_check({});" } },
      { tool: "send_file", args: { path: filename }, id: "revoked-file" },
      { tool: "write", args: { path: "revoked.txt", content: "Unexpected write." } },
      "Inspection finished.",
    );
    const response = gateway.send("bob", "Run the inspection.", { clientSendId: "revoked" });
    const admin = (approved: boolean) => gateway.request("alice", "/api/admin/users/" + gateway.accountId("bob"), {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved }),
    });
    await entered.promise;
    expect((await admin(false)).status).toBe(200);
    release.resolve();
    expect((await response).status).toBe(200);
    expect(calls).toBe(0);
    expect((await admin(true)).status).toBe(200);
    const { messages } = await gateway.history("bob", "?view=full");
    for (const toolName of ["codemode", "send_file", "write"]) {
      expect(messages).toContainEqual(expect.objectContaining({ toolName, isError: true }));
    }
    expect((await gateway.request("bob", "/api/agents/pilot/sessions/durable-main/mcp-apps/revoked-file/data", { method: "POST" })).status).toBe(404);
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("runs the default model and logs ignored session routing once", async () => {
  const gateway = await startDurableTestGateway({ extraYaml: "durable: true\nmodelRouting: { enabled: true }" });
  const warnings = vi.spyOn(console, "warn");
  try {
    gateway.script((model) => model, (model) => model);
    for (const clientSendId of ["routing-1", "routing-2"]) {
      const response = await gateway.send("local", "Which model is answering?", { clientSendId });
      expect(await response.json()).toMatchObject({ payloads: [{ text: "fixture" }] });
    }
    expect(warnings.mock.calls.filter(([line]) => String(line).includes("modelRouting is ignored for Durable agents"))).toHaveLength(1);
  } finally {
    warnings.mockRestore();
    await gateway.close();
  }
});

it("does not fall back again when a concurrent steer joins a failing fallback", async () => {
  const entered = latch();
  const release = latch();
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\nretryMaxAttempts: 2\nretryBaseDelay: 0.01\ntoolDeferral: { enabled: false }\nfallback_model: { provider: faux, model: fixture-alternate }",
    fixtureExtensions: [fixtureExtension("greenhouse", {
      name: "wait_for_inspection", description: "Wait for the fixture to report.",
      parameters: { type: "object" },
      async execute() { entered.resolve(); await release.promise; return "Ready."; },
    })],
  });
  try {
    gateway.script(
      { errorMessage: "503 Primary model unavailable." },
      { errorMessage: "503 Primary model unavailable." },
      { tool: "wait_for_inspection" },
      { errorMessage: "503 Fallback model unavailable." },
      "Must not be requested.",
    );
    const first = gateway.send("local", "Inspect the greenhouse.", { clientSendId: "fallback-with-steer" });
    await vi.waitFor(() => expect(gateway.callCount()).toBe(3));
    await entered.promise;
    const observer = await gateway.subscribe("local");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    observer.events.length = 0;
    const steer = await gateway.send("local", "Include the nursery.", { clientSendId: "fallback-correction" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    release.resolve();
    expect((await first).status).toBe(500);
    await vi.waitFor(() => expect(steer.events).toContainEqual(expect.objectContaining({ type: "error" })));
    expect(gateway.callCount()).toBe(4);
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("refreshes the model when a final-response steer starts a separate run", async () => {
  const entered = latch();
  const release = latch();
  const gateway = await startDurableTestGateway();
  try {
    gateway.script(async (model) => {
      entered.resolve();
      await release.promise;
      return model;
    }, (model) => model);
    const first = gateway.send("local", "Check this bed.", { clientSendId: "first-bed" });
    await vi.waitFor(() => expect(gateway.callCount()).toBe(1));
    await entered.promise;
    const observer = await gateway.subscribe("local");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    observer.events.length = 0;
    await gateway.configure("fixture-alternate");
    const steer = await gateway.send("local", "Check another bed.", { clientSendId: "another-bed" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn" })));
    release.resolve();
    expect(await (await first).json()).toMatchObject({ payloads: [{ text: "fixture" }] });
    await vi.waitFor(() => expect(steer.events).toContainEqual(expect.objectContaining({ type: "text", data: "fixture-alternate" })));
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("keeps active bookkeeping hidden and projects completed file calls behind a reply reviewer", async () => {
  const entered = latch();
  const release = latch();
  const { humanChatExtension } = await import("@yoplai/extension-human-chat");
  const gateway = await startDurableTestGateway({
    extraYaml: "durable: true\nextensions: { human-chat: { enabled: true } }",
    fixtureExtensions: [
      humanChatExtension,
      fixtureExtension("taskLifecycle", {
        name: "hold_bookkeeping", description: "Record the inspection privately.",
        parameters: { type: "object" },
        async execute() { entered.resolve(); await release.promise; return "Private record."; },
      }),
    ],
  });
  try {
    const filename = await gateway.seedConversationFile("local", "reviewed.txt", "Reviewed inspection report.\n");
    const reply = ["First.", "Second.", "Third.", "Fourth.", "Fifth.", "Sixth.", "Seventh.", "Eighth."].join("\n");
    gateway.script(
      { tool: "hold_bookkeeping" },
      { tool: "reply_mode", args: { mode: "long", type: "steps", note: "include eight inspection steps" } },
      { tool: "send_file", args: { path: filename }, id: "reviewed-report" },
      reply, "Unexpected rewrite.",
    );
    const response = gateway.send("local", "Report the inspection steps.", { clientSendId: "reviewed-report" });
    await vi.waitFor(() => expect(gateway.callCount()).toBe(1));
    await entered.promise;
    expect(JSON.stringify(await gateway.history("local", "?view=full"))).not.toContain("hold_bookkeeping");
    release.resolve();
    expect(await (await response).json()).toMatchObject({ payloads: [{ text: reply }] });
    expect(gateway.callCount()).toBe(4);
    const { messages } = await gateway.history("local", "?view=full");
    expect(messages).toContainEqual(expect.objectContaining({
      toolCallId: "reviewed-report", view: expect.objectContaining({ file: expect.objectContaining({ filename: "reviewed.txt" }) }),
    }));
    expect(JSON.stringify(messages)).not.toContain("hold_bookkeeping");
  } finally {
    release.resolve();
    await gateway.close();
  }
});
