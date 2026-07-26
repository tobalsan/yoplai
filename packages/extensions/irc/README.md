# IRC extension

IRC supports either a shared gateway connection or one connection per agent.

## Per-agent connection

Configure `irc` at the top level of the agent's `agent.yaml`. Route entries omit `agent` because ownership is implicit:

```yaml
# agents/main/agent.yaml
irc:
  host: irc.example.net
  port: 6697
  tls: true
  nick: main-bot
  nickservPassword: $env:IRC_NICKSERV_PASSWORD
  channels:
    "#team": { mode: mention-only }
  dm: { enabled: true, allowFrom: [alice], debounceMs: 250 }
  debounceMs: 1500
```

## Shared connection

Legacy shared transport remains supported. Agents routed by shared config must opt in:

```yaml
# agents/main/agent.yaml
extensions:
  irc:
    enabled: true
```

Configure shared connection and routing in `yoplai.json`:

```json
{
  "extensions": {
    "irc": {
      "enabled": true,
      "host": "irc.example.net",
      "port": 6697,
      "tls": true,
      "nick": "yoplai",
      "nickservPassword": "$env:IRC_NICKSERV_PASSWORD",
      "channels": { "#team": { "agent": "main", "mode": "mention-only" } },
      "dm": { "enabled": true, "agent": "main" },
      "debounceMs": 1500,
      "humanNicks": ["alice"],
      "maxA2ATurns": 4
    }
  }
}
```

## Behavior

Mention-only channels respond to `yoplai: message`; `reply-all` channels answer every message. Once an accepted channel message or allowed DM dispatches to an agent, the bot first sends a standalone `👀` to the same destination. IRC cannot remove this acknowledgement, so it remains in the conversation. Debounced messages send one acknowledgement when the coalesced run dispatches; ignored or rejected messages send none.

Top-level `debounceMs` batches a burst of channel lines from the same sender into one agent turn: in mention-only channels, follow-up lines from the same sender join the pending batch without needing another mention; `reply-all` channels batch every line the same way. `dm.debounceMs` does the same for direct messages. A coalesced batch counts once toward `maxA2ATurns`, and is discarded if its agent becomes inactive before dispatch.

Agent replies are converted to IRC-safe plain text: markdown (emphasis, backticks, headings, links) is stripped but newlines are kept — each line becomes its own IRC message, and long lines split on word boundaries instead of mid-sentence.

Channel context is bounded by `historyLimit`. Per-channel A2A cap resets only on configured human nicks. Application replies queued while disconnected or registering are sent after the server confirms registration. Agent-local `password` and `nickservPassword` `$env:` references resolve from that agent's `.env` using normal gateway secret resolution.
