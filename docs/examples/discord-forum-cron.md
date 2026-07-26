# Discord Forum Cron Example

This example shows the scheduler handoff pattern for periodic human review:

1. A cron job wakes up an agent.
2. The agent opens a Discord forum thread with `discord.create_forum_thread(channel_id, title, body)`.
3. A user replies in that thread, and Yoplai resumes the same agent session.

## Configure Discord

Use a forum channel ID, not a text channel ID. The bot must be able to view the channel, create forum posts, send messages, and read message history.

```json
{
  "extensions": {
    "discord": {
      "token": "$env:DISCORD_BOT_TOKEN",
      "channels": {
        "123456789012345678": {
          "agent": "ops-agent",
          "requireMention": false
        }
      }
    },
    "scheduler": { "enabled": true }
  },
  "agents": [
    {
      "id": "ops-agent",
      "name": "Ops Agent",
      "workspace": "~/agents/ops-agent",
      "discord": {
        "forumChannels": ["123456789012345678"]
      }
    }
  ]
}
```

`forumChannels` subscribes the agent to inbound forum-thread events. The `extensions.discord.channels` route lets the component-owned bot validate that the same agent is allowed to create outbound threads in that forum channel.

## Add the Cron Job

Create a scheduler job whose prompt asks the agent to decide whether the user needs attention, then open a forum thread when it does.

```sh
yoplai scheduler add ops-agent \
  --cron "0 9 * * 1-5" \
  --tz America/New_York \
  -m "Review overnight operational signals. If anything needs human review, call discord.create_forum_thread with channel_id 123456789012345678, a concise title, and a body that includes the summary, recommended action, and any links or evidence. After creating the thread, wait for the user's reply in that thread before continuing the investigation."
```

When the schedule fires, scheduler runs the agent in its normal cron execution path. No Discord-specific scheduler code is required; the scheduled agent turn simply calls the Discord tool.

## Agent Tool Call

The agent calls:

```json
{
  "tool": "discord.create_forum_thread",
  "arguments": {
    "channel_id": "123456789012345678",
    "title": "Review failed nightly import",
    "body": "The nightly customer import failed after 03:12 UTC. I found 42 records rejected for missing account IDs. Recommended action: confirm whether to retry after backfilling the IDs, or skip these records for today's run."
  }
}
```

The tool returns:

```json
{
  "thread_id": "234567890123456789",
  "message_id": "345678901234567890"
}
```

Yoplai stores a thread-session binding for `thread_id` using the current scheduler session. The created Discord forum thread is now the human handoff point for that cron run.

## User Reply Resumes the Session

When a user replies in the created forum thread:

```text
Please retry after backfilling the missing IDs. Use yesterday's account export as the source of truth.
```

Yoplai receives the Discord thread message, looks up the binding for `234567890123456789`, and resumes the same agent session that created the thread. The agent sees the reply as the next user turn in that session and can continue from the earlier cron context.

If a user creates a new thread directly in a subscribed forum channel, Yoplai starts a fresh session for each subscribed agent, posts the agent response into that thread, and stores a binding so later replies resume that new session too.
