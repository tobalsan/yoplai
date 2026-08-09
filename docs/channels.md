# Messaging channels

Yoplai supports Discord, Slack, Telegram, and IRC. Shared transports configure under root `extensions`; some transports also support dedicated per-agent bots.

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

## IRC

IRC supports TLS/plain connections, channel and DM routing, mention/reply-all policies, batching, context, and safe reply formatting. See [IRC README](../packages/extensions/irc/README.md).

## Channel context

Inbound Slack/Discord runs append normalized channel context to system prompt and canonical history, including source, place, conversation type, sender, and available thread/history metadata. Gateway/web/CLI runs do not receive messaging channel context.

## Proactive delivery

Scheduler jobs can deliver results to registered Discord, Slack, or Telegram sinks. Agent tools may also send messages/create threads where extension permits. Missing/failed delivery target is recorded without changing scheduler run outcome.

## Heartbeat

Heartbeat alerts use configured transport and requires scheduler. See [Scheduling](scheduling.md).
