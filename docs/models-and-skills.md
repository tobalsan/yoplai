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

Agent `reasoning` values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Harness-specific supported values may differ; project/orchestrator profiles validate before run.

## Workspace prompt files

Yoplai creates missing:

- `AGENTS.md` — primary operational instructions
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

Yoplai's built-in `dashboard` skill is always discoverable by host and sandboxed Pi agents. It documents the Canvas contract and provides cloneable HR (`pto-me`, `pto-team`, `ats`, `candidate`), OKR (`okr-teams`, `okr-me`, `okr-reports`, on their own `data/okr.db`), and customer-success (`clients`, `client`, `qbr`) templates with sample SQLite data.

### Skill sources

A Pi agent gets skills from five sources. The agent sees one list of skills, with the name, the description and the file path of each skill. The agent does not know the source of a skill.

| Source | Location | Who manages it | On or off | Which agents | Where it shows in the UI |
|---|---|---|---|---|---|
| Pi skill folders | Workspace `.pi/skills/`. On host runs only: `$YOPLAI_HOME/skills/`, and `~/.agents/skills/` when `globalSkills: true` | The operator, on disk | Always on | One agent for `.pi/skills/`, all host agents for the other folders | Not shown |
| Built-in | `apps/gateway/src/skills/` (`dashboard`, `skill-creator`) | Yoplai developers, in a release | Always on | All Pi agents | **Admin → Skills** |
| Agent workspace | `$YOPLAI_HOME/agents/<id>/skills/` | The operator, or the agent itself | Always on | Only the agent that owns the workspace | **Skills** page, in the agent tab, read-only. In multi-user mode, a superadmin can mark the skill as System on **Admin → Skills**. A System skill is hidden from **Skills**, but the agent still loads it |
| Default | `$YOPLAI_HOME/skill-library/default/<name>/` | The operator, on disk | Always on | All Pi agents, or the agents in `.yoplai.json` | **Admin → Skills** |
| User | `$YOPLAI_HOME/skill-library/users/<owner>/<name>/` | Each user, on the **Skills** page or with `skill_save` | Off until the user turns it on | All Pi agents of that user | **Skills** page, in **Your skills** or **Shared with me** |

A superadmin can move an agent workspace skill to the default skills with **Make default** on **Admin → Skills**. Yoplai moves the folder out of the workspace. Yoplai blocks the move when a built-in, default or user skill has the same name. Before the move, the dialog lists the paths outside the skill folder that the skill refers to. Other agents may not have these files.

A superadmin can give a user skill to another user with **Transfer** on **Admin → Skills**. Use this when the owner is banned, rejected or removed. Then the skill works again for the people who share it.

Yoplai reads default and user skills again at the start of each run. You do not have to restart the gateway after you add a default skill. To limit a default skill to some agents, add `.yoplai.json` with `{ "agents": ["hr"] }` next to its `SKILL.md`.

#### Load order

If two skills have the same name, the agent gets only the first one in this order:

1. Pi skill folders
2. Built-in skills
3. Agent workspace skills
4. Default skills
5. User skills: first the skills of the user, then skills that other users share

Users cannot take the name of a built-in or default skill. But nothing stops a workspace skill with the same name as a user skill. In that case, the agent gets the workspace skill, and the **Skills** page does not show that the user skill did not load.

## System prompt contributions

Enabled extensions may append guidance and expose tools. Provider-facing names are sanitized while gateway retains extension/tool identity. Sandbox/container delivery differs; see [Container isolation](container-isolation.md).
