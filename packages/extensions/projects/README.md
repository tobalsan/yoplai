# yoplai projects CLI

`yoplai projects` is the CLI command provided by the projects extension and mounted into the gateway CLI:

```
yoplai projects <command> [options]
```

It can be run as:

```
pnpm --dir /Users/thinh/code/yoplai yoplai projects ...
```

Environment:

- `YOPLAI_API_URL`: override API base URL (highest precedence).
- `YOPLAI_URL`: fallback env alias for API URL.
- `$YOPLAI_HOME/yoplai.json`: fallback file config, e.g. `{ "apiUrl": "http://..." }`. Default home: `~/.yoplai/`.

## Commands

### `yoplai projects list`

List projects (frontmatter only).

Options:

- `--status <status>`: filter by status.
- `-j, --json`: JSON output instead of table.

Status values:

- `triage`, `shaping`, `shaping:<stage>`, `active`, `ready_to_merge`, `done`, `cancelled`.
- Legacy `not_now`/`maybe` values normalize to `triage`; legacy `todo`/`in_progress`/`review` values normalize to `active`.

### `yoplai projects agent list`

List all configured Yoplai agents (same output as `pnpm yoplai agent list`).

### `yoplai projects create`

Create a project.

Arguments:

- `[pitch]`: optional pitch body written to `PITCH.md`.

Options:

- `-t, --title <title>`: required. Must contain at least two words.
- `--pitch <content>`: optional pitch content string, `@file`, or `-` for stdin. Mutually exclusive with positional pitch.
- `--status <status>`: initial status.
- `--area <area>`: optional area id. Validated against `GET /api/areas`; invalid values print the valid ids.
- `-j, --json`: JSON output.

### `yoplai projects get <id>`

Fetch a single project (frontmatter plus pitch body).

Options:

- `-j, --json`: JSON output.

### `yoplai projects update <id>`

Update project fields and/or project docs content.

Options:

- `--title <title>`: update title (renames folder).
- `--status <status>`: `triage|shaping|shaping:<stage>|active|ready_to_merge|done|cancelled` (legacy values normalize as described above).
- `--run-agent <agent>`: agent used by monitoring start.
  - `yoplai:<agentId>` (Yoplai agent)
  - `cli:claude|cli:codex|cli:pi` (external CLI)
  - Use `yoplai projects agent list` to see configured Yoplai agents.
- `--run-mode <mode>`: `main-run` or `worktree` (CLI runs only).
  - `main-run`: use the main repo working tree, slug is `main`.
  - `worktree`: create/use a git worktree at `projects/.workspaces/...`, slug required.
- `--repo <path>`: repo path (used by subagents and start prompt).
- `--readme <content>`: raw markdown content for `README.md` (no frontmatter). Use `-` to read from stdin.
- `--specs <content>`: raw markdown content for legacy project-level `SPECS.md`. Use `-` to read from stdin.
- `-j, --json`: JSON output.

Notes:

- To unset optional fields, pass empty string.
- If stdin is piped and neither `--readme` nor `--specs` is provided, piped content is written to legacy project-level `SPECS.md`.

### `yoplai projects pitch <id> --from-readme`

Copy the stripped legacy `README.md` body into `PITCH.md`. Refuses to overwrite an existing `PITCH.md` unless `--force` is passed.

### `yoplai projects move <id> <status>`

Shortcut for status update.

Options:

- `--agent <name>`: agent name to record in the status change.
- `-j, --json`: JSON output.

### `yoplai projects start <id>`

Start a project run.

Options:

- `--agent <agent>`: cli name (e.g. `codex`) or `yoplai:<id>`. Defaults to `codex`.
- `--mode <mode>`: `main-run|clone|worktree|none`. Defaults to `clone`.
- `--branch <branch>`: base branch for worktree. Defaults to `main`.
- `--slug <slug>`: slug override for worktree. Defaults to auto-slug.
- `--subagent <name>`: resolve a named subagent config from `yoplai.json` and apply its locked defaults.
- `--prompt-role <role>`: prompt role override (`coordinator|worker|reviewer|legacy`).
- `--allow-overrides`: allow explicit overrides for fields locked by `--subagent`.
- `--include-default-prompt`: force-enable default project prompt context.
- `--exclude-default-prompt`: force-disable default project prompt context.
- `--include-role-instructions`: force-enable role instruction block.
- `--exclude-role-instructions`: force-disable role instruction block.
- `--include-post-run`: force-enable post-run block.
- `--exclude-post-run`: force-disable post-run block.
- `--custom-prompt <prompt>`: one-off prompt (use `-` for stdin).
- `-j, --json`: JSON output.

Subagent config mapping (`--subagent`) comes from the top-level `subagents` array in `yoplai.json`.
Each config can define `name`, `description`, `cli`, `model`, `reasoning`, `type`, and `runMode`.
The web spawn form and `yoplai projects start --subagent <name>` both resolve through that same config source.

Any explicit locked-field override requires `--allow-overrides`.
Lead-agent launches use `--agent yoplai:<id>` and run in project-scoped sessions.

## Shaping pipeline configuration

The projects orchestrator can also run a project-level shaping pipeline before projects become `active`. Configure ordered shaping stages under `extensions.projects.orchestrator.shaping_statuses` and add matching subagent profiles with `type: "shaper"` under `extensions.subagents.profiles`.

