import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, defineExtension, hook, ToolTask, type ConversationId, type HookApi, type Registry, type TaskId, type ToolNamespace } from "@earendil-works/pi-durable";
import { renderToolSignature } from "@earendil-works/pi-codemode";
import { createToolDeferralCatalog } from "@yoplai/shared/tool-deferral";
import type { ExtensionAgentTool, McpAppViewReference } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { durableModeFor } from "../durable-mode/resolve.js";
import { requireActorExecution, type ExtensionRuntime } from "../extensions/runtime.js";
import { executeExtensionAgentTool, getExtensionAgentTools } from "../extensions/tools.js";
import { getMcpAppView } from "../mcp-apps/capture.js";
import { durableCoreTools, executeDurableCoreTool } from "./core-tools.js";
import { durableExtensionEnv } from "./env.js";
import { mainPrincipal } from "./principal.js";
import { claimToolDescriptor, defineGatewayTool } from "./tool-definition.js";

export class DurableAccessDenied extends Error {
  constructor() { super("Agent access denied"); }
}

export function createDurableTools(
  agentId: string,
  runtime: ExtensionRuntime,
  registry: Registry,
  ownerOf: (id: ConversationId) => string | undefined,
  sessionRef: (id: ConversationId) => string,
  isBackground: (id: ConversationId) => boolean,
  onInterrupted: () => void,
  sessionHistory: (id: ConversationId, args: unknown) => Promise<unknown>,
) {
  async function authority(id: ConversationId) {
    const owner = ownerOf(id);
    const agent = getAgent(agentId);
    if (owner === undefined || !agent || !await durableModeFor(owner === "local" ? undefined : owner, agent)) {
      throw new DurableAccessDenied();
    }
    const config = loadConfig();
    const principal = { ...mainPrincipal(agentId, owner, config, isBackground(id)), sessionId: sessionRef(id) };
    if (principal.background) {
      await requireActorExecution(agentId, config, principal.userId, principal).catch(() => { throw new DurableAccessDenied(); });
    }
    return { agent, config, principal };
  }

  async function describe(id: ConversationId) {
    const { agent, config, principal } = await authority(id);
    const descriptors = await getExtensionAgentTools(agent, config, runtime, principal.userId, { ...principal, env: durableExtensionEnv(agent, config) });
    const names = new Set(["read", "write", "edit", "bash", "tool_search", "codemode", "topics_get", "plan_get", "plan_update"]);
    const all: Array<Omit<ExtensionAgentTool, "execute"> & { extensionId: string; extensionDescription?: string; kind: "extension" | "core" }> = [
      ...descriptors.filter(({ extensionId }) => runtime.isEnabled(extensionId, config) && agent.extensions?.[extensionId]?.enabled !== false)
        .map((tool) => ({ ...tool, kind: "extension" as const })),
      ...durableCoreTools(config).map((tool) => ({ ...tool, kind: "core" as const, extensionId: "core", core: true })),
    ];
    return all.map(({ name, description, parameters, outputSchema, extensionId, kind, core, namespace, extensionDescription }) => claimToolDescriptor(
      { name, description, parameters, outputSchema, extensionId, kind, core, namespace, extensionDescription }, names,
    ));
  }

  type Descriptor = Awaited<ReturnType<typeof describe>>[number];
  type Registered = Descriptor & { deferred: boolean };
  const registered = new Map<string, Registered[]>();

  async function extensions(id: ConversationId) {
    const { agent } = await authority(id);
    const descriptors = await describe(id);
    const catalog = createToolDeferralCatalog(descriptors, agent.toolDeferral, { codemode: agent.codemode });
    const groups = new Map<string, { namespace: ToolNamespace; tools: Registered[] }>();
    for (const tool of descriptors) {
      const meta = catalog.tools.get(tool.name);
      const key = meta?.namespace?.name ?? tool.extensionId;
      const group = groups.get(key) ?? {
        namespace: { name: key, description: meta?.namespace?.description ?? tool.extensionDescription ?? "", instructions: meta?.namespace?.instructions },
        tools: [],
      };
      group.tools.push({ ...tool, deferred: meta?.exposure === "deferred" });
      groups.set(key, group);
    }
    const installed = [...groups.values()].map(({ namespace, tools: descriptors }) => {
      // A change to a descriptor must leave other conversations' selections intact.
      const name = "yoplai-tools-" + createHash("sha256").update(JSON.stringify({ namespace, descriptors })).digest("hex");
      const existing = registry.snapshot().extension(name);
      if (existing) return existing;
      const extension = defineExtension({
        name,
        namespace,
        tools: descriptors.map((tool) => defineGatewayTool(tool, async (args, api, context) => {
          const { agent, config, principal } = await authority(api.conversationId);
          const { kind, canonicalName, extensionId } = tool;
          if (kind === "core") {
            return executeDurableCoreTool(canonicalName, args, config, principal, agent.id, api.callId, context.abortSignal);
          }
          if (!runtime.isEnabled(extensionId, config) || agent.extensions?.[extensionId]?.enabled === false) {
            return { isError: true, error: "Tool is no longer available." };
          }
          if (extensionId === "sessionHistory" && canonicalName === "session_history") {
            context.abortSignal?.throwIfAborted();
            return sessionHistory(api.conversationId, args);
          }
          const { found, result } = await executeExtensionAgentTool(
            agent, canonicalName, args, config, runtime, principal.sessionId, principal.userId,
            ({ label }) => api.output(label + "\n"), context.abortSignal,
            { ...principal, env: durableExtensionEnv(agent, config), toolCallId: api.callId },
          );
          return found ? result : { isError: true, error: "Tool is no longer available." };
        })),
      });
      registered.set(name, descriptors);
      registry.install(extension);
      return extension;
    });
    return { installed, summary: catalog.summary };
  }

  async function selectedDescriptors(api: HookApi, context: Context) {
    const selected = (await api.snapshot(AgentDoc, api.conversationId, context))?.extensions;
    return Array.isArray(selected) ? selected.flatMap((name) => registered.get(name) ?? []) : [];
  }

  // Durable keeps nested results out of the transcript. Hold view references
  // for the top-level call until its result can carry them into the transcript.
  const nestedViews = new Map<TaskId, Map<string, { id: string; name: string; view: McpAppViewReference }>>();
  const gate = defineExtension({
    name: "yoplai-tool-permission",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, context) {
        const { agent, config, principal } = await authority(api.conversationId);
        await requireActorExecution(agent.id, config, principal.userId, principal);
        if ((call.name === "codemode" && !agent.codemode) || (call.name === "tool_search" && agent.toolDeferral?.enabled === false)) {
          return { block: "Tool is no longer available." };
        }
        const descriptor = (await selectedDescriptors(api, context)).find(({ name }) => name === call.name);
        if (descriptor) {
          const current = await describe(api.conversationId);
          if (!current.some(({ canonicalName, extensionId, kind }) => canonicalName === descriptor.canonicalName && extensionId === descriptor.extensionId && kind === descriptor.kind)) {
            return { block: "Tool is no longer available." };
          }
        }
        if (call.name === "codemode" && !call.parent && !nestedViews.has(api.taskId)) nestedViews.set(api.taskId, new Map());
      },
      async afterTool(call, result, api, context) {
        if (!call.parent && result.diagnostics?.some(({ code }) => code === "interrupted")) onInterrupted();
        const unloaded = result.diagnostics?.some(({ code }) => code === "tool_unavailable");
        const descriptors = await selectedDescriptors(api, context);
        const descriptor = descriptors.find(({ name }) => name === call.name);
        const owner = ownerOf(api.conversationId);
        const userId = owner === "local" ? undefined : owner;
        const view = descriptor && !result.isError && owner !== undefined && getMcpAppView({ agentId, sessionId: sessionRef(api.conversationId), userId }, call.id);
        const hidden = descriptor?.extensionId === "taskLifecycle";
        if (call.parent && !hidden && view) {
          nestedViews.get(call.parent.taskId)?.set(call.id, { id: call.id, name: call.name, view });
        }
        const nested = nestedViews.get(api.taskId);
        nestedViews.delete(api.taskId);
        const projected = !call.parent && (descriptor || nested?.size) ? {
          ...result,
          details: {
            kind: "yoplai.tool", result: result.details ?? null,
            ...(hidden ? { hidden } : {}),
            ...(view ? { view } : {}),
            ...(nested?.size ? { nested: [...nested.values()] } : {}),
          },
        } : result;
        if (!unloaded && call.name !== "codemode") return projected === result ? undefined : projected;
        const catalog = createToolDeferralCatalog(descriptors.filter(({ deferred }) => deferred));
        const message = {
          role: "toolResult", toolName: call.name, isError: result.isError, details: result.details,
          content: unloaded ? [{ type: "text" as const, text: `Tool ${call.name} not found` }] : result.output,
        };
        const hinted = catalog.hintUnloadedToolResult(message) ?? catalog.hintCodemodeSignatures(message, (name) => {
          const tool = descriptors.find((item) => item.name === name);
          if (tool) return renderToolSignature({ name, inputSchema: tool.parameters, outputSchema: tool.outputSchema });
        });
        if (hinted) return { ...projected, output: hinted.content, diagnostics: result.diagnostics?.filter(({ code }) => code !== "tool_unavailable") };
        return projected === result ? undefined : projected;
      },
    })],
  });

  return {
    authority, extensions, gate,
    invisibleNames(selected: readonly string[]) {
      return new Set(selected.flatMap((name) => registered.get(name) ?? [])
        .filter(({ extensionId }) => extensionId === "taskLifecycle")
        .map(({ name }) => name));
    },
  };
}
