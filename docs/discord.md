# Discord Integration

Connect your agent to Discord with support for guilds, DMs, reactions, slash commands, and forum-channel threads.

Replies stream by default: Discord posts the first agent text immediately and edits it as the turn continues. Accepted messages receive a 👀 reaction until the reply is posted or another terminal path takes ownership of delivery. Images, PDFs, and supported Office files (up to 25 MB) are forwarded to the agent; attachment-only DMs are accepted.

## Prerequisites

1. Create a Discord application at https://discord.com/developers/applications
2. Create a bot and copy the **Bot Token**
3. Enable **Message Content Intent** under Bot settings
4. Copy the **Application ID** (for slash commands)
5. Invite bot to your server with permissions: Send Messages, Read Message History, Add Reactions, and Create Public Threads if you use forum channels

## Basic Setup

Minimal config - bot responds to all messages where it's mentioned:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "discord": {
        "token": "YOUR_BOT_TOKEN"
      }
    }
  ]
}
```

## Configuration Examples

### Channel-Specific Settings

Configure different behavior per channel:

```json
{
  "discord": {
    "token": "...",
    "groupPolicy": "allowlist",
    "guilds": {
      "GUILD_ID": {
        "requireMention": true,
        "channels": {
          "CHANNEL_1": { "enabled": true, "requireMention": false },
          "CHANNEL_2": { "enabled": true, "users": ["USER_ID"] },
          "CHANNEL_3": { "enabled": false }
        }
      }
    }
  }
}
```

**Channel behavior depends on `groupPolicy`:**

- `allowlist`: Only channels explicitly listed in config are allowed. Unlisted channels are rejected.
- `open`: All channels allowed unless `enabled: false`.

### Multiple Guilds with Different Settings

```json
{
  "discord": {
    "token": "...",
    "guilds": {
      "GUILD_1": {
        "requireMention": true,
        "systemPrompt": "You are helping the engineering team."
      },
      "GUILD_2": {
        "requireMention": false,
        "users": ["USER_ID_1", "USER_ID_2"]
      }
    }
  }
}
```

### DMs Enabled with Allowlist

```json
{
  "discord": {
    "token": "...",
    "dm": {
      "enabled": true,
      "allowFrom": ["USER_ID_1", "USER_ID_2"]
    },
    "groupPolicy": "disabled"
  }
}
```

### Reaction Notifications

Get notified when users react to bot messages:

```json
{
  "discord": {
    "token": "...",
    "guilds": {
      "GUILD_ID": {
        "requireMention": true,
        "reactionNotifications": "own"
      }
    }
  }
}
```

Modes: `off` (default), `all`, `own` (bot's messages only), `allowlist`

### Slash Commands

Enable `/new`, `/abort`, `/help`, `/ping`:

```json
{
  "discord": {
    "token": "...",
    "applicationId": "YOUR_APPLICATION_ID"
  }
}
```

Commands deploy automatically on bot startup.

**Note:** `applicationId` is auto-detected from the bot token if not provided. Set it explicitly to avoid the API call on startup.

### Broadcast Mode

Mirror main session responses to a Discord channel (useful for monitoring):

```json
{
  "discord": {
    "token": "...",
    "broadcastToChannel": "CHANNEL_ID"
  }
}
```

Only broadcasts non-Discord sources (web UI, scheduler, amsg). Discord messages are never echoed back.

### Forum Channels

Agents can subscribe to Discord forum channels and use forum threads as resumable session handoff points:

```json
{
  "extensions": {
    "discord": {
      "token": "YOUR_BOT_TOKEN",
      "channels": {
        "123456789012345678": { "agent": "ops-agent", "requireMention": false }
      }
    }
  },
  "agents": [
    {
      "id": "ops-agent",
      "workspace": "~/agents/ops",
      "discord": {
        "forumChannels": ["123456789012345678"]
      }
    }
  ]
}
```

`forumChannels` is agent-level config. Each listed ID must be a Discord forum channel ID visible to the bot. In component-owned bot setups, the same forum channel should also be routable to that agent through `extensions.discord.channels` when the agent needs to create outbound forum threads with the component bot. Legacy per-agent bot setups can put the token on `agent.discord` instead.

Forum behavior:

- When Discord emits a newly created thread in a subscribed forum channel, Yoplai starts a fresh session for each subscribed agent and posts the agent response into that thread.
- Yoplai stores a binding from the Discord thread ID to the agent session ID. Later user replies in that thread resume the same session instead of starting a new channel session.
- Bot-authored and webhook messages are ignored. If a reply arrives in an unbound subscribed thread, Yoplai falls back to the new-thread spawn path and writes the binding once the run returns a session ID.
- Regular guild channels still use `discord:<channelId>` session isolation, and DMs still use `main`.

Agents also receive `discord.create_forum_thread(channel_id, title, body)`. The tool creates a new thread in the given forum channel, sends `body` as the starter post, binds the returned thread to the current agent session, and returns:

```json
{
  "thread_id": "DISCORD_THREAD_ID",
  "message_id": "STARTER_MESSAGE_ID"
}
```

That binding is what lets a user's reply in the created forum thread resume the scheduled or proactive session that opened it. See [Discord forum cron example](examples/discord-forum-cron.md) for the scheduler workflow.

## Full Config Reference

```json
{
  "discord": {
    "token": "string (required)",
    "applicationId": "string (enables slash commands)",
    "streamReplies": true,
    "acknowledgeMessages": true,
    "ackEmoji": "👀",
    "attachmentsEnabled": true,

    "dm": {
      "enabled": true,
      "allowFrom": ["USER_ID", "username"],
      "groupEnabled": false,
      "groupChannels": ["CHANNEL_ID"]
    },

    "groupPolicy": "open | disabled | allowlist",
    "guilds": {
      "GUILD_ID": {
        "slug": "friendly-name",
        "requireMention": true,
        "reactionNotifications": "off | all | own | allowlist",
        "reactionAllowlist": ["USER_ID"],
        "users": ["USER_ID", "username#1234"],
        "systemPrompt": "Custom prompt for this guild",
        "channels": {
          "CHANNEL_ID": {},
          "CHANNEL_ID_2": {
            "enabled": true,
            "requireMention": false,
            "users": ["USER_ID"],
            "systemPrompt": "Channel-specific prompt"
          }
        }
      }
    },

    "forumChannels": ["FORUM_CHANNEL_ID"],

    "historyLimit": 20,
    "clearHistoryAfterReply": true,
    "replyToMode": "off | first | all",
    "mentionPatterns": ["hey bot", "^!agent"],
    "broadcastToChannel": "CHANNEL_ID",
    "showToolCalls": false
  }
}
```

## Group Policy

`groupPolicy` controls how the bot handles guild (server) messages at both guild and channel level:

| Value            | Guilds                         | Channels                                       |
| ---------------- | ------------------------------ | ---------------------------------------------- |
| `open` (default) | All guilds allowed             | All channels allowed (unless `enabled: false`) |
| `disabled`       | No guilds allowed (DM-only)    | N/A                                            |
| `allowlist`      | Only guilds in `guilds` config | Only channels in `channels` config             |

Example - restrict to specific guilds:

```json
{
  "discord": {
    "token": "...",
    "groupPolicy": "allowlist",
    "guilds": {
      "GUILD_ID_1": { "requireMention": true },
      "GUILD_ID_2": { "requireMention": false }
    }
  }
}
```

## History & Reply Settings

### historyLimit

Number of recent channel messages included as context for the agent (default: 20). Set to 0 to disable.

### clearHistoryAfterReply

When `true` (default), clears the channel history buffer after the bot replies. This prevents the same messages from being included in subsequent requests.

### replyToMode

Controls whether bot responses use Discord's reply feature:

| Value           | Behavior                                        |
| --------------- | ----------------------------------------------- |
| `off` (default) | Send as normal message                          |
| `first`         | Reply to triggering message on first chunk only |
| `all`           | Reply to triggering message on every chunk      |

### showToolCalls

Opt-in tool-call visibility (default: off). When `true`, the agent's tool calls are surfaced as concise one-line plain-text notes posted live in the channel/thread while a turn runs, coalesced into throttled batches (≥1.5s apart, or sooner once 8 notes pile up). Notes drain before the final reply, which still posts last in order. Available on both the component (`extensions.discord`) and per-agent (`agent.discord`) config; absent/false behaves exactly as today (no notes). Mirrors the Telegram option.

## Behavior Notes

- **Channel defaults**: `enabled` defaults to `true`; `requireMention` inherits from guild (default `true`). Minimal config: `"CHANNEL_ID": {}`.
- **Session routing**: DMs share `main` session with web UI. Guild channels use isolated sessions (`discord:CHANNEL_ID`). Forum threads created by subscribed channels bind to the thread ID and resume the stored agent session on replies.
- **Mention gating**: When `requireMention: true`, bot only responds when @mentioned or `mentionPatterns` match.
- **User allowlists**: Accepts user IDs, usernames, or `username#discriminator`. Prefix with `discord:/user:` for explicit IDs.
- **Typing indicator**: Shows while agent is processing; stops on completion or after 30s timeout.
- **Acknowledgement cleanup**: The configured reaction is removed on streamed and non-streamed completion, failure, empty replies, and same-thread forum replies delivered by a Discord tool.
- **Message chunking**: Long responses split at 2000 chars, preserving code blocks.

## Slash Commands

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `/new [session]`   | Start new conversation (default: main) |
| `/abort [session]` | Stop current agent run                 |
| `/help`            | Show available commands                |
| `/ping`            | Bot health check                       |
