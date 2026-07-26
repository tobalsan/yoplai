---
title: Reviewer rekey to sliceId
type: AFK
labels: [needs-triage]
spec: docs/specs/kanban-slice-refactor.md (§6.4)
---

## What to build

Rekey Reviewer dispatch + prompt + outcomes from `projectId` to `sliceId`.

- `workerWorkspaces` lookup filters by `sliceId` (most-recent orchestrator-source Worker run on this slice). Single workspace passed in.
- Reviewer reads same project + slice context as Worker (#8).
- Outcomes:
  - **Pass** → slice `review → ready_to_merge`. Project status untouched. User merges branch and manually moves slice to `done`.
  - **Fail** → slice `review → todo` + Reviewer posts a comment to slice `THREAD.md` listing gaps (uses `yoplai slices comment` from #4).
- Reviewer run state carries `sliceId` + `projectId`.

## Acceptance criteria

- [ ] Reviewer dispatched only against slices in `review` whose parent project is `active`
- [ ] `workerWorkspaces` lookup returns the most-recent orchestrator Worker run for that `sliceId`
- [ ] Pass path moves slice to `ready_to_merge` (no auto-cascade to project status)
- [ ] Fail path moves slice back to `todo` AND appends a structured gap comment to slice THREAD
- [ ] Reviewer run state.json includes both `sliceId` and `projectId`
- [ ] `pnpm test:gateway` passes; e2e tracer extension of #8: slice → review → Reviewer pass → `ready_to_merge`

## Blocked by

- #8 Dispatcher + Worker rekey
