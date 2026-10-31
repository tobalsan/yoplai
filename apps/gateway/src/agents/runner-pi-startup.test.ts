import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { setLoadedConfig } from "../config/index.js";
import { appendSessionMeta } from "../history/store.js";
import { getFullSessionHistory, runAgent } from "./runner.js";

// Thinh approved this public runAgent seam in ALG-492 comment
// 24f27d0d-40e5-4a3b-a213-982f338db4a9 ("Seams approved.").
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".pi-startup-test-"));
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  const hooks: Partial<Record<"beforeCreate" | "beforePrompt" | "duringStartup", () => Promise<void>>> = {};
  return {
    home,
    previousHome,
    faux: fauxProvider({ provider: "startup-test" }),
    hooks,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    ModelRuntime: {
      create: async (...args: Parameters<typeof sdk.ModelRuntime.create>) => {
        const runtime = await sdk.ModelRuntime.create(...args);
        runtime.registerNativeProvider({
          ...setup.faux.provider,
          auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
        });
        return runtime;
      },
    },
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) {
        super({
          ...options,
          extensionFactories: [
            ...(options?.extensionFactories ?? []),
            (pi) => {
              pi.on("before_agent_start", async () => {
                await setup.hooks.duringStartup?.();
              });
            },
          ],
        });
      }
    },
    createAgentSession: async (...args: Parameters<typeof sdk.createAgentSession>) => {
      await setup.hooks.beforeCreate?.();
      return sdk.createAgentSession(...args);
    },
  };
});

vi.mock("../sdk/attachments.js", async (importOriginal) => {
  const attachments = await importOriginal<typeof import("../sdk/attachments.js")>();
  return {
    ...attachments,
    buildDocumentAttachmentContext: async (
      ...args: Parameters<typeof attachments.buildDocumentAttachmentContext>
    ) => {
      await setup.hooks.beforePrompt?.();
      return attachments.buildDocumentAttachmentContext(...args);
    },
  };
});

function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Host run did not settle within 3 seconds")), 3_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const agent = AgentConfigSchema.parse({
  id: "startup",
  name: "Startup",
  workspace: path.join(setup.home, "workspace"),
  sdk: "pi",
  model: { provider: "startup-test", model: setup.faux.getModel().id },
  retryMaxAttempts: 1,
  retryBaseDelay: 0.001,
});
let sessionNumber = 0;
let sessionId: string;
let recovered = false;

beforeEach(async () => {
  setup.hooks.beforeCreate = undefined;
  setup.hooks.beforePrompt = undefined;
  setup.hooks.duringStartup = undefined;
  sessionId = `startup-${++sessionNumber}`;
  recovered = false;
  await fs.mkdir(agent.workspace, { recursive: true });
  for (const name of ["AGENTS.md", "USER.md"]) {
    await fs.writeFile(path.join(agent.workspace, name), "Startup test workspace.");
  }
  setLoadedConfig(GatewayConfigSchema.parse({ agents: [agent], extensions: {} }));
  await appendSessionMeta(agent.id, sessionId, "title", "Startup test");
  const reply: FauxResponseFactory = (context) =>
    fauxAssistantMessage(context.messages.filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : message.content
        .filter((part) => part.type === "text").map((part) => part.text).join(""))
      .join("|"));
  setup.faux.setResponses(Array.from({ length: 5 }, () => reply));
});

// Every startup scenario must reach its phase and recover on the same session.
afterEach(() => {
  expect(recovered, "the startup phase and a later run must complete").toBe(true);
});

afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

function send(message: string) {
  return runAgent({ agentId: agent.id, sessionId, message });
}

type Phase = keyof typeof setup.hooks;

async function deliveryAt(phase: Phase) {
  const gate = barrier();
  setup.hooks[phase] = gate.wait;
  const first = send("first");
  try {
    await bounded(gate.entered);
    await expect(bounded(send("second"))).resolves.toMatchObject({ meta: { queued: true } });
  } finally {
    setup.hooks[phase] = undefined;
    gate.release();
  }
  const firstResult = await bounded(first);
  const laterResult = await bounded(send("later"));
  const history = await bounded(getFullSessionHistory(agent.id, sessionId));
  expect(laterResult.meta.aborted).toBe(false);
  expect(laterResult.payloads).toEqual([{ text: expect.stringContaining("later") }]);
  recovered = true;
  return { firstResult, laterResult, history };
}

function expectOrderedDelivery({ firstResult, laterResult, history }: Awaited<ReturnType<typeof deliveryAt>>) {
  expect(firstResult).toMatchObject({ payloads: [{ text: "first|second" }] });
  expect(laterResult).toMatchObject({ payloads: [{ text: "first|second|later" }] });
  expect(history.filter((message) => message.role === "user").map((message) => message.content))
    .toEqual(["first", "second", "later"].map((text) => [{ type: "text", text }]));
}

async function abortAt(phase: Phase) {
  const gate = barrier();
  setup.hooks[phase] = gate.wait;
  const callsBefore = setup.faux.state.callCount;
  const first = send("first").then((result) => ({ result }), (error: unknown) => ({ error }));
  let stop: ReturnType<typeof send> | undefined;
  try {
    await bounded(gate.entered);
    stop = send("/abort");
  } finally {
    setup.hooks[phase] = undefined;
    gate.release();
  }
  const outcome = await bounded(first);
  if (!stop) throw new Error("Abort command was not sent");
  const stopped = await bounded(stop);
  const modelCalls = setup.faux.state.callCount - callsBefore;
  const laterResult = await bounded(send("later"));
  expect(stopped.meta.aborted).toBe(true);
  expect(laterResult.meta.aborted).toBe(false);
  expect(laterResult.payloads).toEqual([{ text: expect.stringContaining("later") }]);
  recovered = true;
  return { ...outcome, modelCalls };
}

describe("Pi host startup", () => {
  it("delivers a message queued before session creation after the original exactly once", async () => {
    expectOrderedDelivery(await deliveryAt("beforeCreate"));
  });

  it("delivers a message queued while preparing the original prompt exactly once", async () => {
    expectOrderedDelivery(await deliveryAt("beforePrompt"));
  });

  it("delivers a message queued during Pi startup after the original exactly once", async () => {
    expectOrderedDelivery(await deliveryAt("duringStartup"));
  });

  it("honors an abort before session creation and accepts a later run", async () => {
    expect(await abortAt("beforeCreate")).toMatchObject({ result: { payloads: [], meta: { aborted: true } }, modelCalls: 0 });
  });

  it("honors an abort while preparing the original prompt and accepts a later run", async () => {
    expect(await abortAt("beforePrompt")).toMatchObject({ result: { payloads: [], meta: { aborted: true } }, modelCalls: 0 });
  });

  it("honors an abort during Pi startup and accepts a later run", async () => {
    expect(await abortAt("duringStartup")).toMatchObject({ result: { payloads: [], meta: { aborted: true } } });
  });

  it("preserves an abort-like provider error when no abort was requested", async () => {
    setup.faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "This operation was aborted" }),
      fauxAssistantMessage("later"),
    ]);
    const outcome = await bounded(send("first"))
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    const laterResult = await bounded(send("later"));
    expect(laterResult).toMatchObject({ payloads: [{ text: "later" }], meta: { aborted: false } });
    recovered = true;
    expect(outcome).toMatchObject({ error: expect.objectContaining({ message: "Agent error: This operation was aborted" }) });
  });
});
