# Mattermost Extension

Connects Yoplai agents to a Mattermost server (self-hosted or Cloud): channel
mentions, threads, direct messages, files, proactive posts, and scheduler
delivery. Tested against Mattermost 12.0.

The bot is a Mattermost **bot account**. It receives events over the
WebSocket API (`/api/v4/websocket`, event `posted`) and replies over the REST
API (`POST /api/v4/posts`). It needs no public URL, slash command, or plugin.

Server setup (bot account, token, teams and channels) is in
[docs/channels.md](../../../docs/channels.md#mattermost).

## Enable / disable

The extension runs in two modes; both can be active at once. Presence of config
is the enable signal.

### Shared bot

One bot account serves several agents. Each channel names its agent, and DMs go
to `dm.agent`. Configure it in `yoplai.json`:

```json
{
  "extensions": {
    "mattermost": {
      "enabled": true,
      "url": "https://chat.example.com",
      "token": "$env:MATTERMOST_BOT_TOKEN",
      "channels": {
        "CHANNEL_ID": { "agent": "support", "requireMention": true },
        "OTHER_CHANNEL_ID": { "agent": "ops", "requireMention": false }
      },
      "dm": { "enabled": true, "agent": "support" }
    }
  }
}
```

`enabled: false` is a runtime kill switch: the extension still loads (so agent
tools stay listed), but the bot does not connect.

### Per-agent bot

An agent can have its own bot account. Add a `mattermost` block to its
`agent.yaml`; channel entries have no `agent` field:

```yaml
mattermost:
  url: https://chat.example.com
  token: $env:MATTERMOST_BOT_TOKEN
  channels:
    CHANNEL_ID: { requireMention: false }
  dm:
    enabled: true
    allowFrom: [alice, bob]
```

A per-agent bot answers DMs only when `dm` is present.

### Settings

| Key                            | Default                 | Meaning                                                                                 |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------------------------- |
| `url`                          | required                | Server URL, `http://` or `https://`. A trailing `/api/v4` is ignored.                   |
| `token`                        | required                | Bot access token. Always a `$env:` reference; never the literal token.                  |
| `channels.<id>.agent`          | required (shared bot)   | Agent that answers in this channel.                                                     |
| `channels.<id>.requireMention` | `true`                  | Answer only posts that mention the bot. With `false`, answer every post.                |
| `channels.<id>.threadUnlock`   | `false`                 | Once the bot has answered in a thread, later replies there need no mention.             |
| `channels.<id>.users`          | everyone                | Only these senders (user IDs or usernames).                                             |
| `dm.enabled`                   | `true` when `dm` is set | Answer direct messages.                                                                 |
| `dm.agent`                     | —                       | Shared bot: the agent that answers DMs. Without it, DMs are ignored.                    |
| `dm.allowFrom`                 | everyone                | Only these senders may DM the bot (user IDs or usernames).                              |
| `acknowledgeMessages`          | `true`                  | 👀 on an accepted post, then ✅ or ❌.                                                  |
| `attachmentsEnabled`           | `true`                  | Pass files attached to posts to the agent.                                              |
| `allowBots`                    | `false`                 | Answer other bots (`true`, or a list of bot user IDs). They must still mention the bot. |

## Behavior

- **Allowlist.** Only channels listed under `channels` are served. Posts in any
  other channel are ignored, even when they mention the bot.
- **Who is ignored.** The bot's own posts, system posts (joins, header
  changes…), and posts from bots, webhooks and plugins (unless `allowBots`).
- **Mentions.** In channels the bot answers when mentioned (`@botname`), or
  every post with `requireMention: false`. DMs need no mention.
- **Threads are sessions.** Every channel exchange happens in a thread: the bot
  replies under the post that mentioned it, or in the thread it was written in.
  Each thread is one durable agent session (key
  `mattermost:<channelId>:<rootPostId>`), recorded in `mattermost-thread-sessions.db` so it
  survives gateway restarts. If the session has disappeared, the thread gets a
  new one in the same owner's storage. Agent-started threads keep the calling
  session and its owner, including after a gateway restart; inbound threads
  use shared storage. Mattermost senders do not gain the owner's credentials.
