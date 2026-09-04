# Models and skills

## Built-in providers

Pi SDK supplies model/provider registry. Agent selects provider/model in `agent.yaml`:

```yaml
id: my-agent
name: My Agent
model:
  provider: anthropic
  model: claude-sonnet-4-5
```

Authentication options are covered in [OAuth](oauth.md). Use `auth.mode: oauth`, `api_key`, or `proxy` as provider requires.

Pi ships a built-in model catalog and can merge newer provider catalogs from a local cache. Refresh that cache from the network with:

```bash
yoplai models refresh
```

The command writes `$YOPLAI_HOME/models-store.json`. Gateway runs then use the refreshed catalog; restart a running gateway before retrying a model that was previously unavailable.

## Custom providers

Add `$YOPLAI_HOME/models.json`:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "PROVIDER_API_KEY",
      "models": [
        {
          "id": "my-model",
          "displayName": "My Model",
          "contextWindow": 128000
        }
      ]
    }
  }
}
```

`apiKey` names environment variable; do not put secret value in tracked files. Pi reads custom provider file directly.

`pnpm update-models` refreshes web context-window metadata for configured v3 agents and custom models. Explicit `contextWindow` is preserved; otherwise updater checks OpenRouter then models.dev.

The script is build-time only: it rewrites `packages/shared/src/model-context-data.json`, which is statically imported and compiled into `packages/shared/dist/` and the web bundle. A running gateway never fetches model data at runtime. To update a production install: `pnpm update-models` → `pnpm build` → `yoplai gateway restart`.

## Reasoning

Agent `reasoning` values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Harness-specific supported values may differ; project/orchestrator profiles validate before run.

## Workspace prompt files

Yoplai creates missing:

- `AGENTS.md` — primary operational instructions
- `SOUL.md` — identity/persona
- `USER.md` — user context

Existing files are never overwritten. `AGENTS.md` is implicitly prepended; `system_files` controls remaining order.

## Skills and commands

Pi discovers skills and commands from Pi-compatible workspace/user directories. For harness-neutral source organization, keep resources under workspace `agent/`, then expose to Pi:

```bash
cd "$YOPLAI_HOME/agents/my-agent"
mkdir -p agent/skills
ln -s agent .pi
```

This makes `agent/skills` available as `.pi/skills`. Check symlink does not already exist before creating. Other coding harnesses may use different resource locations; do not assume Pi skill format is portable without adaptation.

## System prompt contributions

Enabled extensions may append guidance and expose tools. Provider-facing names are sanitized while gateway retains extension/tool identity. Sandbox/container delivery differs; see [Container isolation](container-isolation.md).
