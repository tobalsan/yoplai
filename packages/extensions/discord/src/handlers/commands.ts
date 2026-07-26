/**
 * Slash command handlers for Discord
 *
 * Provides /new, /abort, /help, /ping commands
 */

import {
  Command,
  type CommandInteraction,
  type CommandOptions,
} from "@buape/carbon";
import { ApplicationCommandType, ApplicationCommandOptionType } from "discord-api-types/v10";
import type { AgentConfig, DiscordConfig } from "@yoplai/shared";
import { DEFAULT_MAIN_KEY } from "@yoplai/shared";
import { getDiscordContext } from "../context.js";

export type CommandContext = {
  agent?: AgentConfig;
  botUserId?: string;
  resolveAgent?: (interaction: CommandInteraction) => AgentConfig | undefined;
  resolveDiscordConfig?: (
    interaction: CommandInteraction
  ) => DiscordConfig | undefined;
};

function getDefaultSessionKey(interaction: CommandInteraction): string {
  const raw = interaction.rawData as { channel_id?: string; guild_id?: string };
  if (raw.guild_id && raw.channel_id) {
    return `discord:${raw.channel_id}`;
  }
  return DEFAULT_MAIN_KEY;
}

function getAgent(
  ctx: CommandContext,
  interaction: CommandInteraction
): AgentConfig {
  const agent = ctx.resolveAgent?.(interaction) ?? ctx.agent;
  if (!agent) {
    throw new Error("No agent configured for this Discord route");
  }
  return agent;
}

function getDiscordConfig(
  ctx: CommandContext,
  interaction: CommandInteraction
): DiscordConfig | undefined {
  const resolved = ctx.resolveDiscordConfig?.(interaction);
  if (resolved) return resolved;
  return ctx.agent?.discord;
}

/**
 * /new [sessionKey?] - Reset session and start fresh
 */
export class NewCommand extends Command {
  name = "new";
  description = "Start a new conversation (resets session)";
  type = ApplicationCommandType.ChatInput;
  defer = true;

  options: CommandOptions = [
    {
      name: "session",
      description: "Session key (default: main)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ];

  private ctx: CommandContext;

  constructor(ctx: CommandContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction): Promise<void> {
    const agent = getAgent(this.ctx, interaction);
    const defaultSessionKey = getDefaultSessionKey(interaction);
    const sessionKey = (interaction.options.raw.find(
      (o) => o.name === "session"
    )?.value as string) ?? defaultSessionKey;

    try {
      const result = await getDiscordContext().runAgent({
        agentId: agent.id,
        message: "/new",
        sessionKey,
        source: "discord",
      });

      const text = result.payloads[0]?.text ?? "Session reset.";
      await interaction.reply({ content: text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

/**
 * /abort [sessionKey?] - Stop current run
 */
export class AbortCommand extends Command {
  name = "abort";
  description = "Stop the current agent run";
  type = ApplicationCommandType.ChatInput;
  defer = true;

  options: CommandOptions = [
    {
      name: "session",
      description: "Session key (default: main)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ];

  private ctx: CommandContext;

  constructor(ctx: CommandContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction): Promise<void> {
    const agent = getAgent(this.ctx, interaction);
    const defaultSessionKey = getDefaultSessionKey(interaction);
    const sessionKey = (interaction.options.raw.find(
      (o) => o.name === "session"
    )?.value as string) ?? defaultSessionKey;

    try {
      const result = await getDiscordContext().runAgent({
        agentId: agent.id,
        message: "/abort",
        sessionKey,
        source: "discord",
      });

      const text = result.payloads[0]?.text ?? "Abort requested.";
      await interaction.reply({ content: text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
    }
  }
}

/**
 * /help - Show available commands and routing policy
 */
export class HelpCommand extends Command {
  name = "help";
  description = "Show available commands and bot info";
  type = ApplicationCommandType.ChatInput;
  defer = false;
  ephemeral = true;

  private ctx: CommandContext;

  constructor(ctx: CommandContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction): Promise<void> {
    const agent = getAgent(this.ctx, interaction);
    const discord = getDiscordConfig(this.ctx, interaction);

    const lines = [
      `**${agent.name}** - Discord Commands`,
      "",
      "**Available Commands:**",
      "`/new [session]` - Start a new conversation",
      "`/abort [session]` - Stop the current run",
      "`/help` - Show this help message",
      "`/ping` - Health check",
      "",
      "**Routing Policy:**",
    ];

    // DM policy
    const dmEnabled = discord?.dm?.enabled !== false;
    lines.push(`- DMs: ${dmEnabled ? "enabled" : "disabled"}`);

    // Group policy
    const groupPolicy = discord?.groupPolicy ?? "open";
    lines.push(`- Group channels: ${groupPolicy}`);

    // Mention requirement
    const requireMention = true; // default
    lines.push(`- Requires mention: ${requireMention ? "yes" : "no"}`);

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }
}

/**
 * /ping - Health check
 */
export class PingCommand extends Command {
  name = "ping";
  description = "Check if the bot is online";
  type = ApplicationCommandType.ChatInput;
  defer = false;
  ephemeral = true;

  private ctx: CommandContext;

  constructor(ctx: CommandContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: CommandInteraction): Promise<void> {
    const agent = getAgent(this.ctx, interaction);
    const sdk = agent.sdk ?? "pi";
    const model = agent.model?.model ?? "unknown";

    await interaction.reply({
      content: `Bot alive! Agent: **${agent.name}** (${sdk}/${model})`,
      ephemeral: true,
    });
  }
}

/**
 * Create all slash commands for an agent
 */
export function createSlashCommands(ctx: CommandContext): Command[] {
  return [
    new NewCommand(ctx),
    new AbortCommand(ctx),
    new HelpCommand(ctx),
    new PingCommand(ctx),
  ];
}
