# Discord Extension

The Discord extension connects Yoplai agents to Discord guild channels, DMs, reactions, slash commands, and forum-channel threads.

See [docs/discord.md](../../../docs/discord.md) for setup, config reference, forum-channel behavior, and the `discord.create_forum_thread` agent tool.

For a worked scheduler workflow, see [docs/examples/discord-forum-cron.md](../../../docs/examples/discord-forum-cron.md).

## Scheduler delivery sink

Registers as delivery sink id `discord`. A `deliver` destination's `channel` is sent to
directly (channel, thread, or DM-channel ID); `user` opens a DM via `POST /users/@me/channels`
first, then sends into it. Both reuse the same send path as the `discord.send_message` agent
tool, but the sink throws on failure instead of returning `{ ok: false }` — the scheduler
records that as a warning on the run.

```json
{ "target": "discord", "channel": "998877665544332211" }
```
