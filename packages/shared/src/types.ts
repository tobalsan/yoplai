import { z } from "zod";
import type {
  LeadSession,
  LeadSessionChangedEvent,
} from "./lead-sessions/types.js";
import type { Hono } from "hono";

export type { LeadSession, LeadSessionChangedEvent };

// Think levels
export const ThinkLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ThinkLevel = z.infer<typeof ThinkLevelSchema>;

// Agent model config
export const AgentModelConfigSchema = z.object({
  provider: z.string().optional(), // For display; inferred from sdk if omitted
  model: z.string(),
  base_url: z.string().optional(), // API proxy URL (e.g. for Claude SDK)
  auth_token: z.string().optional(), // API auth token (overrides env)
});
export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

export const RequiredModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type RequiredModelConfig = z.infer<typeof RequiredModelConfigSchema>;

// Discord config
export const DiscordConfigSchema = z.object({
  token: z.string().optional(),
  applicationId: z.string().optional(),

  // Legacy fields (backward compat - treated as single-guild/channel mode)
  guildId: z.string().optional(),
  channelId: z.string().optional(),

  // DM settings
  dm: z
    .object({
      enabled: z.boolean().default(true),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      groupEnabled: z.boolean().default(false),
      groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
    })
    .optional(),

  // Guild/channel routing & policy
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).default("open"),
  guilds: z
    .record(
      z.string(),
      z.object({
        slug: z.string().optional(),
        requireMention: z.boolean().default(true),
        reactionNotifications: z
          .enum(["off", "own", "all", "allowlist"])
          .default("off"),
        reactionAllowlist: z
          .array(z.union([z.string(), z.number()]))
          .optional(),
        users: z.array(z.union([z.string(), z.number()])).optional(),
        systemPrompt: z.string().optional(),
        channels: z
          .record(
            z.string(),
            z.object({
              enabled: z.boolean().default(true),
              requireMention: z.boolean().optional(),
              users: z.array(z.union([z.string(), z.number()])).optional(),
              systemPrompt: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),

  // Behavior
  historyLimit: z.number().int().min(0).default(20),
  clearHistoryAfterReply: z.boolean().optional().default(true),
  replyToMode: z.enum(["off", "all", "first"]).default("off"),
  mentionPatterns: z.array(z.string()).optional(),

  // Yoplai-only: broadcast main-session responses to a Discord channel
  broadcastToChannel: z.string().optional(),

  // Yoplai-only: Discord forum channels this agent subscribes to.
  forumChannels: z.array(z.string().min(1)).optional(),

  // Opt-in tool-call visibility (ALG-292): surface the agent's tool calls as
  // live, batched plain-text notes in the channel/thread during a turn. Off
  // when absent/false. Mirrors the Telegram option (ALG-288).
  showToolCalls: z.boolean().optional(),
  streamReplies: z.boolean().optional(),
  acknowledgeMessages: z.boolean().optional(),
  attachmentsEnabled: z.boolean().optional(),
  ackEmoji: z.string().min(1).optional(),
});
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

// Heartbeat config
export const HeartbeatConfigSchema = z.object({
  every: z.string().optional(), // Duration string (e.g., "30m", "1h", "0" to disable)
  prompt: z.string().optional(), // Custom prompt (replaces default)
  ackMaxChars: z.number().int().min(0).optional(), // Default: 300
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

// SDK types
export const SdkIdSchema = z.enum(["pi", "claude", "openclaw"]);
export type SdkId = z.infer<typeof SdkIdSchema>;

// OpenClaw config
export const OpenClawConfigSchema = z.object({
  gatewayUrl: z.string().optional(),
  token: z.string(),
  sessionKey: z.string().optional(),
  sessionMode: z.enum(["dedicated", "fixed"]).optional(),
});
export type OpenClawConfig = z.infer<typeof OpenClawConfigSchema>;

// Agent auth config
export const AgentAuthConfigSchema = z.object({
  mode: z.enum(["oauth", "api_key", "proxy"]).optional(),
  profileId: z.string().optional(), // e.g. "anthropic:default"
});
export type AgentAuthConfig = z.infer<typeof AgentAuthConfigSchema>;

export const ExtensionBaseConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();
export type ExtensionBaseConfig = z.infer<typeof ExtensionBaseConfigSchema>;

export const SandboxMountSchema = z.object({
  host: z.string(),
  container: z.string(),
  readonly: z.boolean().optional().default(true),
});
export type SandboxMount = z.infer<typeof SandboxMountSchema>;

export const AgentSandboxConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    image: z.string().optional().default("yoplai-agent:latest"),
    network: z.string().optional(),
    memory: z.string().optional().default("2g"),
    cpus: z.number().optional().default(1),
    timeout: z.number().optional(),
    idleTimeout: z.number().optional().default(300),
    maxRunTime: z.number().optional(),
    workspaceWritable: z.boolean().optional().default(false),
    env: z.record(z.string(), z.string()).optional(),
    mounts: z.array(SandboxMountSchema).optional(),
  })
  .transform((value) => ({
    ...value,
    maxRunTime: value.maxRunTime ?? value.timeout ?? 1800,
  }));
export type AgentSandboxConfig = z.infer<typeof AgentSandboxConfigSchema>;

export const WebhookConfigSchema = z.object({
  prompt: z.string(),
  langfuseTracing: z.boolean().default(true),
  signingSecret: z.string().optional(),
  verification: z
    .object({
      location: z.enum(["header", "payload"]),
      fieldName: z.string(),
    })
    .optional(),
  maxPayloadSize: z.number().int().positive().default(1048576),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export const SystemFileEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    required: z.boolean().optional(),
  }),
]);
export type SystemFileEntry = z.infer<typeof SystemFileEntrySchema>;

// Agent config
const AgentConfigBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().optional(), // emoji or image URL
  role: z.string().optional(), // short job title, e.g. "Sales Admin"
  workspace: z.string(),
  workspaceDir: z.string().optional(),
  system_files: z.array(SystemFileEntrySchema).optional(),
  sdk: SdkIdSchema.optional(), // default "pi"
  model: AgentModelConfigSchema.optional(),
  openclaw: OpenClawConfigSchema.optional(),
  auth: AgentAuthConfigSchema.optional(), // OAuth/API key auth config
  discord: DiscordConfigSchema.optional(),
  slack: z.lazy(() => SlackAgentConfigSchema).optional(),
  telegram: z.lazy(() => TelegramAgentConfigSchema).optional(),
  irc: z.lazy(() => IrcAgentConfigSchema).optional(),
  reasoning: ThinkLevelSchema.optional(),
  thinkLevel: ThinkLevelSchema.optional(),
  queueMode: z.enum(["queue", "interrupt"]).optional().default("queue"),
  heartbeat: HeartbeatConfigSchema.optional(), // Periodic heartbeat config
  webhooks: z.record(z.string(), WebhookConfigSchema).optional(),
  introMessage: z.string().optional(), // Custom intro for /new (default: "New conversation started.")
  extensions: z.record(z.string(), ExtensionBaseConfigSchema).optional(),
  globalSkills: z.boolean().optional(), // Include ~/.agents/skills/ (default: false)
  onecliToken: z.string().optional(), // Per-agent OneCLI proxy token
  sandbox: AgentSandboxConfigSchema.optional(),
});
export const AgentConfigSchema = AgentConfigBaseSchema.superRefine(
  (value, ctx) => {
    if (value.sdk !== "openclaw" && !value.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model is required",
        path: ["model"],
      });
    }
  }
).transform(
  (value): Omit<typeof value, "model"> & { model: AgentModelConfig } => {
    if (value.sdk === "openclaw" && !value.model) {
      return { ...value, model: { provider: "openclaw", model: "unknown" } };
    }
    return value as Omit<typeof value, "model"> & { model: AgentModelConfig };
  }
);
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const AgentYamlConfigBaseSchema = AgentConfigBaseSchema.omit({
  workspace: true,
  workspaceDir: true,
});
export const AgentYamlConfigSchema = AgentYamlConfigBaseSchema.superRefine(
  (value, ctx) => {
    if (value.sdk !== "openclaw" && !value.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model is required",
        path: ["model"],
      });
    }
  }
).transform(
  (value): Omit<typeof value, "model"> & { model: AgentModelConfig } => {
    if (value.sdk === "openclaw" && !value.model) {
      return { ...value, model: { provider: "openclaw", model: "unknown" } };
    }
    return value as Omit<typeof value, "model"> & { model: AgentModelConfig };
  }
);
export type AgentYamlConfig = z.infer<typeof AgentYamlConfigSchema>;

