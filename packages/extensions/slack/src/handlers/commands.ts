import type {
  AgentConfig,
  SlackComponentChannelConfig,
  SlackComponentConfig,
} from "@yoplai/shared";
import { DEFAULT_MAIN_KEY } from "@yoplai/shared";
import { getSlackContext } from "../context.js";
import { buildSlackSessionKey } from "../utils/threads.js";

export type SlackCommandData = {
  channel_id: string;
  user_id: string;
  text?: string;
};

export type SlackCommandTarget = {
  agent: AgentConfig;
  config: SlackComponentConfig;
  channelConfig?: SlackComponentChannelConfig;
  isDm: boolean;
};

export type SlackRespond = (
  message: string | { text: string; response_type?: "ephemeral" | "in_channel" }
) => Promise<unknown>;

// NOTE: Slack slash commands do not include thread_ts in their payload, so /new
// and /stop default to the channel-scoped session. Use !new / !stop from inside
// a thread to target the per-thread session.
function defaultSessionKey(target: SlackCommandTarget, command: SlackCommandData): string {
  return target.isDm ? DEFAULT_MAIN_KEY : buildSlackSessionKey(command.channel_id);
}

function commandSessionKey(
  target: SlackCommandTarget,
  command: SlackCommandData
): string {
  const requested = command.text?.trim();
  return requested || defaultSessionKey(target, command);
}

async function runControlCommand(
  command: SlackCommandData,
  target: SlackCommandTarget,
  respond: SlackRespond,
  message: "/new" | "/stop",
  fallback: string
): Promise<void> {
  try {
    const result = await getSlackContext().runAgent({
      agentId: target.agent.id,
      message,
      sessionKey: commandSessionKey(target, command),
      source: "slack",
    });
    await respond({
      text: result.payloads[0]?.text ?? fallback,
      response_type: "ephemeral",
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : "Unknown error";
    await respond({ text: `Error: ${text}`, response_type: "ephemeral" });
  }
}

async function clearSlackSession(
  command: SlackCommandData,
  target: SlackCommandTarget
): Promise<void> {
  const ctx = getSlackContext();
  const sessionKey = commandSessionKey(target, command);
  const cleared = await ctx.clearSessionEntry(target.agent.id, sessionKey);
  if (!cleared) return;
  ctx.deleteSession(target.agent.id, cleared.sessionId);
  await ctx.invalidateHistoryCache(target.agent.id, cleared.sessionId);
}

export async function handleNewCommand(
  command: SlackCommandData,
  target: SlackCommandTarget,
  respond: SlackRespond
): Promise<void> {
  try {
    await clearSlackSession(command, target);
  } catch (err) {
    const text = err instanceof Error ? err.message : "Unknown error";
    await respond({ text: `Error: ${text}`, response_type: "ephemeral" });
    return;
  }
  await respond({
    text: "Context cleared, new session started.",
    response_type: "ephemeral",
  });
}

export function handleAbortCommand(
  command: SlackCommandData,
  target: SlackCommandTarget,
  respond: SlackRespond
): Promise<void> {
  return runControlCommand(
    command,
    target,
    respond,
    "/stop",
    "Abort requested."
  );
}

export async function handleHelpCommand(
  _command: SlackCommandData,
  target: SlackCommandTarget,
  respond: SlackRespond
): Promise<void> {
  const dmEnabled = target.config.dm?.enabled === true;
  const requireMention = target.isDm
    ? false
    : target.channelConfig?.requireMention ?? true;
  const threadPolicy = target.channelConfig?.threadPolicy ?? "always";
  const lines = [
    `*${target.agent.name}* - Slack Commands`,
    "",
    "`/new [session]` - Start a new conversation",
    "`/stop [session]` - Stop the current run",
    "`!new [session]` - Same as `/new` but works inside threads (per-thread session)",
    "`!stop [session]` - Same as `/stop` but works inside threads",
    "`/help` - Show this help message",
    "`/ping` - Health check",
    "",
    "*Routing Policy:*",
    `- DMs: ${dmEnabled ? "enabled" : "disabled"}`,
    `- Requires mention: ${requireMention ? "yes" : "no"}`,
    `- Thread policy: ${target.isDm ? "n/a" : threadPolicy}`,
  ];
  await respond({ text: lines.join("\n"), response_type: "ephemeral" });
}

export async function handlePingCommand(
  _command: SlackCommandData,
  target: SlackCommandTarget,
  respond: SlackRespond
): Promise<void> {
  const sdk = target.agent.sdk ?? "pi";
  const model = target.agent.model?.model ?? "unknown";
  await respond({
    text: `Bot alive. Agent: *${target.agent.name}* (${sdk}/${model})`,
    response_type: "ephemeral",
  });
}
