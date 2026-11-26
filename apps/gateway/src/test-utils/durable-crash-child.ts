import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { writeTestV3Config } from "./v3-config.js";

const home = process.env.YOPLAI_HOME;
const [, , phase, auth, activeAgent] = process.argv;
if (!home || !["stream", "tool", "stop", "tool-pair", "resume", "settled"].includes(phase)) {
  throw new Error("Set YOPLAI_HOME and pass a Durable crash fixture phase.");
}
const multiUser = auth === "multi-user";
await writeTestV3Config(home, {
  agents: [
    {
      id: "pilot",
      model: { provider: "faux", model: "fixture" },
      extraYaml: "toolDeferral: { enabled: false }\nretryMaxAttempts: 2\nretryBaseDelay: 0.01",
    },
    { id: "spare", model: { provider: "faux", model: "fixture" } },
  ],
  extensions: multiUser ? {
    multiUser: {
      enabled: true, autoApprove: true, emailAndPassword: { enabled: true },
      sessionSecret: "fixture-session-secret-for-durable-crashes",
    },
  } : undefined,
});

const counter = path.join(home, "tool-executions.txt");
const toolReady = path.join(home, "tool-ready.txt");
const extension = defineExtension({
  name: "durable-crash-fixture",
  tools: [defineTool({
    name: "record_seedlings",
    description: "Record the seedlings in a bed.",
    parameters: { type: "object", properties: { bed: { type: "string" } }, required: ["bed"] },
    async execute(_args, api, context) {
      if (phase === "stop") {
        context.abortSignal?.addEventListener("abort", () => {
          void fs.writeFile(path.join(home, "abort-ready.txt"), "ready");
        }, { once: true });
      }
      await fs.appendFile(counter, "Recorded seedlings.\n");
      api.output("Partial receipt: basil seedlings.\n");
      // Durable defers output commits up to 1000 ms. Signal the parent after that window.
      await setTimeout(1500);
      await fs.writeFile(toolReady, "ready");
      return new Promise<never>(() => {});
    },
  })],
});

const { loadConfig, setSingleAgentMode } = await import("../config/index.js");
const { getExtensionRuntime } = await import("../extensions/registry.js");
const { createDurableFaux } = await import("../durable/faux.js");
const { startServer } = await import("../server/index.js");
setSingleAgentMode(activeAgent ?? null);
const requests = path.join(home, "model-" + phase + ".jsonl");
const faux = createDurableFaux(phase === "stream" ? 20 : undefined, undefined, (request) =>
  fs.appendFile(requests, JSON.stringify(request.messages) + "\n"));
if (phase === "stream") {
  faux.script("An unfinished orchard report. " + "Still counting the fruit. ".repeat(40));
} else if (phase === "tool-pair") {
  faux.script([
    "Recording two beds.",
    { tool: "record_seedlings", args: { bed: "basil" }, id: "basil-record" },
    { tool: "record_seedlings", args: { bed: "mint" }, id: "mint-record" },
  ]);
} else if (phase === "tool" || phase === "stop") {
  faux.script({ tool: "record_seedlings", args: { bed: "basil" }, id: "basil-record" });
} else {
  faux.script("The greenhouse is accounted for.", "The fork reviewed both receipts.");
}

const runtime = getExtensionRuntime();
if (multiUser) {
  const { multiUserExtension } = await import("@yoplai/extension-multi-user");
  const { createExtensionContext } = await import("../extensions/context.js");
  const { api } = await import("../server/api.core.js");
  runtime.load([multiUserExtension]);
  multiUserExtension.registerRoutes(api);
  await multiUserExtension.start(createExtensionContext(loadConfig()));
} else {
  runtime.load([]);
}

const server = startServer(0, "127.0.0.1", runtime, { createModels: faux.createModels, fixture: { extension } });
if (!server.listening) await once(server, "listening");
process.send?.((server.address() as AddressInfo).port);