// Schedule types
export const ScheduleSchema = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1),
  startAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "startAt must be a valid ISO 8601 date",
    })
    .optional(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SchedulePayloadSchema = z.object({
  message: z.string(),
  sessionId: z.string().optional(),
});
export type SchedulePayload = z.infer<typeof SchedulePayloadSchema>;

export const ScheduleJobFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional().default(true),
  schedule: ScheduleSchema,
  model: RequiredModelConfigSchema.optional(),
  payload: SchedulePayloadSchema,
  createdAt: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
});
export type ScheduleJobFile = z.infer<typeof ScheduleJobFileSchema>;

// Schedule job
export const ScheduleJobSchema = ScheduleJobFileSchema.extend({
  agentId: z.string(),
});
export type ScheduleJob = z.infer<typeof ScheduleJobSchema>;

// UI bind mode
export const UiBindModeSchema = z.enum(["loopback", "lan", "tailnet"]);
export type UiBindMode = z.infer<typeof UiBindModeSchema>;

// UI tailscale config
export const UiTailscaleConfigSchema = z.object({
  mode: z.enum(["off", "serve"]).optional(),
  resetOnExit: z.boolean().optional(),
});
export type UiTailscaleConfig = z.infer<typeof UiTailscaleConfigSchema>;

// UI config
export const UiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().optional(),
  bind: UiBindModeSchema.optional(),
  tailscale: UiTailscaleConfigSchema.optional(),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

// Gateway server bind mode (reuses UiBindMode)
export const GatewayBindModeSchema = UiBindModeSchema;
export type GatewayBindMode = UiBindMode;

// Gateway server config
export const GatewayServerConfigSchema = z.object({
  host: z.string().optional(), // Explicit host (overrides bind)
  port: z.number().optional(),
  bind: GatewayBindModeSchema.optional(), // loopback | lan | tailnet
});
export type GatewayServerConfig = z.infer<typeof GatewayServerConfigSchema>;

// OAuth (per-agent connect framework). BYO = operator supplies their own
// OAuth client id/secret per provider. `$env:` refs are resolved by the host.
export const OAuthProviderClientConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});
export type OAuthProviderClientConfig = z.infer<
  typeof OAuthProviderClientConfigSchema
>;

export const OAuthConfigSchema = z.object({
  /**
   * Public base URL of the gateway used to build the redirect URI, e.g.
   * "http://localhost:4000". The callback route is
   * `<redirectBaseUrl>/api/oauth/<provider>/callback`.
   */
  redirectBaseUrl: z.string().optional(),
  /** BYO client credentials keyed by provider id (e.g. "google"). */
  providers: z
    .record(z.string(), OAuthProviderClientConfigSchema)
    .optional()
    .default({}),
  /**
   * Secret used to encrypt stored OAuth tokens (access + refresh) at rest, so a
   * leaked token file / DB row cannot be replayed against the provider. A
   * `$env:` ref (resolved by the host) or a literal; supply 32+ bytes of
   * entropy (e.g. `openssl rand -base64 32`). When unset, tokens are stored in
   * plaintext and the gateway logs a warning at startup.
   */
  encryptionKey: z.string().optional(),
});
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

// Sessions config
export const SessionsConfigSchema = z.object({
  idleMinutes: z.number().int().min(1).default(360),
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

// Taskboard config
export const TaskboardConfigSchema = z.object({
  todosPath: z.string().optional(),
  projectsPath: z.string().optional(),
});
export type TaskboardConfig = z.infer<typeof TaskboardConfigSchema>;

// Projects config
export const ProjectsConfigSchema = z.object({
  root: z.string().optional(),
  worktrees: z.string().optional(),
});
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;

export const SecretRefSchema = z.string();
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const MultiUserGoogleOAuthConfigSchema = z.object({
  clientId: SecretRefSchema.min(1),
  clientSecret: SecretRefSchema.min(1),
});
export type MultiUserGoogleOAuthConfig = z.infer<
  typeof MultiUserGoogleOAuthConfigSchema
>;

export const MultiUserOAuthConfigSchema = z.object({
  google: MultiUserGoogleOAuthConfigSchema,
});
export type MultiUserOAuthConfig = z.infer<typeof MultiUserOAuthConfigSchema>;

const MultiUserConfigBaseSchema = z.object({
  allowedDomains: z.array(z.string().min(1)).optional(),
});

export const MultiUserConfigSchema = z.discriminatedUnion("enabled", [
  MultiUserConfigBaseSchema.extend({
    enabled: z.literal(false),
    oauth: MultiUserOAuthConfigSchema.optional(),
    sessionSecret: SecretRefSchema.optional(),
  }),
  MultiUserConfigBaseSchema.extend({
    enabled: z.literal(true),
    oauth: MultiUserOAuthConfigSchema,
    sessionSecret: SecretRefSchema.min(1),
  }),
]);
export type MultiUserConfig = z.infer<typeof MultiUserConfigSchema>;

export const OnecliCaConfigSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("file"), path: z.string().min(1) }),
  z.object({ source: z.literal("system") }),
]);
export type OnecliCaConfig = z.infer<typeof OnecliCaConfigSchema>;

export const OnecliSandboxConfigSchema = z.object({
  network: z.string().min(1).optional(),
  url: z.string().url().optional(),
});
export type OnecliSandboxConfig = z.infer<typeof OnecliSandboxConfigSchema>;

export const OnecliConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  mode: z.literal("proxy").default("proxy"),
  dashboardUrl: z.string().url().optional(),
  gatewayUrl: z.string().url(),
  ca: OnecliCaConfigSchema.optional(),
  sandbox: OnecliSandboxConfigSchema.optional(),
});
export type OnecliConfig = z.infer<typeof OnecliConfigSchema>;

export const DiscordExtensionChannelConfigSchema = z.object({
  agent: z.string(),
  requireMention: z.boolean().optional(),
});
export type DiscordExtensionChannelConfig = z.infer<
  typeof DiscordExtensionChannelConfigSchema
>;

export const DiscordExtensionDmConfigSchema = z.object({
  enabled: z.boolean().optional(),
  agent: z.string(),
});
export type DiscordExtensionDmConfig = z.infer<
  typeof DiscordExtensionDmConfigSchema
>;

