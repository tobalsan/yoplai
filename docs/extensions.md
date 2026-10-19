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
| `threadit`     | Threadit board agent (poller and `threadit.*` tools) | [package README](../packages/extensions/threadit/README.md)                                 |
| `scheduler`    | Cron, scripts, delivery                    | [Scheduling](scheduling.md) / [package README](../packages/extensions/scheduler/README.md)  |
| `slack`        | Slack Socket Mode transport                | [package README](../packages/extensions/slack/README.md)                                    |
| `subagents`    | Project-agnostic CLI runs                  | [package README](../packages/extensions/subagents/README.md)                                |
| `telegram`     | Telegram transport                         | [package README](../packages/extensions/telegram/README.md)                                 |
| `webhooks`     | HTTP webhook triggers                      | [Webhooks](webhooks.md)                                                                     |

## External extensions

External extensions load from `extensionsPath`, or `$YOPLAI_HOME/extensions` by default. Discovery accepts directories and symlinked directories.

Extensions can contribute routes, services, lifecycle hooks, capabilities, CLI commands, web routes, prompt text, tools, delivery sinks, and OAuth requirements. Tool bundles use `packages/shared/src/tool-extension.ts` and object-shaped Zod parameter schemas.

Secrets resolve before extension validation. Missing IDs and invalid config fail or warn at startup according to extension contract. Missing tool-extension tokens remain configurable at runtime: affected calls return a configuration link while unrelated tools keep working. Agent-local `.env` lets two agents reuse names such as `SLACK_TOKEN` without sharing values.

### Tool result schemas

Tool authors may declare an optional Zod `outputSchema` beside `parameters`:

```ts
{
  name: "get_deal",
  description: "Read a deal",
  parameters: z.object({ id: z.number() }),
  outputSchema: z.object({ id: z.number(), org_id: z.number().optional() }),
  execute: async ({ id }) => client.getDeal(id),
}
```

The helper converts both schemas to JSON Schema with `$refStrategy: "none"`. Direct `ExtensionAgentTool` records declare `outputSchema` as JSON Schema. Agent and discovery tools retain it, including tools deferred until `tool_search`; scripts can call deferred tools before loading their declarations.

For a tool with an output schema, both Pi hosts add `structuredContent`, a JSON-safe copy of the full raw result, alongside the existing text `content` and raw `details`. Codemode resolves that object and describes its fields; scripts can read `deal.org_id` without `JSON.parse`. Container text previews, spill files and timeout notes remain unchanged, while scripts receive the full result. Success schemas describe results but are never enforced at runtime, so refusal/error objects can have different shapes.

Only a schema-bearing result whose top-level `isError` is exactly `true` sets the Pi error flag. Such a result still resolves its structured data in codemode; thrown failures reject. Existing `{ ok: false, error }` results keep their behavior. Connection/reconnection refusals carry `isError: true`. Tools without an output schema retain their text-only script behavior and existing error classification. Older hosts ignore the additive metadata; newer hosts accept older extensions without it.

Adapted external MCP tools expose one generic `CallToolResult` schema (`content`, optional `structuredContent` and `isError`), without forwarding a server-specific output schema. Disconnected MCP stubs declare the same metadata but retain their refusal payloads.

## Per-scope settings for OAuth extensions

