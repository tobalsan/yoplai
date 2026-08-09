# Projects, slices, and subagents

Projects extension stores human-readable project documents, exposes board/API/CLI workflows, runs external coding agents, and manages Space integration.

For exhaustive reference see [projects extension README](../packages/extensions/projects/README.md).

## Enable

```json
{
  "extensions": {
    "projects": {
      "enabled": true,
      "root": "~/projects"
    },
    "subagents": {}
  }
}
```

## Document model

Projects are lifecycle containers; slices are execution units.

Project directory:

- `README.md` — frontmatter metadata
- `PITCH.md` — pitch prose
- `THREAD.md` — comments
- `SCOPE_MAP.md` — generated; do not edit
- `slices/<slice-id>/` — slice documents

Slice directory:

- `README.md` — frontmatter
- `SPECS.md` — scope/specification
- `TASKS.md` — execution checklist
- `VALIDATION.md` — verification evidence
- `THREAD.md` — comments

Project statuses: `triage`, `shaping`/`shaping:<stage>`, `active`, `ready_to_merge`, `done`, `cancelled`. Slice statuses: `todo`, `in_progress`, `review`, `ready_to_merge`, `done`, `cancelled`.

Use exact `## Tasks` and `## Acceptance Criteria` headings in `SPECS.md`; optional `###` subgroups are supported.

## CLI overview

```bash
yoplai projects list
yoplai projects create --title "My project" --pitch @PITCH.md --repo /path/to/repo
yoplai projects get PRO-1
yoplai projects move PRO-1 active
yoplai slices add --project PRO-1 "First slice" --specs @SPECS.md
yoplai slices list --project PRO-1
yoplai projects start PRO-1 --subagent Worker
yoplai projects status PRO-1 --list
```

Moving project to shaping requires explicit project repo. Area repo may prefill newly created project.

## External subagents

Supported harnesses: `codex`, `claude`, and `pi`. Run modes:

- `none` — no prepared workspace
- `clone` — isolated clone
- `worktree` — isolated git worktree
- `main-run` — project Space worktree

Configured profiles centralize harness/model/reasoning/mode/type. Use `yoplai subagents profiles`; profile-owned fields require `--allow-overrides` before manual override.

## Space workflow

Project Space uses branch `space/<projectId>` and worktree below project `.workspaces/<projectId>/_space`.

- `main-run` executes directly in Space.
- clone/worktree deliveries become pending queue entries.
- integration cherry-picks selected worker commits into Space only on explicit action.
- rebase can refresh Space and pending workers against base.
- conflicts block integration until original worker resolves and re-delivers.
- merge integrates Space into base and may clean branches/worktrees.

Queue states include `pending`, `integrated`, `conflict`, `skipped`, and `stale_worker`. Optional `YOPLAI_SPACE_WRITE_LEASE=true` serializes main-run writers.

## Slice orchestrator

`extensions.projects.orchestrator` can dispatch Worker, Reviewer, and Merger profiles by slice status. It respects blockers, concurrency, cooldown, parent project lifecycle, and HITL notification channel. This is separate from tracker-backed `extensions.orchestrator`.

## Tracker orchestrator

Tracker orchestrator reads per-project `WORKFLOW.md`, polls Linear or Plane, owns protocol workers and recovery, and stores raw runner event JSONL beside workflow project. See [orchestrator README](../packages/extensions/orchestrator/README.md).