export const DiscordExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  token: SecretRefSchema,
  channels: z
    .record(z.string(), DiscordExtensionChannelConfigSchema)
    .optional(),
  dm: DiscordExtensionDmConfigSchema.optional(),
  historyLimit: z.number().int().min(0).optional(),
  replyToMode: z.enum(["off", "all", "first"]).optional(),
  applicationId: z.string().optional(),
  guilds: DiscordConfigSchema.shape.guilds.optional(),
  groupPolicy: DiscordConfigSchema.shape.groupPolicy.optional(),
  mentionPatterns: z.array(z.string()).optional(),
  broadcastToChannel: z.string().optional(),
  clearHistoryAfterReply: z.boolean().optional(),

  // Opt-in tool-call visibility (ALG-292): surface the agent's tool calls as
  // live, batched plain-text notes in the channel/thread during a turn. Off
  // when absent/false. Mirrors the Telegram option (ALG-288).
  showToolCalls: z.boolean().optional(),
  streamReplies: z.boolean().optional(),
  acknowledgeMessages: z.boolean().optional(),
  attachmentsEnabled: z.boolean().optional(),
  ackEmoji: z.string().min(1).optional(),
});
export type DiscordExtensionConfig = z.infer<
  typeof DiscordExtensionConfigSchema
>;
export type DiscordComponentConfig = DiscordExtensionConfig;

export const IrcChannelConfigSchema = z.object({
  agent: z.string().min(1),
  mode: z
    .enum(["mention-only", "reply-all"])
    .optional()
    .default("mention-only"),
});
export type IrcChannelConfig = z.infer<typeof IrcChannelConfigSchema>;

export const IrcExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional().default(6697),
  tls: z.boolean().optional().default(true),
  nick: z.string().min(1),
  username: z.string().min(1).optional(),
  password: SecretRefSchema.optional(),
  nickservPassword: SecretRefSchema.optional(),
  channels: z.record(z.string().min(1), IrcChannelConfigSchema).default({}),
  dm: z
    .object({
      enabled: z.boolean().optional(),
      agent: z.string().min(1).optional(),
      allowFrom: z.array(z.string()).optional(),
      debounceMs: z.number().int().min(0).optional(),
    })
    .optional(),
  debounceMs: z.number().int().min(0).optional(),
  historyLimit: z.number().int().min(0).optional().default(20),
  maxA2ATurns: z.number().int().min(0).optional().default(4),
  humanNicks: z.array(z.string()).optional().default([]),
});
export type IrcExtensionConfig = z.infer<typeof IrcExtensionConfigSchema>;

export const IrcAgentConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional().default(6697),
  tls: z.boolean().optional().default(true),
  nick: z.string().min(1),
  username: z.string().min(1).optional(),
  password: SecretRefSchema.optional(),
  nickservPassword: SecretRefSchema.optional(),
  channels: z
    .record(
      z.string().min(1),
      IrcChannelConfigSchema.omit({ agent: true }).strict()
    )
    .default({}),
  dm: z
    .object({
      enabled: z.boolean().optional(),
      allowFrom: z.array(z.string()).optional(),
      debounceMs: z.number().int().min(0).optional(),
    })
    .strict()
    .optional(),
  debounceMs: z.number().int().min(0).optional(),
  historyLimit: z.number().int().min(0).optional().default(20),
  maxA2ATurns: z.number().int().min(0).optional().default(4),
  humanNicks: z.array(z.string()).optional().default([]),
});
export type IrcAgentConfig = z.infer<typeof IrcAgentConfigSchema>;

export const SlackExtensionChannelConfigSchema = z.object({
  agent: z.string(),
  requireMention: z.boolean().optional(),
  threadPolicy: z.enum(["always", "never", "follow"]).optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
});
export type SlackExtensionChannelConfig = z.infer<
  typeof SlackExtensionChannelConfigSchema
>;
export type SlackComponentChannelConfig = SlackExtensionChannelConfig;

export const SlackExtensionDmConfigSchema = z.object({
  enabled: z.boolean().optional(),
  agent: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  threadPolicy: z.enum(["always", "never", "follow"]).optional(),
});
export type SlackExtensionDmConfig = z.infer<
  typeof SlackExtensionDmConfigSchema
>;
export type SlackComponentDmConfig = SlackExtensionDmConfig;

export const SlackExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  token: SecretRefSchema,
  appToken: SecretRefSchema,
  channels: z.record(z.string(), SlackExtensionChannelConfigSchema).optional(),
  dm: SlackExtensionDmConfigSchema.optional(),
  historyLimit: z.number().int().min(0).optional(),
  clearHistoryAfterReply: z.boolean().optional(),
  mentionPatterns: z.array(z.string()).optional(),
  broadcastToChannel: z.string().optional(),
  applicationId: z.string().optional(),
  showThinking: z.boolean().optional(),
  deleteThinkingOnComplete: z.boolean().optional(),
});
export type SlackExtensionConfig = z.infer<typeof SlackExtensionConfigSchema>;
export type SlackComponentConfig = SlackExtensionConfig;

export const SlackAgentConfigSchema = z.object({
  token: SecretRefSchema,
  appToken: SecretRefSchema,
  channels: z.record(z.string(), SlackExtensionChannelConfigSchema).optional(),
  dm: SlackExtensionDmConfigSchema.optional(),
  historyLimit: z.number().int().min(0).optional(),
  clearHistoryAfterReply: z.boolean().optional(),
  mentionPatterns: z.array(z.string()).optional(),
  broadcastToChannel: z.string().optional(),
  applicationId: z.string().optional(),
  showThinking: z.boolean().optional(),
  deleteThinkingOnComplete: z.boolean().optional(),
});
export type SlackAgentConfig = z.infer<typeof SlackAgentConfigSchema>;

// Telegram allowlist entries mirror the discord/slack convention: each entry is
// a user/chat id (numeric or string) or a username, matched case-insensitively.
const TelegramAllowlistSchema = z.array(z.union([z.string(), z.number()]));

// Telegram extension config. `allowedUsers`/`allowedChats` gate who may talk to
// the bot, mirroring the discord/slack allow-list shape (an array of ids or
// usernames). An empty/omitted list means "no one is allowed" so enforcement
// fails closed, matching discord's allowlist policy.
export const TelegramExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  token: SecretRefSchema,
  allowedUsers: TelegramAllowlistSchema.optional(),
  allowedChats: TelegramAllowlistSchema.optional(),
  // Opt-in tool-call visibility: when true, concise one-line notes about the
  // agent's tool calls/actions are surfaced in the chat as the turn progresses
  // (for auditability). OFF by default so chats stay clean — only the agent's
  // reply is shown. Operators flip this per deployment without code changes.
  showToolCalls: z.boolean().optional(),
});
export type TelegramExtensionConfig = z.infer<
  typeof TelegramExtensionConfigSchema
>;
export type TelegramComponentConfig = TelegramExtensionConfig;

export const TelegramAgentConfigSchema = z.object({
  token: SecretRefSchema,
  allowedUsers: TelegramAllowlistSchema.optional(),
  allowedChats: TelegramAllowlistSchema.optional(),
  // Per-agent opt-in tool-call visibility; see TelegramExtensionConfigSchema.
  // OFF by default.
  showToolCalls: z.boolean().optional(),
});
export type TelegramAgentConfig = z.infer<typeof TelegramAgentConfigSchema>;

export const NotificationChannelConfigSchema = z.object({
  discord: z.string().min(1).optional(),
  slack: z.string().min(1).optional(),
});
export type NotificationChannelConfig = z.infer<
  typeof NotificationChannelConfigSchema
