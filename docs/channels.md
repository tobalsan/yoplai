# Messaging channels

Yoplai supports Discord, Slack, Telegram, Mattermost, and IRC. Shared transports configure under root `extensions`; some transports also support dedicated per-agent bots.

Never commit bot/app tokens. Put them in `$YOPLAI_HOME/.env` or agent-local `.env` and reference with `$env:`.

## Discord

Supports guild channels, DMs, forum threads, reactions, slash commands, proactive tools, and delivery.

```json
{
  "extensions": {
    "discord": {
      "enabled": true,
      "token": "$env:DISCORD_BOT_TOKEN",
      "channels": {
        "CHANNEL_ID": { "agent": "my-agent", "requireMention": true }
      },
      "dm": { "enabled": true, "agent": "my-agent" }
    }
  }
}
```

Create Discord application, enable Message Content Intent, grant required permissions, and configure token/application id. Full policies, reactions, forum behavior, and commands: [Discord guide](discord.md).

## Slack

Uses Bolt Socket Mode; no public callback URL is required for messages.

Prerequisites:

1. Create Slack app.
2. Enable Socket Mode.
3. Create app-level `xapp-` token with `connections:write`.
4. Install app and obtain bot `xoxb-` token.
5. Add scopes needed for mentions/history/chat/files/DM/reactions/users/commands.

```json
{
  "extensions": {
    "slack": {
      "enabled": true,
      "token": "$env:SLACK_BOT_TOKEN",
      "appToken": "$env:SLACK_APP_TOKEN",
      "channels": {
        "C01ABCDEF": {
          "agent": "my-agent",
          "requireMention": false,
          "threadPolicy": "always"
        }
      },
      "dm": { "enabled": true, "agent": "my-agent" }
    }
  }
}
```

Thread policy values are `always`, `never`, and `follow`. Channel/user allowlists, reaction notifications, thinking display, files, proactive threads, and per-agent bots are supported. Slash commands include `/new`, `/stop`, `/help`, and `/ping`; add them to Slack app manifest. Full reference: [Slack README](../packages/extensions/slack/README.md).

## Telegram

Telegram supports private/group routing and proactive delivery. Configure bot token/routing per [Telegram README](../packages/extensions/telegram/README.md).

## Mattermost

Works with self-hosted Mattermost and Mattermost Cloud (tested on 12.0). The bot is a Mattermost bot account; it listens on the WebSocket API and replies over REST, so it needs no public URL, slash command, or plugin.

```json
{
  "extensions": {
    "mattermost": {
      "enabled": true,
      "url": "https://chat.example.com",
      "token": "$env:MATTERMOST_BOT_TOKEN",
      "channels": {
        "CHANNEL_ID": { "agent": "my-agent", "requireMention": true }
      },
      "dm": { "enabled": true, "agent": "my-agent" }
    }
  }
}
```

Only the channels listed under `channels` are served; posts anywhere else are ignored. Each channel exchange is threaded, and each thread is one durable agent session. A dedicated bot per agent goes in the agent's `agent.yaml` as `mattermost: { url, token, channels, dm }`.

Server setup, as a system admin:

1. **Allow bot accounts.** System Console › Integrations › Bot Accounts › _Enable Bot Account Creation_: true.
2. **Create the bot.** Product menu › Integrations › Bot Accounts › _Add Bot Account_. Pick a username (people will mention it, e.g. `@yoplai`), a display name, and a description. Keep the role _Member_. Leave `post:all` and `post:channels` unchecked: the bot only posts where it is a member.
3. **Copy the token.** Mattermost shows the bot's access token once, after creation. Put it in `$YOPLAI_HOME/.env` (or the agent's `.env`) as `MATTERMOST_BOT_TOKEN=...` and reference it as `$env:MATTERMOST_BOT_TOKEN`. To replace it later, use _Create New Token_ on the bot's card, then delete the old one.
4. **Add the bot to teams and channels.** A bot created from a team's Integrations page is in that team. Add it to other teams from System Console › User Management › Teams › _Add Members_. In each channel it should serve, public or private, run `/invite @yoplai` or use _Add Members_.
5. **Find the channel ID.** Channel name › _View Info_, or the channel's ⋮ menu. Put it under `channels`.
6. **Direct messages.** People open a DM with the bot like with anyone. Set `dm.agent` (shared bot) or a `dm` block (per-agent bot). Use `dm.allowFrom` to restrict who may write.

Behind a reverse proxy, `/api/v4/websocket` must pass WebSocket upgrades (the Mattermost web app needs this too). Mentions, threads, `!new`, reactions, files, reconnection, tools, and delivery are in the [Mattermost README](../packages/extensions/mattermost/README.md).

## IRC

IRC supports TLS/plain connections, channel and DM routing, mention/reply-all policies, batching, context, and safe reply formatting. See [IRC README](../packages/extensions/irc/README.md).

## Threadit

Threadit is a polling channel: an agent with a Threadit agent-account token answers messages that mention it or reply to it. Configure `extensions.threadit.token` (`$env:THREADIT_TOKEN`) in `agent.yaml` and `baseUrl` in the agent or root `extensions.threadit`. Replies, 👀/✅ reactions, activities, stop requests, and restart recovery are described in the [Threadit README](../packages/extensions/threadit/README.md).

## Channel context

Inbound Slack/Discord/Mattermost runs append normalized channel context to system prompt and canonical history, including source, place, conversation type, sender, and available thread/history metadata. Gateway/web/CLI runs do not receive messaging channel context.

## Proactive delivery

Scheduler jobs can deliver results to registered Discord, Slack, Telegram, or Mattermost sinks. Agent tools may also send messages/create threads where extension permits. Missing/failed delivery target is recorded without changing scheduler run outcome.

## Heartbeat

Heartbeat alerts use configured transport and requires scheduler. See [Scheduling](scheduling.md).
