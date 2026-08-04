# Telegram Extension

Connects Yoplai agents to Telegram over a [grammY](https://grammy.dev)
long-polling bot. This is the walking-skeleton slice: a direct message reaches
an agent's main session and a single plain-text reply is delivered back to the
same chat.

Access is gated by user and chat allowlists (see [Allowlist](#allowlist)),
mirroring the discord/slack allow-list convention.

## Enable / disable

The extension runs in two modes; both can be active at once. Presence of config
is the enable signal.

### Component bot (shared)

One bot shared across agents, configured under `extensions.telegram`:

```json
{
  "extensions": {
    "telegram": {
      "enabled": true,
      "token": "$env:TELEGRAM_TOKEN",
      "allowedUsers": [123456789, "alice"],
      "allowedChats": [123456789]
    }
  }
}
```

`enabled: false` is a runtime kill switch: the extension still loads (so agent
tools remain available), but the bot does not start.

### Per-agent bot

An agent can run its own bot with a dedicated token. Add a `telegram` block to
the agent's `agent.yaml`:

```yaml
# <agent-workspace>/agent.yaml
telegram:
  token: "$env:TELEGRAM_TOKEN"
  allowedUsers: [123456789, "alice"]
  allowedChats: [123456789]
```

The token is a `SecretRef`; use the `$env:` syntax to resolve it from the
environment, matching the discord/slack extensions.

## Allowlist

Only explicitly allowed senders and chats may talk to the bot, mirroring the
discord/slack allow-list shape:

- `allowedUsers` — the sender must match. Entries are numeric Telegram user IDs
  or `@username`s (the leading `@` is optional), matched case-insensitively.
- `allowedChats` — the chat must match. Entries are numeric chat IDs or, for
  public groups/channels, their `@username`.

Enforcement fails closed: an empty or omitted list allows no one, so a bot with
no allowlist configured serves nobody. A `telegram:/user:` / `telegram:/chat:`
prefix may be used on entries for parity with the discord/slack prefixed forms.
Unauthorized messages are ignored — no agent dispatch and no reply.

## Behavior

- A DM (`private` chat) resolves to the agent's main session
  (`DEFAULT_MAIN_KEY`) and calls `ctx.runAgent({ source: "telegram", ... })`.
- The agent's reply is posted back as plain text, split to Telegram's
  4096-character message limit.
- The bot starts/stops through the extension lifecycle.

## Agent tools

- `telegram.send_message` — proactively send a plain-text message to a chat by
  numeric chat ID.

## Delivery sink

Registers under id `"telegram"` for the scheduler's `deliver` targets. The
destination maps to a chat ID: `user` (preferred) or `channel`, whichever is
set — set exactly one. The message is sent through the same active-bot lookup,
markdown rendering, chunking, and retry as `telegram.send_message`, and throws
if no bot is active for the job's agent (the scheduler records this as a
delivery warning; it does not fail the job run).

```json
{ "target": "telegram", "user": "123456789" }
```