>;

export const NotificationsConfigSchema = z.object({
  channels: z.record(z.string(), NotificationChannelConfigSchema).optional(),
});
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const SchedulerExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  jobTimeoutMs: z.number().positive().optional(),
});
export type SchedulerExtensionConfig = z.infer<
  typeof SchedulerExtensionConfigSchema
>;

export const HeartbeatExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
});
export type HeartbeatExtensionConfig = z.infer<
  typeof HeartbeatExtensionConfigSchema
>;

export const OrchestratorSourceSchema = z.enum(["manual", "orchestrator"]);
export type OrchestratorSource = z.infer<typeof OrchestratorSourceSchema>;

export const ProjectsOrchestratorStatusConfigSchema = z.object({
  profile: z.string(),
  max_concurrent: z.number().int().nonnegative().default(1),
});

export const ProjectsOrchestratorShapingStatusConfigSchema =
  ProjectsOrchestratorStatusConfigSchema.extend({
    stall_threshold_ms: z.number().int().nonnegative().optional(),
  });
export type ProjectsOrchestratorStatusConfig = z.infer<
  typeof ProjectsOrchestratorStatusConfigSchema
>;
export type ProjectsOrchestratorShapingStatusConfig = z.infer<
  typeof ProjectsOrchestratorShapingStatusConfigSchema
>;

const ProjectsOrchestratorMergerStatusConfigSchema =
  ProjectsOrchestratorStatusConfigSchema.extend({
    max_concurrent: z.number().int().nonnegative().default(2),
  });

export const ProjectsOrchestratorConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  poll_interval_ms: z.number().int().positive().optional().default(30_000),
  failure_cooldown_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(60_000),
  stall_threshold_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(30 * 60_000),
  hitl_channel: z.string().min(1).optional(),
  statuses: z
    .object({
      todo: ProjectsOrchestratorStatusConfigSchema.optional(),
      review: ProjectsOrchestratorStatusConfigSchema.optional(),
      ready_to_merge: ProjectsOrchestratorMergerStatusConfigSchema.optional(),
    })
    .passthrough()
    .optional()
    .default({}),
  shaping_statuses: z
    .record(z.string(), ProjectsOrchestratorShapingStatusConfigSchema)
    .optional()
    .default({}),
  notify_channel: z.string().optional(),
});
export type ProjectsOrchestratorConfig = z.infer<
  typeof ProjectsOrchestratorConfigSchema
>;

export const ProjectsExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  root: z.string().optional(),
  worktreeDir: z.string().optional(),
  orchestrator: ProjectsOrchestratorConfigSchema.optional(),
});
export type ProjectsExtensionConfig = z.infer<
  typeof ProjectsExtensionConfigSchema
>;

export const SubagentRuntimeCliSchema = z.enum(["codex", "claude", "pi"]);
export type SubagentRuntimeCli = z.infer<typeof SubagentRuntimeCliSchema>;

export const SubagentRuntimeProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  cli: SubagentRuntimeCliSchema,
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  reasoningEffort: z.string().optional(),
  thinking: z.string().optional(),
  labelPrefix: z.string().optional(),
  type: z.string().optional(),
  runMode: z.string().optional(),
});
export type SubagentRuntimeProfile = z.infer<
  typeof SubagentRuntimeProfileSchema
>;

export const SubagentsExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  profiles: z.array(SubagentRuntimeProfileSchema).optional().default([]),
});
export type SubagentsExtensionConfig = z.infer<
  typeof SubagentsExtensionConfigSchema
>;

export const SessionsExtensionConfigSchema = z.object({
  autoTitleModel: z.string().optional(),
});
export type SessionsExtensionConfig = z.infer<
  typeof SessionsExtensionConfigSchema
>;

export const OrchestratorExtensionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  projects: z.array(z.string()).optional().default([]),
  projectsRoot: z.string().optional(),
  concurrency: z
    .object({
      global: z.number().int().positive().optional(),
    })
    .optional()
    .default({}),
  validation: z
    .object({
      strict: z.boolean().optional().default(true),
    })
    .optional()
    .default({ strict: true }),
  notifyChannel: z.string().optional(),
  linear: z
    .object({
      exposeGraphqlTool: z.boolean().optional(),
    })
    .optional(),
  plane: z
    .object({
      exposeApiTool: z.boolean().optional(),
    })
    .optional(),
  webhook: z
    .object({
      enabled: z.boolean().optional(),
      path: z.string().optional(),
      secret: z.string().optional(),
    })
    .optional(),
});
export type OrchestratorExtensionConfig = z.infer<
  typeof OrchestratorExtensionConfigSchema
>;

export const LangfuseExtensionConfigSchema = ExtensionBaseConfigSchema.extend({
  baseUrl: z.string().optional(),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
  flushAt: z.number().optional(),
  flushInterval: z.number().optional(),
  debug: z.boolean().optional(),
  env: z.string().optional(),
  environment: z.string().optional(),
});
export type LangfuseExtensionConfig = z.infer<
  typeof LangfuseExtensionConfigSchema
>;