For OAuth extensions without credential fields (for example Google Drive's **Enable creating and writing files**), the extension form follows the connect card's **Just me** / **Whole team** tab. Each tab keeps its own value and its own OAuth scopes: **Just me** is stored per user and applies only when you have your own connection (unset means off, never the team value); **Whole team** is the admin-managed agent setting. Clicking **Connect** or **Reconnect** saves the tab's pending checkbox first, so no separate Save is needed. `PATCH` with `credentialScope: "personal"` works for any member; the catalog adds `oauth.personalScopes` for the Just me tab.

## Personal extension API tokens

Open an agent's extension configuration form and fill in the **Just me** tab: your token plus any setting you need to differ, such as your own Jira email or subdomain. Fields left at the team value keep following it. This is available to signed-in users with access to that agent. Admins of a linked team and superadmins can select **Whole team** and manage shared credentials; single-user installations keep the existing shared configuration behavior.

Each tool call uses your personal token first, then existing team configuration. Without either, it asks you to configure the extension using an exact form link. Scheduled jobs and other runs without a signed-in requester use team configuration only. Existing YAML/env tokens remain shared; no migration is needed. Saving or rotating a personal token takes effect on the next call, including tools already collected for a conversation.

Personal token fields are encrypted in `$YOPLAI_HOME/credentials` using `oauth.encryptionKey`; a missing encryption key prevents saving. The UI and model receive field presence and links, never stored personal token values; your non-secret overrides are shown back to you only. Personal values are literal, so `$env:` references are rejected. Non-secret settings (usernames, emails, subdomains) are shown in clear on both tabs, with team `$env:` references resolved for display; saving sends only changed settings, so references in `agent.yaml` are kept.

The existing `PATCH /api/agents/:id/extensions/:extensionId` endpoint accepts `{"credentialScope":"personal","config":{"email":"<you>"},"secrets":{"apiToken":"<token>"}}`. Personal scope accepts any declared config field; `config` replaces your previous setting overrides, while secrets merge; the server derives the user from authentication and rejects a supplied `userId`. `credentialScope: "team"` or an omitted scope uses the existing config/env writer and requires agent management in multi-user mode when the extension has secret fields or OAuth, including settings-only changes and disable. Extensions with neither remain editable with chat access. The catalog includes `personalSecretFields` (names only), `personalConfigValues` (your setting overrides), and `canConfigureTeam` for token-backed extensions in multi-user mode.

To unset credentials, the extension form shows **Remove my credentials** (Just me) or **Remove team credentials** (Whole team, agent managers). Personal removal uses `DELETE /api/agents/:id/connections/extension/:extensionId` and clears all your values for that extension. Team removal uses `DELETE /api/agents/:id/extensions/:extensionId/credentials`, which drops the secret fields from `agent.yaml` (and the `.env` values Yoplai wrote for them) while keeping non-secret settings and the enabled flag. Secrets configured at the gateway root are not affected.

An extension can also save its own per-agent config. It calls `ctx.updateAgentExtensionConfig(agentId, extensionId, patch)`. The patch has the same shape as the REST write: `enabled`, `config`, `secrets`, and `removeSecrets`. The host writes `agent.yaml` and the agent `.env`, then reloads the config. An extension can write only its own `extensionId`. Threadit uses this in `threadit.register`.

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

Gateway creates `$YOPLAI_HOME/auth.db`. First registered user becomes an approved superadmin. Later users are approved automatically unless `"autoApprove": false`, which leaves them pending admin approval. Superadmins create/delete teams and see every agent; admins manage only the teams they belong to and their agents. Sessions and history become user-scoped. Enabling multi-user mode does not migrate existing single-user history.

New users receive no explicit team membership at sign-up; legacy `autoJoinPublicTeams` config keys are accepted and ignored. All users teams retain live membership. Public agents are available to every approved user, including users with no team; Private agents require membership in a linked team (superadmins bypass this). Agent team links decide management independently of visibility: only a superadmin or an admin in a linked team may change visibility, assignments, team credentials/OAuth, or pause/resume/delete Team jobs. Legacy All teams assignments migrate once to teamless Public agents; writes accept only explicit team lists. The team Private field remains in the API but is inert and hidden in the UI. Staff can use Teams → No team to place newcomers into teams they manage; pending users remain blocked from all agents until approved.

Roles are user/admin/superadmin. Headless clients can use `yoplai user token create|list|revoke` and bearer authentication. Full setup and pool/team behavior: [multi-user README](../packages/extensions/multi-user/README.md).

Without a configured agent pool, an agent with no fork record is treated as Public: every approved user and admin can list and use it, including chat, avatars and capability self-enable. Agents with existing fork records (including migrated legacy assignments) keep their Public or linked-team access rules and are hidden from users who cannot open them. Pending users stay blocked; agent management and team credentials still require the existing ownership permissions.

## Optional web routes

Web app fetches `/api/capabilities` and lazy-loads enabled route bundles. Core web imports must not hard-depend on optional board/project modules.
