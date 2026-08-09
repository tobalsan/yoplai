# Extensions

Yoplai optional features are extensions. Root `extensions.<id>` loads/configures extension; agent `extensions.<id>` opts into tool-style features unless `enabled: false`.

```json
{
  "extensions": {
    "scheduler": { "enabled": true },
    "projects": { "enabled": true, "root": "~/projects" }
  }
}
```

```yaml
# agent.yaml
extensions:
  scheduler:
    enabled: true
```

Some messaging transports retain supported per-agent compatibility config. Webhooks auto-load when an agent declares webhooks.

## Built-in catalog

| ID             | Purpose                                    | Detailed reference                                                                          |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `board`        | Board shell, projections, scratchpad       | [package README](../packages/extensions/board/README.md)                                    |
| `discord`      | Discord guild/DM/forum transport           | [Discord guide](discord.md) / [package README](../packages/extensions/discord/README.md)    |
| `heartbeat`    | Periodic check-ins, scheduler-gated        | [Scheduling](scheduling.md)                                                                 |
| `irc`          | IRC transport                              | [package README](../packages/extensions/irc/README.md)                                      |
| `langfuse`     | Agent tracing and observations             | package source/config schema                                                                |
| `multiUser`    | Better Auth, teams, agent forks, isolation | [package README](../packages/extensions/multi-user/README.md)                               |
| `orchestrator` | Tracker-backed autonomous workers          | [package README](../packages/extensions/orchestrator/README.md)                             |
| `projects`     | Projects, slices, subagents, Space         | [Projects guide](projects.md) / [package README](../packages/extensions/projects/README.md) |
| `scheduler`    | Cron, scripts, delivery                    | [Scheduling](scheduling.md) / [package README](../packages/extensions/scheduler/README.md)  |
| `slack`        | Slack Socket Mode transport                | [package README](../packages/extensions/slack/README.md)                                    |
| `subagents`    | Project-agnostic CLI runs                  | [package README](../packages/extensions/subagents/README.md)                                |
| `telegram`     | Telegram transport                         | [package README](../packages/extensions/telegram/README.md)                                 |
| `webhooks`     | HTTP webhook triggers                      | [Webhooks](webhooks.md)                                                                     |

## External extensions

External extensions load from `extensionsPath`, or `$YOPLAI_HOME/extensions` by default. Discovery accepts directories and symlinked directories.

Extensions can contribute routes, services, lifecycle hooks, capabilities, CLI commands, web routes, prompt text, tools, delivery sinks, and OAuth requirements. Tool bundles use `packages/shared/src/tool-extension.ts` and object-shaped Zod parameter schemas.

Secrets resolve before extension validation. Missing IDs, invalid config, or missing required secrets fail or warn at startup according to extension contract. Agent-local `.env` lets two agents reuse names such as `SLACK_TOKEN` without sharing values.

## Multi-user mode

Enable under `extensions.multiUser`:

```json
{
  "extensions": {
    "multiUser": {
      "enabled": true,
      "oauth": {
        "google": {
          "clientId": "$env:GOOGLE_CLIENT_ID",
          "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
        }
      },
      "allowedDomains": ["example.com"],
      "sessionSecret": "$env:BETTER_AUTH_SECRET"
    }
  }
}
```

Gateway creates `$YOPLAI_HOME/auth.db`. First OAuth user becomes an approved superadmin; admins approve later users and manage teams. Sessions and history become user-scoped. Enabling multi-user mode does not migrate existing single-user history.

Roles are user/admin/superadmin. Headless clients can use `yoplai user token create|list|revoke` and bearer authentication. Full setup and pool/team behavior: [multi-user README](../packages/extensions/multi-user/README.md).

## Optional web routes

Web app fetches `/api/capabilities` and lazy-loads enabled route bundles. Core web imports must not hard-depend on optional board/project modules.