export const ExtensionsConfigSchema = z
  .object({
    discord: DiscordExtensionConfigSchema.optional(),
    irc: IrcExtensionConfigSchema.optional(),
    slack: SlackExtensionConfigSchema.optional(),
    telegram: TelegramExtensionConfigSchema.optional(),
    scheduler: z
      .object({
        enabled: z.boolean().optional(),
        jobTimeoutMs: z.number().optional(),
      })
      .optional(),
    heartbeat: HeartbeatExtensionConfigSchema.optional(),
    projects: ProjectsExtensionConfigSchema.optional(),
    orchestrator: OrchestratorExtensionConfigSchema.optional(),
    subagents: SubagentsExtensionConfigSchema.optional(),
    sessions: SessionsExtensionConfigSchema.optional(),
    langfuse: LangfuseExtensionConfigSchema.optional(),
    multiUser: MultiUserConfigSchema.optional(),
    board: z
      .object({
        enabled: z.boolean().optional(),
        contentRoot: z.string().optional(),
        home: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough()
  .optional();
export type ExtensionsConfig = z.infer<typeof ExtensionsConfigSchema>;

export const SubagentConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  cli: z.enum(["codex", "claude", "pi"]),
  model: z.string(),
  reasoning: z.string(),
  type: z.enum(["worker", "reviewer", "merger"]),
  runMode: z.enum(["clone", "main", "worktree", "none"]),
});
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const MountAllowlistSchema = z.object({
  allowedRoots: z.array(z.string()),
  blockedPatterns: z
    .array(z.string())
    .optional()
    .default([".ssh", ".gnupg", ".aws", ".env"]),
});
export type MountAllowlist = z.infer<typeof MountAllowlistSchema>;

export const SandboxNetworkSchema = z.object({
  name: z.string().optional().default("yoplai-agents"),
  internal: z.boolean().optional().default(true),
});
export type SandboxNetwork = z.infer<typeof SandboxNetworkSchema>;

export const GlobalSandboxConfigSchema = z.object({
  sharedDir: z.string().optional(),
  network: SandboxNetworkSchema.optional(),
  mountAllowlist: MountAllowlistSchema.optional(),
});
export type GlobalSandboxConfig = z.infer<typeof GlobalSandboxConfigSchema>;

export const AgentDiscoveryConfigSchema = z.union([
  z.string(),
  z.array(z.string()),
]);

export const GatewayRootConfigSchema = z.object({
  version: z.literal(3).optional(),
  agents: AgentDiscoveryConfigSchema.optional(),
  pool: AgentDiscoveryConfigSchema.optional(),
  defaultProjectManager: z.string().optional(),
  sandbox: GlobalSandboxConfigSchema.optional(),
  onecli: OnecliConfigSchema.optional(),
  oauth: OAuthConfigSchema.optional(),
  extensions: ExtensionsConfigSchema,
  extensionsPath: z.string().optional(),
  branding: z
    .object({
      name: z.string().optional(),
      logo: z.string().optional(),
    })
    .optional(),
  agentFab: z.boolean().optional().default(false),
  server: z
    .object({
      host: z.string().optional(),
      port: z.number().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  gateway: GatewayServerConfigSchema.optional(),
  sessions: SessionsConfigSchema.optional().default({}),
  web: z
    .object({
      baseUrl: z.string().optional(),
    })
    .optional(),
  ui: UiConfigSchema.optional(),
  taskboard: TaskboardConfigSchema.optional(),
  projects: ProjectsConfigSchema.optional(),
  subagents: z.array(SubagentConfigSchema).optional(),
  notifications: NotificationsConfigSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type GatewayRootConfig = z.infer<typeof GatewayRootConfigSchema>;

// Gateway config
export const GatewayConfigSchema = z.object({
  version: z.number().optional(),
  agents: z.array(AgentConfigSchema),
  pool: z.array(AgentConfigSchema).optional(),
  forkedAgents: z.boolean().optional(),
  defaultProjectManager: z.string().optional(),
  sandbox: GlobalSandboxConfigSchema.optional(),
  onecli: OnecliConfigSchema.optional(),
  oauth: OAuthConfigSchema.optional(),
  extensions: ExtensionsConfigSchema,
  extensionsPath: z.string().optional(),
  branding: z
    .object({
      name: z.string().optional(),
      logo: z.string().optional(),
    })
    .optional(),
  agentFab: z.boolean().optional().default(false),
  server: z
    .object({
      host: z.string().optional(),
      port: z.number().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  gateway: GatewayServerConfigSchema.optional(),
  sessions: SessionsConfigSchema.optional().default({}),
  web: z
    .object({
      baseUrl: z.string().optional(),
    })
    .optional(),
  ui: UiConfigSchema.optional(),
  taskboard: TaskboardConfigSchema.optional(),
  projects: ProjectsConfigSchema.optional(),
  subagents: z.array(SubagentConfigSchema).optional(),
  notifications: NotificationsConfigSchema.optional(),
  env: z.record(z.string(), z.string()).optional(), // Env vars to set (only if not already set)
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export type AgentTraceContext = {
  enabled?: boolean;
  name?: string;
  surface?: string;
  metadata?: Record<string, unknown>;
};

export type RunAgentParams = {
  agentId: string;
  message: string;
  attachments?: FileAttachment[];
  sessionId?: string;
  sessionKey?: string;
  thinkLevel?: ThinkLevel;
  model?: RequiredModelConfig;
  context?: AgentContext;
  source?: string;
  /** Exclude this run from agent-wide UI streaming status. */
  background?: boolean;
  trace?: AgentTraceContext;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
};

export type RunAgentResult = {
  payloads: Array<{ text?: string; mediaUrls?: string[] }>;
  meta: {
    durationMs: number;
    sessionId: string;
    aborted?: boolean;
    queued?: boolean;
  };
};

export const DEFAULT_MAIN_KEY = "main";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  createdAt?: number;
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ExtensionLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type SubagentTemplate = SubagentConfig;
export type HistoryMessage = SimpleHistoryMessage | FullHistoryMessage;

export interface ExtensionContext {
  // Config
  getConfig(): GatewayConfig;
  getDataDir(): string;
  reloadConfig(): void;

  // Agent access
  getAgent(id: string): AgentConfig | undefined;
  getAgents(): AgentConfig[];
  isAgentActive(id: string): boolean;

  // Agent runtime state
  isAgentStreaming(agentId: string): boolean;
  resolveWorkspaceDir(agent: AgentConfig): string;

  // Agent execution
  runAgent(params: RunAgentParams): Promise<RunAgentResult>;
  getSubagentTemplates(): SubagentTemplate[];

  // Session management
  resolveSessionId(
    agentId: string,
    sessionKey: string
  ): Promise<SessionEntry | undefined>;
  getSessionEntry(
    agentId: string,
    sessionKey: string
  ): Promise<SessionEntry | undefined>;
  clearSessionEntry(
    agentId: string,
    sessionKey: string,
    userId?: string
  ): Promise<SessionEntry | undefined>;
  restoreSessionUpdatedAt(
    agentId: string,
    sessionKey: string,
    timestamp: number
  ): void;
  deleteSession(agentId: string, sessionId: string): void;
  invalidateHistoryCache(
    agentId: string,
    sessionId: string,
    userId?: string
  ): Promise<void>;
  getSessionHistory(
    agentId: string,
    sessionId: string
  ): Promise<HistoryMessage[]>;

  // Media
  saveMediaFile?(
    data: Uint8Array | ArrayBuffer,
    mimeType: string,
    filename?: string
  ): Promise<FileAttachment>;
  readMediaFile?(fileId: string): Promise<{
    data: Uint8Array;
    filename: string;
    mimeType: string;
    size: number;
  }>;

  // Events
  subscribe(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;

  // Logging
  logger: ExtensionLogger;
}

export type ExtensionAgentToolContext = {
  agent: AgentConfig;
  config: GatewayConfig;
  env?: Record<string, string>;
  sessionId?: string;
};

export type ExtensionAgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: unknown,
    context: ExtensionAgentToolContext
  ): unknown | Promise<unknown>;
};

/**
 * Resolves an extension's declared OAuth requirement into a fresh access token
 * (or a structured not-connected signal). The host injects this into the
 * extension hook context; extensions never touch the token store directly.
 */
export type OAuthTokenResolver = (
  agent: AgentConfig,
  requirement: import("./oauth/types.js").OAuthRequirement
) => Promise<import("./oauth/types.js").ResolvedOAuth>;

export type ExtensionHookContext = {
  config: GatewayConfig;
  resolveOAuth?: OAuthTokenResolver;
};

/**
 * Self-registered, agent-keyed config route (the "bespoke route" tier of the
 * config-surface contract). An extension that owns a custom config UI declares
 * a route template containing the `:agentId` param — mirroring the existing
 * `:projectId` param pattern — and the hub redirects there when the extension
 * is enabled for an agent, instead of rendering a generic auto-form.
 *
 * `path` is a client route template (e.g. `"/agents/:agentId/extensions/mcp"`).
 * It MUST include the literal `:agentId` token; the hub substitutes the real
 * agent id to produce the concrete redirect target. This is the low-friction
 * escape hatch: an extension self-registers one field and gets a bespoke
 * config surface with no other wiring.
 */
export type AgentConfigRoute = {
  path: string;
};

/**
 * Substitute the concrete agent id into an agent-keyed config route template.
 * Returns `undefined` when no route is declared. Throws if the template is
 * missing the required `:agentId` token, so a malformed self-registration is a
 * loud contract error rather than a silent broken link.
 */
export function resolveAgentConfigRoute(
  route: AgentConfigRoute | undefined,
  agentId: string
): string | undefined {
  if (!route) return undefined;
  if (!route.path.includes(":agentId")) {
    throw new Error(
      `Extension configRoute "${route.path}" must include the ":agentId" param`
    );
  }
  return route.path.replace(/:agentId/g, encodeURIComponent(agentId));
}

export interface Extension {
  id: string;
  displayName: string;
  description: string;
  dependencies: string[];
  configSchema: z.ZodTypeAny;
  routePrefixes: string[];
  /**
   * Optional config metadata for admin config surfaces (e.g. the Edit-Agent
   * extension hub). `configJsonSchema` is the JSON-schema rendering of the
   * extension's real config shape (populated by `defineToolExtension` from its
   * Zod `configSchema`); `requiredSecrets` names the fields a UI must mask.
   * `advancedConfigFields` names fields a UI should collapse by default.
   * Both are optional: extensions that have not yet migrated simply omit them,
   * and the catalog marks their tier accordingly.
   */
  configJsonSchema?: Record<string, unknown>;
  requiredSecrets?: string[];
  advancedConfigFields?: string[];
  /**
   * Optional self-registered, agent-keyed config route. When present, the hub
   * treats this extension as the `bespoke-route` tier: enabling it redirects to
   * this route (with `:agentId` resolved) instead of rendering an auto-form.
   * The escape hatch for custom config UI (e.g. a file-based config editor).
   */
  configRoute?: AgentConfigRoute;
  /**
   * Internal/factory extension: hidden from the agent-edit UI, still
   * enable-able via agent.yaml.
   */
  factory?: boolean;
  validateConfig(raw: unknown): ValidationResult;
  registerRoutes(app: Hono): void;
  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  capabilities(): string[];
  getSystemPromptContributions?(
    agent: AgentConfig,
    context?: ExtensionHookContext
  ): string | string[] | undefined | Promise<string | string[] | undefined>;
  getAgentTools?(
    agent: AgentConfig,
    context?: ExtensionHookContext
  ): ExtensionAgentTool[] | Promise<ExtensionAgentTool[]>;
  validateAgentConfigs?(config: GatewayConfig): ValidationResult;
}

const isZodSchema = (value: unknown): value is z.ZodTypeAny =>
  typeof value === "object" &&
  value !== null &&
  "safeParse" in value &&
  typeof value.safeParse === "function";

export const ZodSchemaSchema = z.custom<z.ZodTypeAny>(isZodSchema, {
  message: "Expected Zod schema",
});

export const ExtensionDefinitionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()),
  configSchema: ZodSchemaSchema,
  routePrefixes: z.array(z.string()),
  configJsonSchema: z.record(z.string(), z.unknown()).optional(),
  requiredSecrets: z.array(z.string()).optional(),
  advancedConfigFields: z.array(z.string()).optional(),
  configRoute: z
    .object({
      path: z.string().refine((value) => value.includes(":agentId"), {
        message: 'configRoute.path must include the ":agentId" param',
      }),
    })
    .optional(),
  factory: z.boolean().optional(),
  validateConfig: z
    .function()
    .args(z.unknown())
    .returns(z.object({ valid: z.boolean(), errors: z.array(z.string()) })),
  registerRoutes: z.function().args(z.unknown()).returns(z.void()),
  start: z.function().args(z.unknown()).returns(z.promise(z.void())),
  stop: z.function().args().returns(z.promise(z.void())),
  capabilities: z.function().args().returns(z.array(z.string())),
  getSystemPromptContributions: z.function().optional(),
  getAgentTools: z.function().optional(),
  validateAgentConfigs: z.function().optional(),
});

// API payloads
export const SendMessageRequestSchema = z.object({
  message: z.string(),
  sessionId: z.string().optional(), // explicit session ID (bypasses sessionKey resolution)
  sessionKey: z.string().optional(), // logical key (resolved to sessionId with idle timeout)
  thinkLevel: ThinkLevelSchema.optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const AgentStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  isStreaming: z.boolean(),
  lastActivity: z.number().optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

const CapabilitiesUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  role: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
});

export const CapabilitiesResponseSchema = z.object({
  version: z.number(),
  extensions: z.record(z.string(), z.boolean()),
  agents: z.array(z.string()),
  multiUser: z.boolean(),
  forkedAgents: z.boolean().optional().default(false),
  agentFab: z.boolean(),
  home: z.string().optional(),
  user: CapabilitiesUserSchema.optional(),
  branding: z
    .object({
      name: z.string().optional(),
      logo: z.string().optional(),
    })
    .optional(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

// Projects API types
export const ProjectStatusSchema = z
  .string()
  .regex(
    /^(triage|shaping|active|ready_to_merge|done|cancelled|shaping:[a-z][a-z0-9_-]*)$/
  );
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const AreaSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  repo: z.string().optional(),
  order: z.number().optional(),
});
export type Area = z.infer<typeof AreaSchema>;

export const TaskSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  checked: z.boolean(),
  agentId: z.string().optional(),
  order: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateProjectRequestSchema = z.object({
  title: z.string(),
  pitch: z.string().optional(),
  status: ProjectStatusSchema.optional(),
  area: z.string().optional(),
  repo: z.union([z.string(), z.literal("")]).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  title: z.string().optional(),
  status: ProjectStatusSchema.optional(),
  agent: z.string().optional(),
  readme: z.string().optional(),
  specs: z.string().optional(),
  docs: z.record(z.string()).optional(),
  repo: z.union([z.string(), z.literal("")]).optional(),
  area: z.union([z.string(), z.literal("")]).optional(),
  sessionKeys: z.record(z.string()).nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ProjectCommentRequestSchema = z.object({
  author: z.string(),
  message: z.string(),
});
export type ProjectCommentRequest = z.infer<typeof ProjectCommentRequestSchema>;

export const UpdateProjectCommentRequestSchema = z.object({
  body: z.string(),
});
export type UpdateProjectCommentRequest = z.infer<
  typeof UpdateProjectCommentRequestSchema
>;

export const StartPromptRoleSchema = z.enum([
  "coordinator",
  "worker",
  "reviewer",
  "legacy",
]);
export type StartPromptRole = z.infer<typeof StartPromptRoleSchema>;

export const CliRunModeSchema = z.enum([
  "main-run",
  "worktree",
  "clone",
  "none",
]);
export type CliRunMode = z.infer<typeof CliRunModeSchema>;

export const StartProjectRunRequestSchema = z.object({
  customPrompt: z.string().optional(),
  runAgent: z.string().optional(),
  promptRole: StartPromptRoleSchema.optional(),
  includeDefaultPrompt: z.boolean().optional(),
  includeRoleInstructions: z.boolean().optional(),
  includePostRun: z.boolean().optional(),
  subagentTemplate: z.string().optional(),
  runMode: z.string().optional(),
  baseBranch: z.string().optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  thinking: z.string().optional(),
});
export type StartProjectRunRequest = z.infer<
  typeof StartProjectRunRequestSchema
>;

export type SubagentGlobalListItem = {
  projectId?: string;
  sliceId?: string;
  slug: string;
  type?: "subagent";
  cli?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  runMode?: string;
  baseBranch?: string;
  worktreePath?: string;
  source?: OrchestratorSource;
  status: "running" | "replied" | "error" | "idle";
  lastActive?: string;
  runStartedAt?: string;
  finishedAt?: string;
};

export const SubagentRunStatusSchema = z.enum([
  "starting",
  "running",
  "done",
  "error",
  "interrupted",
]);
export type SubagentRunStatus = z.infer<typeof SubagentRunStatusSchema>;

export type SubagentParent = {
  type: string;
  id: string;
};

export type SubagentRun = {
  id: string;
  label: string;
  parent?: SubagentParent;
  projectId?: string;
  sliceId?: string;
  cli: SubagentRuntimeCli;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  status: SubagentRunStatus;
  pid?: number;
  cliSessionId?: string;
  startedAt: string;
  lastActiveAt?: string;
  latestOutput?: string;
  finishedAt?: string;
  exitCode?: number;
  lastError?: string;
  archived?: boolean;
};

export type SubagentLogEvent = {
  ts?: string;
  type: string;
  text?: string;
  tool?: { name?: string; id?: string };
  diff?: { path?: string; summary?: string };
  parentToolUseId?: string;
};

export const CreateScheduleRequestSchema = z.object({
  name: z.string(),
  agentId: z.string().optional(),
  schedule: ScheduleSchema,
  model: RequiredModelConfigSchema.optional(),
  payload: SchedulePayloadSchema,
  timeoutMs: z.number().positive().optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: ScheduleSchema.optional(),
  model: RequiredModelConfigSchema.optional(),
  payload: SchedulePayloadSchema.optional(),
  timeoutMs: z.number().positive().optional(),
});
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

// Image attachment for multimodal messages (base64 - legacy)
export type ImageAttachment = {
  /** Base64-encoded image data (without data: prefix) */
  data: string;
  /** MIME type (image/jpeg, image/png, image/gif, image/webp) */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export const FileAttachmentSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  filename: z.string().optional(),
  size: z.number().optional(),
});

// File attachment (file path - preferred)
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

export const FileOutputEventSchema = z.object({
  type: z.literal("file_output"),
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});
export type FileOutputEvent = z.infer<typeof FileOutputEventSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), data: z.string() }),
  z.object({ type: z.literal("thinking"), data: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean(),
    details: z.object({ diff: z.string().optional() }).optional(),
  }),
  z.object({ type: z.literal("tool_start"), toolName: z.string() }),
  z.object({
    type: z.literal("tool_end"),
    toolName: z.string(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("done"),
    meta: z
      .object({
        durationMs: z.number(),
        aborted: z.boolean().optional(),
        queued: z.boolean().optional(),
      })
      .optional(),
  }),
  FileOutputEventSchema,
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

// WebSocket protocol types
export type WsSendMessage = {
  type: "send";
  agentId: string;
  sessionId?: string; // explicit session ID (bypasses sessionKey resolution)
  sessionKey?: string; // logical key (resolved to sessionId with idle timeout)
  message: string;
  attachments?: FileAttachment[]; // file attachments (paths from /api/media/upload)
  thinkLevel?: ThinkLevel; // per-request think level override
};

export type WsSubscribeMessage = {
  type: "subscribe";
  agentId: string;
  sessionKey: string;
  sessionId?: string;
};

export type WsUnsubscribeMessage = {
  type: "unsubscribe";
};

export type WsSubscribeStatusMessage = {
  type: "subscribeStatus";
};

export type WsUnsubscribeStatusMessage = {
  type: "unsubscribeStatus";
};

export type WsClientMessage =
  | WsSendMessage
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsSubscribeStatusMessage
  | WsUnsubscribeStatusMessage;

// Server messages include stream events plus subscription-specific events
export type WsHistoryUpdatedEvent = {
  type: "history_updated";
  agentId: string;
  sessionId: string;
};

export type WsSessionResetEvent = {
  type: "session_reset";
  sessionId: string;
};

export type WsStatusEvent = {
  type: "status";
  agentId: string;
  /** Agent-wide aggregate status (streaming if any session is streaming). */
  status: "streaming" | "idle";
  /** The specific session whose streaming state changed. */
  sessionId: string;
  /** Streaming status of that specific session. */
  sessionStatus: "streaming" | "idle";
};

export type WsFileChangedEvent = {
  type: "file_changed";
  projectId: string;
  file: string;
};

export type WsAgentChangedEvent = {
  type: "agent_changed";
  projectId: string;
};

export type WsSubagentChangedEvent = {
  type: "subagent_changed";
  runId: string;
  parent?: SubagentParent;
  status: SubagentRunStatus;
};

export type WsActiveTurnSnapshot = {
  type: "active_turn";
  agentId: string;
  sessionId: string;
  userText: string | null;
  userTimestamp: number;
  startedAt: number;
  thinking: string;
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: unknown;
    status: "running" | "done" | "error";
  }>;
};

export type WsServerMessage =
  | StreamEvent
  | WsHistoryUpdatedEvent
  | WsSessionResetEvent
  | WsStatusEvent
  | WsFileChangedEvent
  | WsAgentChangedEvent
  | WsSubagentChangedEvent
  | LeadSessionChangedEvent
  | WsActiveTurnSnapshot;

// History types

/** Simple history message (text only) */
export type SimpleHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  files?: FileBlock[];
  timestamp: number;
};

/** Content block types for full history */
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
};

export type FileBlock = {
  type: "file";
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  direction: "inbound" | "outbound";
};

export type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | ToolCallBlock
  | FileBlock;

/** Model usage info */
export const ModelUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  totalTokens: z.number(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export type ContextEstimate = {
  usedTokens: number;
  maxTokens: number;
  pct: number;
  basis: string;
  available: boolean;
  reason?: string;
};

/** Model metadata for assistant messages */
export type ModelMeta = {
  api?: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  stopReason?: string;
};

/** Full history message with all content blocks */
export type FullHistoryMessage =
  | {
      role: "system";
      content: ContentBlock[];
      timestamp: number;
      context?: AgentContext;
    }
  | {
      role: "user";
      content: ContentBlock[];
      timestamp: number;
    }
  | {
      role: "assistant";
      content: ContentBlock[];
      timestamp: number;
      meta?: ModelMeta;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: ContentBlock[];
      isError: boolean;
      details?: { diff?: string };
      timestamp: number;
    };

export type HistoryViewMode = "simple" | "full";

// Discord context types for runAgent()
export type ChannelConversationType =
  | "direct_message"
  | "channel_message"
  | "thread_reply";

export type ChannelContextMetadata = {
  channel: "discord" | "slack" | "telegram" | "irc";
  place: string;
  conversationType: ChannelConversationType;
  sender: string;
};

export type DiscordContextBlock =
  | {
      type: "metadata";
      channel: "discord";
      place: string;
      conversationType: ChannelConversationType;
      sender: string;
    }
  | { type: "channel_topic"; topic: string }
  | { type: "channel_name"; name: string }
  | { type: "thread_name"; name: string }
  | {
      type: "thread_starter";
      author: string;
      content: string;
      timestamp: number;
    }
  | {
      type: "history";
      messages: Array<{ author: string; content: string; timestamp: number }>;
    }
  | {
      type: "reaction";
      emoji: string;
      user: string;
      messageId: string;
      action: "add" | "remove";
    };

export type DiscordContext = {
  kind: "discord";
  blocks: DiscordContextBlock[];
};

export type SlackContextBlock =
  | {
      type: "metadata";
      channel: "slack";
      place: string;
      conversationType: ChannelConversationType;
      sender: string;
    }
  | { type: "channel_topic"; topic: string }
  | { type: "channel_name"; name: string }
  | { type: "thread_name"; name: string }
  | {
      type: "thread_starter";
      author: string;
      content: string;
      timestamp: number;
    }
  | { type: "proactive_dm_notes"; notes: string[] }
  | {
      type: "history";
      messages: Array<{ author: string; content: string; timestamp: number }>;
    }
  | {
      type: "reaction";
      emoji: string;
      user: string;
      messageId: string;
      action: "add" | "remove";
    };

export type SlackContext = {
  kind: "slack";
  blocks: SlackContextBlock[];
};

export type TelegramContextBlock =
  | {
      type: "metadata";
      channel: "telegram";
      place: string;
      conversationType: ChannelConversationType;
      sender: string;
    }
  | {
      type: "history";
      messages: Array<{ author: string; content: string; timestamp: number }>;
    };

export type TelegramContext = {
  kind: "telegram";
  blocks: TelegramContextBlock[];
};

export type IrcContext = {
  kind: "irc";
  blocks: Array<
    | {
        type: "metadata";
        channel: "irc";
        place: string;
        conversationType: ChannelConversationType;
        sender: string;
      }
    | {
        type: "history";
        messages: Array<{ author: string; content: string; timestamp: number }>;
      }
  >;
};

export type UserContext = {
  kind: "web";
  name?: string;
};

export type AgentContext =
  | DiscordContext
  | SlackContext
  | TelegramContext
  | IrcContext
  | UserContext;

const ContextHistoryBlockSchema = z.object({
  type: z.literal("history"),
  messages: z.array(
    z.object({
      author: z.string(),
      content: z.string(),
      timestamp: z.number(),
    })
  ),
});

const ContextMetadataBlockSchema = z.object({
  type: z.literal("metadata"),
  channel: z.enum(["discord", "slack", "telegram", "irc"]),
  place: z.string(),
  conversationType: z.enum(["direct_message", "group", "channel", "thread"]),
  sender: z.string(),
});

const RichContextBlockSchema = z.union([
  ContextMetadataBlockSchema,
  ContextHistoryBlockSchema,
  z.object({ type: z.literal("channel_topic"), topic: z.string() }),
  z.object({ type: z.literal("channel_name"), name: z.string() }),
  z.object({ type: z.literal("thread_name"), name: z.string() }),
  z.object({
    type: z.literal("thread_starter"),
    author: z.string(),
    content: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("proactive_dm_notes"),
    notes: z.array(z.string()),
  }),
  z.object({
    type: z.literal("reaction"),
    emoji: z.string(),
    user: z.string(),
    messageId: z.string(),
    action: z.enum(["add", "remove"]),
  }),
]);

export const AgentContextSchema: z.ZodType<AgentContext> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("discord"),
      blocks: z.array(RichContextBlockSchema),
    }),
    z.object({
      kind: z.literal("slack"),
      blocks: z.array(RichContextBlockSchema),
    }),
    z.object({
      kind: z.literal("telegram"),
      blocks: z.array(
        z.union([ContextMetadataBlockSchema, ContextHistoryBlockSchema])
      ),
    }),
    z.object({
      kind: z.literal("irc"),
      blocks: z.array(
        z.union([ContextMetadataBlockSchema, ContextHistoryBlockSchema])
      ),
    }),
    z.object({ kind: z.literal("web"), name: z.string().optional() }),
  ]
) as z.ZodType<AgentContext>;

