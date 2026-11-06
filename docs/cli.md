# CLI

Build gateway before using repository-local CLI:

```bash
pnpm build
pnpm yoplai --help
```

For global command during development:

```bash
pnpm --filter @yoplai/gateway build
pnpm link --global ./apps/gateway
```

## Command families

```text
yoplai gateway ...          run or manage gateway (`idle` checks for running work; `restart` refuses unless idle, `--force` overrides)
yoplai agent list           list agents
yoplai agents migrate       migrate centralized v2 agents to v3 folders
yoplai send ...             send agent message
yoplai notify ...           send Discord, Slack or Mattermost notification
yoplai models refresh       refresh Pi's cached model catalogs
yoplai model-routing report --since <ISO-date>  evaluate fresh local shadow sessions (`--until`, repeatable `--agent`, `--json`, `--out`)
yoplai auth ...             provider OAuth login/status/logout
yoplai user token ...       multi-user bearer token management
yoplai scheduler ...        cron job management
yoplai projects ...         project operations and project subagents
yoplai slices ...           slice document/lifecycle operations
yoplai subagents ...        project-agnostic CLI subagent runtime
yoplai orchestrator ...     tracker orchestrator management
yoplai webhooks rotate ...  rotate webhook URL secret
yoplai dream ...            run/inspect nightly consolidation
yoplai eval run ...         headless eval turn
```

Use `--help` for current flags. Extension command details:

- [Projects README](../packages/extensions/projects/README.md)
- [Scheduler README](../packages/extensions/scheduler/README.md)
- [Subagents README](../packages/extensions/subagents/README.md)
- [Orchestrator README](../packages/extensions/orchestrator/README.md)

## Common examples

```bash
pnpm yoplai agent list
pnpm yoplai send -a my-agent -m "Hello"
pnpm yoplai notify --channel default --message "Build finished"
pnpm yoplai notify --from my-agent --channel default --surface mattermost --mention alex --message "Build finished"
pnpm yoplai projects list --status active
pnpm yoplai slices list --project PRO-1
pnpm yoplai subagents profiles
pnpm yoplai models refresh
pnpm yoplai auth status
```

`notify --surface` accepts `discord`, `slack`, `mattermost`, or `all` (the default). `all` sends to every surface configured on the channel key; `both` is a compatibility alias. For Mattermost, `--mention` takes a username, not a user ID: `alex` or `@alex` prefixes `@alex`. An ID is used as given and will not ping a user. Discord and Slack mentions still take user IDs. Mattermost credentials come as a pair from the `--from` agent's `mattermost` block, otherwise root `extensions.mattermost` (see [notification channels](configuration.md#notification-channels)).

## Remote gateway targeting

HTTP CLI URL precedence:

1. `YOPLAI_API_URL`
2. `YOPLAI_URL` compatibility alias
3. `apiUrl` in `$YOPLAI_HOME/yoplai.json`

Token precedence:

1. `YOPLAI_TOKEN`
2. config token

```bash
YOPLAI_API_URL=https://host.example \
YOPLAI_TOKEN=... \
pnpm yoplai projects list
```

Local config commands use `--config` then `$YOPLAI_HOME/yoplai.json`. `YOPLAI_CONFIG` exists only as deprecated home-derivation fallback.

## Agent migration

```bash
pnpm yoplai agents migrate --help
```

This converts v2 centralized `agents[]` to v3 per-agent `agent.yaml`. It differs from legacy projects extension config migration.

## Project subagent flags

`yoplai projects start` can select config-defined `--subagent <name>` or explicit harness. Profile-owned CLI/model/reasoning/run mode/type values are locked unless `--allow-overrides` is set. Prefer configured profiles over manually repeating flags.
