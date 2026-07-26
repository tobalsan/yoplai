---
title: Dispatcher + Worker rekey to sliceId
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§6.1–§6.3)
---

## What to build

Rekey orchestrator dispatcher and Worker prompt from `projectId` to `sliceId`. Project becomes a gate.

Dispatcher loop (per status binding in `extensions.projects.orchestrator.statuses`):
1. Enumerate slices in `statusKey` whose parent project is `active`.
2. Filter out slices with active orchestrator runs (via #7 lookup).
3. Filter out slices in cooldown (per-slice tracker, #7).
4. Cap by `max_concurrent` against currently-running matched profile runs.
5. Dispatch profile against each remaining slice. Worker dispatch moves slice `todo → in_progress` (existing lock pattern, now keyed by sliceId).

Worker prompt context:
- Parent project: `README.md` (pitch) + `SCOPE_MAP.md` (sibling slice index, titles only).
- Slice: `README.md` (must/nice) + `SPECS.md` + `TASKS.md` + `VALIDATION.md`.
- Plus a "stay in your slice" clause forbidding modification of other slices' files or project-level docs without explicit instruction.
- On completion: Worker hands off via `yoplai slices move <sliceId> review` (CLI from #4).

Config key stays at `extensions.projects.orchestrator` (no rename — see §6.1). Worktree path: `<worktreeDir>/<PRO-XXX>/<PRO-XXX-Snn>-<slug>/` (§5.8).

## Acceptance criteria

- [ ] Dispatcher enumerates slices in `todo` and filters by parent project `active` status
- [ ] Slices under `shaping` projects are NOT dispatched (visible on board, idle)
- [ ] Per-slice cooldown isolates failures (one bad slice doesn't block siblings)
- [ ] `max_concurrent` per profile honored across active runs
- [ ] Worker prompt includes pitch + scope map + slice docs only (no other slices' files)
- [ ] Worker run sets `sliceId` + `projectId` on its run state
- [ ] Worker completion moves slice `in_progress → review` via `yoplai slices move`
- [ ] Worktree path follows §5.8 layout
- [ ] In-tick `running` flag + `failure_cooldown_ms` dedupe stack carries forward unchanged
- [ ] `pnpm test:gateway` passes; e2e tracer: slice in `todo` under `active` project → Worker dispatched → slice ends in `review`

## Blocked by

- #1 Slice storage primitives
- #4 CLI slice mutations (Worker calls `slices move`)
- #5 Project status refactor (project gate)
- #7 SubagentRun schema
