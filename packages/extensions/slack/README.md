# Slack Extension

Connects Yoplai agents to Slack over Socket Mode. Routes channel messages,
direct messages, app mentions, and reactions to agents, and exposes agent tools
for proactively sending Slack messages.

## Enable / disable

The extension runs in two modes; both can be active at once.

### Component bot (shared)

One bot shared across agents, configured under `extensions.slack` in `yoplai.json`:

```json
{
  "extensions": {
    "slack": {
      "enabled": true,
      "token": "xoxb-...",
      "appToken": "xapp-...",
      "channels": {
        "C0123456789": { "agent": "main", "requireMention": false }
      },
      "dm": { "enabled": true, "agent": "main" }
    }
  }
}
```

`enabled: false` is a runtime kill switch: the extension still loads (so agent
tools remain available), but the component bot does not start.

### Per-agent bot

An agent can run its own bot with a dedicated app/token. Agent config now lives
in each agent's own folder as `agent.yaml`, so add a `slack` block there:

```yaml
# <agent-workspace>/agent.yaml
id: main
name: Main
model:
  provider: anthropic
  model: claude
slack:
  token: xoxb-...
  appToken: xapp-...
  channels:
    C0123456789:
      requireMention: false
  dm:
    enabled: true
```

## Routing

- **Channels** — keys under `channels` are Slack channel IDs (`C...`), with
  optional `requireMention`, `threadPolicy` (`always` | `never` | `follow`),
  and a `users` allowlist. In the component bot each channel also takes an
  `agent` to route to; in a per-agent bot the agent is implied.
- **Direct messages** — the component bot routes DMs via `dm.agent`; a per-agent
  bot just needs `dm.enabled`. Restrict senders with `dm.allowFrom`.
- **Mentions / reactions** — `app_mention`, `reaction_added`, and
  `reaction_removed` events are routed to the resolved agent.

Other options: `historyLimit`, `clearHistoryAfterReply`, `mentionPatterns`,
`broadcastToChannel`, `showThinking`, `deleteThinkingOnComplete`.

## Agent tools

The extension contributes tools (via `getAgentTools`) to every agent, letting
agents **proactively** send Slack messages — independent of an inbound message.
This is the path used by scheduled jobs.

| Tool | Purpose |
| --- | --- |
| `slack.create_thread` | Post a thread parent to a channel ID (`C...`) or user ID (`U...`, delivered as a DM), bind it to the active agent session, and return the resolved channel + parent timestamp for follow-up replies. |
| `slack.send_message` | Post to a channel ID (`C...`) or user ID (`U...`, delivered as a DM). DM sends leave a one-time visibility note for the main session when that user replies. Supports an optional `threadTs` to reply in a thread. Markdown is converted to Slack mrkdwn and long messages are chunked. |
| `slack.list_channels` | List channel IDs + names (filterable by name substring) so agents can resolve/remember IDs. Backed by the `conversations.list` Web API. |
| `slack.list_users` | List user IDs + display names (filterable) for DM targeting. Backed by the `users.list` Web API. |

### Bound thread handoffs

`slack.create_thread` is the handoff tool for scheduled or proactive work. It
posts the parent message first, then stores a binding from `(channel, parent
timestamp, agent)` to the active session. A later human reply in that Slack
thread resumes the bound session, rather than using normal channel or DM
routing. Bound replies stay in that same thread even if the channel's
`threadPolicy` is `never`.

The tool accepts either a channel ID or a user ID. A user ID opens a Slack DM;
the returned `channel` is the resolved DM channel ID, and `ts` is its parent
timestamp. Proactive DM sends made with `slack.send_message` leave a one-time
visibility note in the agent's main session on the recipient's next top-level
DM reply. A reply to a thread created with `slack.create_thread` instead
follows the thread binding and resumes the bound session; it does not leak into
the main session.

See [the Slack thread cron example](../../../docs/examples/slack-thread-cron.md)
for a complete scheduled handoff.

### Client resolution

When a tool runs, it resolves a Slack Web API client in this order:

1. The live **per-agent** bot client (`getActiveBot(agent.id)`), if running.
2. The live **component** bot client (`getActiveBot("slack")`), if running.
3. A token-only `@slack/web-api` `WebClient` built from the agent's `slack.token`
   (in `agent.yaml`), falling back to `extensions.slack.token`.

Step 3 means proactive sends work even when no Socket Mode bot is listening
(e.g. a scheduled job firing a digest). If no token is configured for the
agent, the tools return `{ ok: false, error }`.

`enabled: false` only stops the bot from listening — the agent tools still
function via the token fallback.

## Required OAuth scopes

The bot token needs scopes matching the features you use:

| Feature | Scopes |
| --- | --- |
| `slack.create_thread`, `slack.send_message` | `chat:write` (and `chat:write.public` to post to channels the bot has not joined) |
| `slack.list_channels` | `channels:read` (public), `groups:read` (private) |
| `slack.list_users` | `users:read` |
| Socket Mode events | `app_mentions:read`, `channels:history`, `im:history`, `reactions:read`, plus an app-level token (`xapp-...`) for `connections:write` |

`conversations.list` only returns private channels the bot is a member of.
Missing scopes surface as a `missing_scope` error in the tool result.
