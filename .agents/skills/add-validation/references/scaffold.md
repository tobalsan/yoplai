# `## E2E Validation` section scaffold

Fill this template with PRD-specific content. Keep the six parts; drop blocks
that don't apply to the detected surface. Commands come from
`yoplai-commands.md`.

```markdown
## E2E Validation

<One or two sentences: what this feature is, and what this validation proves
beyond unit tests — i.e. the round-trip through the real gateway/UI.>

### 1. Worktree + seed config (skip if already set up)

- Create `~/.worktrees/yoplai/<branch>` and `pnpm install` ONLY if not already
  inside a worktree.
- `pnpm init-dev-config` ONLY if `$CWD/.yoplai` is absent.
- <Add orchestrator/board/extension blocks to `.yoplai/yoplai.json` if the feature
  needs them.>
- <Seed PRD-specific canary projects/slices here.>

### 2. Unit tests

`pnpm test:<package>` — expect <which tests, how many> green.

### 3. Launch preview

`YOPLAI_HOME=$(pwd)/.yoplai pnpm dev` — note the auto-picked ports. Don't touch prod.
<Omit this block for pure-CLI/backend specs.>

### 4. E2E steps

#### 4a. <Scenario name — happy path>
1. <action>
2. Assert: <observable condition>, <condition>, …
3. Capture `validation/01-<name>.png`.

#### 4b. <Scenario name — error/invalid path>
1. <action>
2. Assert: <error rendered>, <no side effect — re-fetch + compare>.
3. Capture `validation/02-<name>.png`.

<…one subsection per scenario: every happy path, error path, edge case, and the
key downstream effect that is the point of the feature.>

### 5. Artifacts

Required under `validation/`:
- `01-<name>.png` … `0N-<name>.png`
- DOM snapshot(s) of <the key element(s) + variant classes>
```

## Notes on writing good steps

- **Concrete, not vague.** "Assert the modal is centered, the overlay is
  non-transparent, the input is auto-focused and equals the current value" beats
  "check the modal looks right". Each assertion should be something an executor
  can mechanically check.
- **Always assert the negative too.** After a cancel/escape/invalid action,
  re-fetch server state and assert it is *unchanged*. The bug is usually a
  silent write.
- **Surface-adapt.** Web UI → click/assert/screenshot via playwright-cli or
  claude-in-chrome MCP. Agent tool / agent behavior → drive the **chat UI**:
  open the chat at the running UI port, send the prompt that should trigger the
  behavior, assert the agent did it and the visible result, screenshot — then
  optionally confirm persisted state via CLI/API. API-only → curl/WS, assert
  response + persisted state.
- **Name the browser tool every time.** Any browser/chat block must say "drive
  with the `playwright-cli` skill or the claude-in-chrome MCP tools
  (`mcp__claude-in-chrome__*`)". Don't write a bare "open the UI" with no tool.
- **Agent-tool specs are UI specs.** A PRD that "gives agents a tool" is proven
  by an agent using it in chat, not by a unit test alone — write that chat
  scenario.
- **Chase the real point.** Many features exist to unblock something downstream.
  Include the step that proves it (e.g. orchestrator dispatches a previously
  stuck slice within two ticks after the repo is set).

---

## Worked example (UI feature — target depth)

This is the PRO-251 edit-repo modal validation, abridged. Note the per-scenario
assertions and the downstream-effect scenario (4h). Match this depth.

```markdown
## E2E Validation

UI feature: a modal + toast that edits a project's repo path. Unit tests cover
modal mechanics; this validation proves the affordance round-trips through the
gateway and unblocks orchestrator dispatch.

### 1. Worktree + seed config (skip if already set up)

- Worktree `~/.worktrees/yoplai/pro-251-edit-repo-modal` + `pnpm install` if not
  already in one.
- `pnpm init-dev-config` if `.yoplai` absent. Add `orchestrator` + `board` blocks
  to `.yoplai/yoplai.json` to match prod.
- Seed two canary projects:
  - (a) one with a valid repo set (`projects update PRO-XXX --repo ~/code/yoplai`)
    — exercises the "edit existing" path.
  - (b) one with no repo — exercises "first-time set" + the orchestrator-pickup
    smoke. Add one slice in `todo` so dispatch has something to pick up.

### 2. Unit tests

`pnpm test:web` — expect all EditRepoModal tests pass, ProjectDetailPage green.

### 3. Launch preview

`YOPLAI_HOME=$(pwd)/.yoplai pnpm dev` — note ports (gateway 4001+, UI 3001+).

### 4. E2E steps

#### 4a. Discoverability + open
1. Navigate to the board, open "canary (with repo)".
2. Assert: no header strip / inline repo widget (negative — took no real estate).
3. Click `Actions ▾`; assert dropdown has `Edit repo…`; click it.
4. Assert: centered modal mounted, dim overlay non-transparent, input
   auto-focused and equal to the current repo path, footer has Cancel + Save.
5. Capture `validation/01-modal-open.png`.

#### 4b. Esc / overlay-click / Cancel dismiss
1. Press Esc; assert modal unmounts, no toast, frontmatter unchanged (re-fetch).
2. Re-open, click the dim overlay; same assertions. Click the panel itself;
   assert it stays mounted.
3. Re-open, type junk, click Cancel; assert unmounts, no toast, junk discarded.

#### 4c. Save success → toast
1. Re-open, set a valid path, Save.
2. Assert: modal closes; success toast top-right with the new path; toast fades
   ~3s; re-fetch → `frontmatter.repo` updated and `repoValid === true`.
3. Capture `validation/02-save-success-toast.png`.

#### 4d. Save invalid → inline error, modal stays open
1. Re-open, enter a non-existent path, Save.
2. Assert: modal stays mounted, inline error under input, no toast, frontmatter
   unchanged on the server (re-fetch + compare).
3. Capture `validation/03-invalid-inline-error.png`.

#### 4e. Empty-string clears repo
1. Re-open, clear input, Save; assert success + `frontmatter.repo` empty.

#### 4f. Keyboard accessibility
1. Open modal, Tab through input → Cancel → Save → loops back (focus trap).

#### 4g. Orchestrator-pickup smoke (the point of the feature)
1. Open "canary (no repo)"; confirm its slice is `todo` and not dispatched.
2. Set the repo via the modal → success toast.
3. Wait one orchestrator tick (`orchestrator.tickSeconds`, default 30s).
4. Assert: the slice leaves `todo` within two ticks. Proof the modal unblocks
   dispatch.
5. Capture `validation/04-slice-dispatched.png`.

### 5. Artifacts

Required under `validation/`:
- `01-modal-open.png` … `04-slice-dispatched.png`
- DOM snapshot of the modal panel (input + buttons + classes) in invalid state
- DOM snapshot of the toast element + its variant class
```