Example `yoplai.json` fragment:

```json
{
  "extensions": {
    "projects": {
      "orchestrator": {
        "enabled": true,
        "poll_interval_ms": 30000,
        "stall_threshold_ms": 1800000,
        "shaping_statuses": {
          "shaping:repo": { "profile": "RepoSetter", "max_concurrent": 1 },
          "shaping:drill": { "profile": "SpecsDriller", "max_concurrent": 1 },
          "shaping:slice": { "profile": "Slicer", "max_concurrent": 1 },
          "shaping:verticality": {
            "profile": "VerticalityChecker",
            "max_concurrent": 1
          },
          "shaping:validation": {
            "profile": "ValidationFiller",
            "max_concurrent": 1,
            "stall_threshold_ms": 3600000
          },
          "shaping:approve": { "profile": "Approver", "max_concurrent": 1 }
        }
      }
    },
    "subagents": {
      "profiles": [
        {
          "name": "RepoSetter",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex-mini",
          "runMode": "none"
        },
        {
          "name": "SpecsDriller",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex",
          "runMode": "none"
        },
        {
          "name": "Slicer",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex",
          "runMode": "none"
        },
        {
          "name": "VerticalityChecker",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex",
          "runMode": "none"
        },
        {
          "name": "ValidationFiller",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex",
          "runMode": "worktree"
        },
        {
          "name": "Approver",
          "type": "shaper",
          "cli": "codex",
          "model": "gpt-5.1-codex",
          "runMode": "none"
        }
      ]
    }
  }
}
```

Behavior:

- Project status is the pipeline cursor. A project at `shaping:repo` dispatches the `RepoSetter` profile; the agent advances with `yoplai projects move <id> shaping:drill`.
- The next status is the next key in `shaping_statuses`; the final configured stage defaults to advancing to `active`.
- `shaping:blocked` is terminal for the pipeline. Move the project back to any `shaping:<stage>` status to resume.
- Only one shaper runs per project at a time. `max_concurrent` limits concurrent runs for that stage across projects.
- If a project stays in one shaping status longer than `stall_threshold_ms`, the orchestrator comments in `THREAD.md` and moves it to `shaping:blocked`.
- Prompts are loaded from `.yoplai/prompts/<ProfileName>.md` when present. Templates use `${variable}` substitution and fail dispatch on unresolved variables. Available variables include `projectId`, `projectTitle`, `projectDirPath`, `status`, `nextStatus`, `profileName`, `projectDocs`, `sliceDocs`, `recentThread`, and `cli`. `${aihubCli}` still resolves for templates written before the rename, but is deprecated — switch to `${cli}`.

Start a project in the pipeline with:

```bash
yoplai projects move PRO-19 shaping:repo
```

- `--mode <mode>`: `main-run|worktree`.
- `--branch <branch>`: base branch for worktree mode.
- `-j, --json`: JSON output.

### `yoplai projects resume <id>`

Resume an existing run (same as sending a message in the monitoring panel).
Resume sends only the follow-up message delta to the harness (no project summary re-prepend).

Options:

- `-m, --message <message>`: required. Use `-` for stdin.
- `--slug <slug>`: override slug for CLI worktree resumes.
- `-j, --json`: JSON output.

### `yoplai projects status <id>`

Show run status and recent messages.

Options:

- `--limit <n>`: number of recent messages (default 10).
- `--slug <slug>`: override slug for CLI worktree status.
- `-j, --json`: JSON output.

### `yoplai projects archive <id>`

Archive a project.

Options:

- `-j, --json`: JSON output.

### `yoplai projects unarchive <id>`

Unarchive a project.

Options:

- `-j, --json`: JSON output.

## Examples

```bash
# Create with pitch
yoplai projects create -t "Add kill tool" "Implement a kill command for subagents"

# Create with pitch from file
yoplai projects create -t "Add kill tool" --pitch @PITCH.md

# Update run metadata
yoplai projects update PRO-19 --run-agent cli:codex --repo ~/code/yoplai --run-mode worktree

# Update README via stdin
cat README.md | yoplai projects update PRO-19 --readme -

# Update SPECS via stdin
cat SPECS.md | yoplai projects update PRO-19 --specs -

# Migrate legacy README prose into PITCH.md
yoplai projects pitch PRO-19 --from-readme

# Default stdin update target is SPECS.md
cat SPECS.md | yoplai projects update PRO-19

# Start a run with a custom prompt
yoplai projects start PRO-19 --custom-prompt "Focus on the rollout plan."

# Start a run with per-run config
yoplai projects start PRO-19 --agent codex --mode worktree --branch main --slug my-run

# Start a config-defined Worker subagent run
yoplai projects start PRO-19 --subagent Worker --slug worker-task-a

# Start a config-defined Reviewer subagent run
yoplai projects start PRO-19 --subagent Reviewer --slug reviewer-task-a

# Start a lead-agent run on a configured Yoplai agent
yoplai projects start PRO-19 --agent yoplai:cloud --custom-prompt "Plan the rollout."

# Resume with a follow-up message
yoplai projects resume PRO-19 --message "Continue from where you left off."

# Status with last 5 messages
yoplai projects status PRO-19 --limit 5

# Archive a project
yoplai projects archive PRO-19

# Unarchive a project
yoplai projects unarchive PRO-19

```
