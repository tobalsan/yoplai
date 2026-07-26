# Slack Thread Cron Example

This example shows the scheduler handoff pattern for periodic human review:

1. A cron job wakes up an agent in its own scheduler session.
2. The agent calls `slack.create_thread` to post a thread parent in a channel or DM.
3. A user replies in that thread, and Yoplai resumes that same scheduler session.

## Configure Slack and scheduler

The Slack app needs Socket Mode for inbound replies and `chat:write` for the
outbound parent message. The channel must route to the same agent. For a DM,
enable `dm` and use the recipient's Slack user ID in the tool call instead of a
channel ID.

```json
{
  "extensions": {
    "scheduler": { "enabled": true },
    "slack": {
      "enabled": true,
      "token": "$env:SLACK_BOT_TOKEN",
      "appToken": "$env:SLACK_APP_TOKEN",
      "channels": {
        "C0123456789": {
          "agent": "ops-agent",
          "requireMention": false,
          "threadPolicy": "always"
        }
      },
      "dm": { "enabled": true, "agent": "ops-agent" }
    }
  }
}
```

`threadPolicy` governs ordinary Slack routing. A reply in a thread created by
`slack.create_thread` has a stored binding and takes precedence over that
policy and normal channel/DM session routing.

## Add the cron job

```sh
yoplai scheduler add ops-agent \
  --cron "0 9 * * 1-5" \
  --tz America/New_York \
  -m "Review overnight operational signals. If human review is needed, call slack.create_thread with channel C0123456789 and a concise summary plus recommended action. After creating the thread, wait for the user's reply there before continuing."
```

When the schedule fires, the scheduler creates its normal per-run session. No
Slack-specific scheduler code is needed: the scheduled agent turn calls the
Slack tool.

## Agent tool call

```json
{
  "tool": "slack.create_thread",
  "arguments": {
    "channel": "C0123456789",
    "text": "Nightly import failed after 03:12 UTC: 42 records are missing account IDs. Should I retry after backfilling them, or skip them for today?"
  }
}
```

For a DM handoff, use a Slack user ID instead:

```json
{ "channel": "U0123456789", "text": "I need your approval to retry the import." }
```

The tool returns the resolved channel and parent timestamp:

```json
{ "ok": true, "channel": "C0123456789", "ts": "1710000000.000100" }
```

Yoplai persists a binding for that `(channel, ts, agent)` and the current cron
session. The parent message is now the human handoff point.

## User reply resumes the session

When a user replies in the Slack thread:

```text
Retry after backfilling from yesterday's account export.
```

Yoplai looks up the binding before normal Slack routing, resumes the cron
session that created the parent, and posts the agent's answer in that same
thread exactly once. This applies even when the configured channel policy is
`never`. Thread-bound DM replies do not add a main-session visibility note;
only a later top-level DM reply to a proactive `slack.send_message` does.