export const HistoryEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system_prompt"),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("user"),
    text: z.string(),
    attachments: z.array(FileAttachmentSchema).optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("assistant_text"),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("assistant_thinking"),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("assistant_file"),
    fileId: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    direction: z.enum(["inbound", "outbound"]),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    args: z.unknown(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean(),
    details: z.object({ diff: z.string().optional() }).optional(),
    timestamp: z.number(),
  }),
  z.object({ type: z.literal("turn_end"), timestamp: z.number() }),
  z.object({
    type: z.literal("meta"),
    provider: z.string().optional(),
    model: z.string().optional(),
    api: z.string().optional(),
    usage: ModelUsageSchema.optional(),
    stopReason: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("system_context"),
    context: AgentContextSchema,
    rendered: z.string(),
    timestamp: z.number(),
  }),
]);
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const ContainerFileOutputRequestSchema = z.object({
  type: z.literal("file_output"),
  path: z.string(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});
export type ContainerFileOutputRequest = z.infer<
  typeof ContainerFileOutputRequestSchema
>;

export const ContainerRunnerProtocolEventSchema = z.discriminatedUnion("type", [
  ...HistoryEventSchema.options,
  ContainerFileOutputRequestSchema,
]);
export type ContainerRunnerProtocolEvent = z.infer<
  typeof ContainerRunnerProtocolEventSchema
>;

export const ContainerExtensionToolSchema = z.object({
  extensionId: z.string(),
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});
export type ContainerExtensionTool = z.infer<
  typeof ContainerExtensionToolSchema
>;

export const ContainerSystemFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type ContainerSystemFile = z.infer<typeof ContainerSystemFileSchema>;

export const ContainerInputSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  userId: z.string().optional(),
  message: z.string(),
  attachments: z.array(FileAttachmentSchema).optional(),
  workspaceDir: z.string(),
  sessionDir: z.string(),
  ipcDir: z.string(),
  gatewayUrl: z.string(),
  agentToken: z.string(),
  thinkLevel: ThinkLevelSchema.optional(),
  context: AgentContextSchema.optional(),
  systemFiles: z.array(ContainerSystemFileSchema).optional(),
  extensionSystemPrompts: z.array(z.string()).optional(),
  extensionTools: z.array(ContainerExtensionToolSchema).optional(),
  onecli: z
    .object({
      enabled: z.boolean(),
      url: z.string(),
      caPath: z.string().optional(),
    })
    .optional(),
  sdkConfig: z.object({
    sdk: SdkIdSchema,
    model: AgentModelConfigSchema,
  }),
});
export type ContainerInput = z.infer<typeof ContainerInputSchema>;