- **DMs** use the agent's main session, as on Discord, Slack and Telegram. The
  reply is flat, or in the thread if the user wrote in one.
- **Reset.** `!new` or `!reset` clears the conversation (the thread's session,
  or the DM main session). Slash commands are not used: Mattermost would treat
  them as its own. In an agent-started thread, this also clears the originating
  web or scheduler conversation, then binds a fresh session to the same owner.
- **Feedback.** "is typing…" is shown while the agent works, and the post gets
  👀, then ✅ or ❌. These best-effort indicators never delay the agent or its answer.
- **Long answers** are split into posts of at most 15,000 characters (the server
  limit is 16,383), cut at paragraph or line boundaries. Code blocks cut in two
  are closed and reopened.
- **Files.** Images, PDF, text, Markdown, CSV, JSON and Office files (up to
  25 MB) attached to a post are passed to the agent; other files get a short
  note. Files the agent produces are uploaded to the same thread.
- **Busy session.** A post sent while the agent is still answering in the same
  thread is queued. Its answer is posted when it comes; typing and 👀 are cleared
  while it waits.

## Connection

- The token is sent only in the `Authorization` header (REST and WebSocket). It
  never appears in a URL, an error message or the logs.
- After a drop the bot reconnects with an exponential backoff (1 s doubling to
  60 s, ±20 % jitter). It also drops and reconnects a connection silent for 75 s.
- **Resume without duplicates.** On reconnect the bot sends back Mattermost's
  `connection_id` and the next `sequence_number`, so the server replays missed
  events. If the server cannot (restart, long outage), the bot re-reads the
  configured channels and the DMs it knows over REST, up to 10 minutes back.
  After a silent loss, recovery starts from the last received traffic, with a
  five-second overlap and the same ten-minute cap. Recovered posts resolve the
  canonical sender username before the same allowlist gate used for live posts.
  Accepted post IDs are deduplicated in memory across live and recovered events;
  this is not durable exactly-once delivery.
- REST operations have one deadline across retries and response reads: 30 seconds
  normally, 120 seconds for file transfers. Cancelled tools abort in-flight calls
  and stop before subsequent requests; they cannot retract an accepted post.

## Agent tools

- `mattermost.send_message` — post to a configured channel (`channel`), a thread
  in it (`rootId`), or a user's DMs (`user`, an ID or username). Proactive use
  only: the answer to an inbound post is delivered automatically.
- `mattermost.create_thread` — start a thread in a configured channel and bind it
  to the calling session. Replies in that thread continue that session, without
  a mention.

The tools obey the same allowlist as inbound posts:

- A shared-bot agent can post only in channels routed to it, and DM only when
  `dm.agent` is that agent.
- A per-agent bot can post only in its own `channels`, and DM only when `dm` is
  enabled.

## Delivery sink

Registers as delivery sink id `mattermost` for scheduler `deliver` targets:

```json
{ "target": "mattermost", "channel": "CHANNEL_ID" }
{ "target": "mattermost", "channel": "CHANNEL_ID:ROOT_POST_ID" }
{ "target": "mattermost", "user": "alice" }
```

- `channel` posts to the channel, or into a thread with `CHANNEL_ID:ROOT_POST_ID`.
- `user` sends a DM.
- The sink uses the same path and checks as `mattermost.send_message`. It throws
  on failure, and the scheduler records that as a delivery warning.

## Not supported (yet)

- Streaming the answer by editing the post as it is written. The answer is
  posted when the turn ends; the typing indicator shows progress.
- Tool-call notes (`showToolCalls`), interactive buttons, slash commands, and
  reacting to emoji reactions.
- Channel history beyond the thread itself: the agent sees the thread's first
  post and its own session, not the rest of the channel.
