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

Secrets resolve before extension validation. Missing IDs and invalid config fail or warn at startup according to extension contract. Missing tool-extension tokens remain configurable at runtime: affected calls return a configuration link while unrelated tools keep working. Agent-local `.env` lets two agents reuse names such as `SLACK_TOKEN` without sharing values.

## Personal extension API tokens

Open an agent's extension configuration form and fill in the **Just me** tab: your token plus any setting you need to differ, such as your own Jira email or subdomain. Fields left at the team value keep following it. This is available to signed-in users with access to that agent. Admins can select **Whole team** and change shared non-secret settings; single-user installations keep the existing shared configuration behavior.

Each tool call uses your personal token first, then existing team configuration. Without either, it asks you to configure the extension using an exact form link. Scheduled jobs and other runs without a signed-in requester use team configuration only. Existing YAML/env tokens remain shared; no migration is needed. Saving or rotating a personal token takes effect on the next call, including tools already collected for a conversation.

Personal token fields are encrypted in `$YOPLAI_HOME/credentials` using `oauth.encryptionKey`; a missing encryption key prevents saving. The UI and model receive field presence and links, never stored personal token values; your non-secret overrides are shown back to you only. Personal values are literal, so `$env:` references are rejected. Non-secret settings (usernames, emails, subdomains) are shown in clear on both tabs, with team `$env:` references resolved for display; saving sends only changed settings, so references in `agent.yaml` are kept.

The existing `PATCH /api/agents/:id/extensions/:extensionId` endpoint accepts `{"credentialScope":"personal","config":{"email":"<you>"},"secrets":{"apiToken":"<token>"}}`. Personal scope accepts any declared config field; `config` replaces your previous setting overrides, while secrets merge; the server derives the user from authentication and rejects a supplied `userId`. `credentialScope: "team"` or an omitted scope uses the existing config/env writer and requires an admin in multi-user mode. The catalog includes `personalSecretFields` (names only), `personalConfigValues` (your setting overrides), and `canConfigureTeam` for token-backed extensions in multi-user mode.

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

At least one sign-in method is required: `oauth.google` and/or `"emailAndPassword": { "enabled": true }` (Better Auth email/password; the login page shows whichever are configured).

Gateway creates `$YOPLAI_HOME/auth.db`. First registered user becomes an approved superadmin; admins approve later users and manage teams. Sessions and history become user-scoped. Enabling multi-user mode does not migrate existing single-user history.

Roles are user/admin/superadmin. Headless clients can use `yoplai user token create|list|revoke` and bearer authentication. Full setup and pool/team behavior: [multi-user README](../packages/extensions/multi-user/README.md).

## Optional web routes

Web app fetches `/api/capabilities` and lazy-loads enabled route bundles. Core web imports must not hard-depend on optional board/project modules.