export const ContainerOutputSchema = z.object({
  text: z.string(),
  aborted: z.boolean().optional(),
  history: z.array(HistoryEventSchema).optional(),
  error: z.string().optional(),
});
export type ContainerOutput = z.infer<typeof ContainerOutputSchema>;

// Heartbeat event payload (for event emission)
export const HeartbeatStatusSchema = z.enum([
  "sent",
  "ok-empty",
  "ok-token",
  "skipped",
  "failed",
]);
export type HeartbeatStatus = z.infer<typeof HeartbeatStatusSchema>;

export type HeartbeatEventPayload = {
  ts: number;
  agentId: string;
  status: HeartbeatStatus;
  to?: string; // Discord channel ID
  preview?: string; // First 200 chars of alert
  alertText?: string; // Full alert text (for delivery)
  durationMs?: number;
  reason?: string; // Why it skipped/failed
};

// Taskboard types
export type TodoItem = {
  id: string;
  title: string;
  status: "todo";
  created?: string;
  due?: string;
  path: string;
};

export type ProjectItem = {
  id: string;
  title: string;
  status: "todo" | "doing";
  created?: string;
  due?: string;
  project?: string;
  path: string;
  companions: string[];
};

export type TaskboardResponse = {
  todos: {
    todo: TodoItem[];
    doing: TodoItem[];
  };
  projects: {
    todo: ProjectItem[];
    doing: ProjectItem[];
  };
};

export type TaskboardItemResponse = {
  id: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  companions: string[];
};

// Attachment upload types
export type UploadedAttachment = {
  originalName: string;
  savedName: string;
  path: string;
  isImage: boolean;
};

export const UploadAttachmentResponseSchema = z.array(
  z.object({
    originalName: z.string(),
    savedName: z.string(),
    path: z.string(),
    isImage: z.boolean(),
  })
);
export type UploadAttachmentResponse = z.infer<
  typeof UploadAttachmentResponseSchema
>;
