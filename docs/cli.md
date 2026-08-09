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
yoplai gateway ...          run or manage gateway
yoplai agent list           list agents
yoplai agents migrate       migrate centralized v2 agents to v3 folders
yoplai send ...             send agent message
yoplai notify ...           send configured channel notification
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
pnpm yoplai projects list --status active
pnpm yoplai slices list --project PRO-1
pnpm yoplai subagents profiles
pnpm yoplai auth status
```

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
