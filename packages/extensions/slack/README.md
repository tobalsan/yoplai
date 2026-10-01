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
| `slack.get_channel_history` | Retrieve channel history by conversation ID (`C...`, `D...`, or `G...`) in newest-first order. Page backward by passing the previous result's oldest `ts` as `latest`. Thread metadata identifies threads; use `slack.get_thread_replies` to read them. Backed by the `conversations.history` Web API. |
| `slack.get_thread_replies` | Read a thread by conversation ID and parent `threadTs`, including the parent, in oldest-first order. Supports `limit`, `oldest`, `latest`, and `inclusive`; pass `nextCursor` as `cursor` until `hasMore` is false. Backed by the `conversations.replies` Web API. |
| `slack.canvas_list` | List canvases visible to the bot, optionally by channel, with page-based paging (`files.list` with `types=canvas`). |
| `slack.canvas_create` | Create a canvas from optional Markdown. Without `channel` it is private to the bot; share it with `slack.canvas_share`. |
| `slack.canvas_read` | Read a canvas (ID or URL) as Slack HTML (`files.info` + authenticated download), truncated to `maxChars`. Element ids are section ids for editing. |
| `slack.canvas_find_sections` | Find section ids by header type or contained text (`canvases.sections.lookup`). |
| `slack.canvas_edit` | Insert, replace, or delete canvas Markdown by section (`canvases.edit`). |
| `slack.canvas_share` | Grant channels or users read or write access (`canvases.access.set`). |
| `slack.canvas_delete` | Delete a canvas (`canvases.delete`). |
| `slack.list_lists` | List Slack Lists visible to the bot, optionally by channel, with page-based paging (`files.list` with `types=list`; undocumented by Slack but verified live). |
| `slack.list_read` | Read Slack List rows and, when non-empty, column IDs, names, types, and select choices needed for updates. |
| `slack.list_update_cells` | Update up to 100 typed cells in Slack List rows. |
| `slack.list_item_create` | Create a Slack List row with typed initial cell values. |
| `slack.list_item_delete` | Delete a Slack List row. |

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

## Scheduler delivery

This extension registers a delivery sink under id `"slack"` for the scheduler's
`deliver` feature (see the [scheduler README](../scheduler/README.md)). A job's
`deliver` entry maps `channel` to a Slack channel ID and `user` to a Slack user
ID (passed as the `channel` param on `chat.postMessage`, which is how Slack
DMs). The sink shares `slack.send_message`'s send path (chunking, mrkdwn
conversion, and the proactive-DM note), so a delivered cron result behaves the
same as a manual send for these purposes.

```json
"deliver": [{ "target": "slack", "channel": "C0123456789" }]
```

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

## Account pairing

With multi-user web sign-in enabled, send `!pair` to the bot in an allowed channel,
thread, or DM. The bot replies privately with a single-use link that expires after
ten minutes. Open it, sign in to your **existing** Yoplai account, check the Slack
identity shown, and select **Connect Slack**. Pairing never creates a Yoplai account.
Subsequent requests resolve your personal credentials first, then team credentials;
unpaired Slack users only use team credentials. Every sender in a shared thread
is resolved independently, including reactions and control commands.

Your Slack and Yoplai emails must be the same (comparison ignores case and outer
whitespace). Different emails intentionally cannot pair. A forwarded link cannot
pair to a recipient with a different email: the server fetches the original
Slack user's email again at redemption and refuses mismatches. Hidden/missing
email, Slack API errors, or timeouts also refuse pairing; no unchecked fallback.

Administrators: enable web login, configure the public UI URL (`server.baseUrl`,
or `web.baseUrl` when the former is unset),
and grant the bot `users:read` and **`users:read.email`**, reinstalling the Slack
app after changing scopes. Pairing records and hashed expiring tokens live in
`$YOPLAI_HOME/slack-pairing.db`; no Slack token is stored there.

A future alternative is **Sign in with Slack** (Slack OpenID Connect): redirect
from Yoplai to Slack, then pair only when Slack's verified user ID equals the
link's original user ID. This supports differing emails, but needs Slack sign-in
scopes, a redirect URL, and one extra first-use consent click; it is not implemented.

## Required OAuth scopes

The bot token needs scopes matching the features you use:

| Feature | Scopes |
| --- | --- |
| `slack.create_thread`, `slack.send_message` | `chat:write` (and `chat:write.public` to post to channels the bot has not joined) |
| `slack.list_channels` | `channels:read` (public), `groups:read` (private) |
| `slack.list_users` | `users:read` |
| `!pair` account pairing | `users:read`, `users:read.email` |
| `slack.get_channel_history`, `slack.get_thread_replies` | `channels:history` (public), `groups:history` (private), `im:history` (DM), `mpim:history` (group DM) |
| Canvas tools | `canvases:read`, `canvases:write`, `files:read` (reading content) |
| Lists tools | `files:read` (`slack.list_lists`), `lists:read` (`slack.list_read`), `lists:write` (create, update, delete); Slack Lists require a paid workspace plan |
| Socket Mode events | `app_mentions:read`, `channels:history`, `im:history`, `reactions:read`, plus an app-level token (`xapp-...`) for `connections:write` |

`conversations.list` only returns private channels the bot is a member of.
Missing scopes surface as a `missing_scope` error in the tool result.
After adding Canvas or Lists scopes, reinstall the Slack app so the bot token receives them.

History and thread retrieval also require the bot to be a member of private channels and
DMs; scopes alone do not grant access. Both tools accept
conversation IDs (`C...`, `D...`, or `G...`), not user IDs, unlike the send
tools. Slack may restrict page sizes and rate-limit affected commercially
distributed apps to roughly one request per minute, so large requested limits
can require multiple API calls.
