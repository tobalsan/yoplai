---
title: CLI — `yoplai slices move/rename/comment/cancel`
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§5.4, §8)
---

## What to build

Mutation verbs for slices. Validates status transitions per slice enum (§5.4). Triggers SCOPE_MAP regen (#3) on every mutation.

- `yoplai slices move <sliceId> <status>` — validates target ∈ `{todo, in_progress, review, ready_to_merge, done, cancelled}`. Updates frontmatter `status` + `updated_at`.
- `yoplai slices rename <sliceId> "<title>"` — updates frontmatter `title` + `updated_at`.
- `yoplai slices comment <sliceId> "<body>"` — appends timestamped entry to slice `THREAD.md`.
- `yoplai slices cancel <sliceId>` — sugar for `move <id> cancelled`.

## Acceptance criteria

- [ ] Each verb mutates slice and regenerates SCOPE_MAP
- [ ] Invalid status target rejected with clear message
- [ ] Comment append preserves prior thread content
- [ ] `updated_at` bumped on every mutation
- [ ] CLI tests cover each verb + invalid-input cases
- [ ] `pnpm test:cli` passes

## Blocked by

- #1 Slice storage primitives
- #3 SCOPE_MAP generator
