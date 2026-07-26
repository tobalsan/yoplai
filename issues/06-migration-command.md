---
title: `yoplai projects migrate-to-slices` migration command
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§10)
---

## What to build

Idempotent CLI command that walks every legacy project under `~/projects/` and converts it to the post-refactor layout.

- Refuses to run if gateway PID detected (user stops gateway, migrates, restarts).
- Per project: read existing `SPECS.md` / `TASKS.md` / `VALIDATION.md`; allocate `PRO-XXX-S01`; move them into `slices/PRO-XXX-S01/`; create slice README with frontmatter (title = project title, status mapped per §10.1, hill_position = `figuring`); init slice `THREAD.md`; generate SCOPE_MAP; update project frontmatter to new status enum.
- Status mapping per §10.1 table — `not_now`/`maybe` map to project `shaping` with NO slice created; legacy `archived` unchanged.
- Idempotent: skips projects that already have a `slices/` subtree.
- Project `README.md` and `THREAD.md` left intact (legacy descriptions become the pitch).

## Acceptance criteria

- [ ] Refuses to run with clear error if gateway is running
- [ ] All legacy statuses map per §10.1 table
- [ ] `not_now` / `maybe` projects migrate to `shaping` without auto-creating a slice
- [ ] Re-running the command is a no-op on already-migrated projects
- [ ] Existing run state.json files left untouched (legacy run attribution preserved)
- [ ] Test fixture: one project per legacy status, golden output verified
- [ ] `pnpm test:cli` passes

## Blocked by

- #1 Slice storage primitives
- #3 SCOPE_MAP generator
- #5 Project status refactor
