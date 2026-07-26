---
title: Project status refactor + cancellation cascade
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§5.4, §5.6)
---

## What to build

Replace legacy project kanban statuses with lifecycle enum: `shaping → active → done` (with `cancelled` terminal branch). Add cascade rules.

- New project status enum: `shaping | active | done | cancelled` (plus existing `archived`).
- `shaping` is starting state; promotion to `active` only manually (gate before orchestrator picks up slices).
- Auto-transition `active → done` when all child slices terminal (`done` or `cancelled`) AND ≥1 is `done`.
- Cancellation cascade: project `→ cancelled` flips every non-terminal child slice (`!= done && != cancelled`) to `cancelled`. Slices already `done` stay `done`. Best-effort SIGTERM on any active orchestrator runs against those slices (full reconciliation parked for v0.4).
- CLI surface: existing `yoplai projects ...` keeps shape; cancel/done semantics gain cascade.

## Acceptance criteria

- [ ] Project frontmatter validates against new enum; legacy values rejected with migration hint
- [ ] Auto active→done fires after the last child slice becomes terminal (and ≥1 done)
- [ ] Project cancel flips all non-terminal slices to `cancelled` in one operation
- [ ] Active orchestrator runs on cascaded slices receive SIGTERM (best-effort)
- [ ] No auto-cascade from Reviewer to project status (ready_to_merge stays slice-local)
- [ ] Unit tests cover cascade + auto-done + SIGTERM dispatch
- [ ] `pnpm test:gateway` + `pnpm test:shared` pass

## Blocked by

- #1 Slice storage primitives
