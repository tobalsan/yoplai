---
title: CLI — `yoplai slices add/list/get`
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§8)
---

## What to build

Top-level `yoplai slices` command group with read-side + create verb. Uses storage primitives from #1.

- `yoplai slices add --project <PRO-XXX> "<title>"` — creates slice in `todo`, allocates ID, writes initial files.
- `yoplai slices list [--project <id>] [--status <s>]` — table output.
- `yoplai slices get <sliceId>` — full detail (frontmatter + section bodies).

## Acceptance criteria

- [ ] `yoplai slices add` creates slice on disk and prints new slice ID
- [ ] `yoplai slices list` filters by `--project` and `--status`; works with no flags (lists all)
- [ ] `yoplai slices get <sliceId>` resolves slice across all projects
- [ ] Errors clear when project doesn't exist or sliceId not found
- [ ] CLI tests cover happy paths + filters
- [ ] `pnpm test:cli` passes

## Blocked by

- #1 Slice storage primitives
