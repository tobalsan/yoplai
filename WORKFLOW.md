---
tracker:
  kind: linear
  team: ALG
  label: 
    - repo:yoplai
    - repo:yoplai-extensions
  active_states: [Todo, In Progress]
  terminal_states: [In Review, Done, Cancelled]
  needs_human: "Needs Human"

polling:
  interval_ms: 10000
  max_concurrent: 5
  max_retries: 3
  retry_backoff_ms: 30000

workspace:
  root: $AGENT_HOME/workspaces
  cleanup_on_terminal: true
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}

These instructions are prompt-level worker guidance. They describe what you must do; they are not daemon or orchestrator behavior.

## Required Claim Step

Do this FIRST, before any task work — it is mandatory and unconditional. The completion "ordering rule" below does NOT apply here; the claim always leads.

**Tracker access:** first inspect the configured tracker (`tracker.kind` in WORKFLOW.md frontmatter). Use only that tracker; never assume any default.

- For `linear`, use the host-provided `linear_graphql` tool for all tracker reads/writes.
- For `plane`, use the host-provided `plane_api` tool for all tracker reads/writes, using its configured workspace/project scope and the current issue ID from `AGENT_ISSUE_ID` when a UUID is required.
- Do not read tokens, `.env` files, or probe credentials. Host tools hold authentication. Do not use interactive credential tools such as `op` or `gh auth`.

1. Fetch the current issue from the configured tracker.
2. If its current state is `Todo`, move it to `In Progress` immediately.
3. Read its comments and incorporate updated requirements.
4. Add one concise tracker comment saying you are working on it (the claim comment).
5. Continue only after those tracker updates succeed.

Keep that same tracker comment updated with progress, validation results, blockers, and the final handoff. Do not create a noisy comment stream.

## Dependencies

Before coding, inspect the current issue's dependencies in the configured tracker. Fetch each blocker and confirm it is in a terminal/completed state such as `Done`, `Closed`, `Cancelled`, `Canceled`, or `Duplicate`. If any blocker is incomplete, update the tracker comment with the blocker and stop without coding.

For completed blockers, read their comments for prior workspace, branch, commit, and PR notes. If a completed dependency has an available workspace or branch, base your work on it so changes stack instead of diverging.

When this issue is a sub-issue of a parent that has other sub-issues, stack on already-resolved sibling work. Use one PR per parent: if a PR already exists for the parent, push your work onto that branch and update that PR; if no PR exists yet, create one.

## Workspace

**Never work directly in the referenced repository.** Any local repo path in the issue description (or its parent/siblings) is provided **for reference only** — to help you identify the repo and read existing code. It is NOT your working directory. Treat it as read-only: do not create branches, commit, or make edits there. Editing the referenced clone directly corrupts a shared checkout and is a hard failure of this workflow.

**Always work inside your own issue workspace** — the `workspaces/<issue_id>` folder under your agent folder root. Everything you produce (clones, worktrees, checkouts, scratch files) lives here. If a repo or extra checkout is needed and does not already exist in your workspace, clone or create it inside `workspaces/<issue_id>` — never reuse or mutate the reference path in place.

Concretely, to obtain the code for a repo whose reference path you were given: create a fresh git worktree (or clone) **into your issue workspace** from the correct base branch, and do all work there. The reference path is only for reading; your workspace copy is the only place you change anything.

For code changes, create a git worktree — **inside your issue workspace** — from the correct base branch: a completed dependency's branch/workspace when available, otherwise the repository's main branch unless the issue says otherwise. Before reusing a dependency's or parent PR branch, fetch and compare it against `origin/main`: if `origin/main` has advanced beyond that branch (it contains commits the branch lacks), base on `origin/main` instead — the blocker's PR may already be merged or stale. Pick whichever is most up to date.

## Repo-specific instructions

Reference repos:
- Platform repo: https://github.com/tobalsan/yoplai.git (local: {{ workflow.dir }}).
- Extensions repo: https://github.com/algodynai/yoplai-extensions.git

Refer to the issue label for repo identification.
If it's not perfectly clear which repo to use, do not make unreliable assumptions, instead park the issue to "Needs Human" and add a comment signaling you need human input to specify which repo to use.
If the repo you work on contains an AGENTS.md file, you **must follow its instructions**.

**E2E validation is not optional.** If AGENTS.md (or any file it points to, e.g. `./docs/validation_e2e.md`) instructs you to run an end-to-end validation for your kind of change, you **must actually run it** — not just read the doc. Unit tests (`vitest`, `pnpm test:*`) do NOT satisfy an e2e requirement. For any user-facing change where such instructions exist, you must:

1. Follow the e2e playbook exactly (launch the real gateway/UI against an isolated home, seed the minimal config, exercise your slice's behavior end-to-end).
2. Capture the evidence the playbook asks for (screenshots, logs, API/DOM transcripts).
3. Report the e2e PASS/FAIL — per behavior — in your tracker handoff comment, with the commands run and evidence file names.

If a genuine harness limitation blocks a real e2e run (missing deps, cannot bind ports, fake OAuth preventing user creation, etc.), state it **explicitly** as a harness gap in your handoff — never silently skip the e2e or substitute unit tests and call it validated. Do not move the issue out of active states until the e2e is either done or the gap is documented.

## Review And PR Flow

When code changes are needed:

**Create a new branch named `<issue-id>-<short-slug>` before any commit; never commit to or push `main`.**

1. Make the focused change in the issue worktree.
2. If the repo has a `CHANGELOG.md`, add a concise line for your change in the same PR under the `## [Unreleased]` section (Added/Changed/Fixed) — create that section at the top if it is missing. User-facing changes only; skip pure chore/test/docs churn.
3. Spawn a reviewer subagent and ask it to review the code changes.
4. Do not commit until the reviewer comes back clean.
5. After a clean review, commit the work in the worktree.
6. Create or update the GitHub PR using `gh`. Mint the token with the repo owner explicit — `GH_TOKEN=$(gh-app-token --owner <owner>)` (e.g. `--owner tobalsan` for `tobalsan/yoplai`). Do NOT call the credential helper without a repo path: with no owner it falls back to the default installation (a different account) and `gh pr create` fails with `Resource not accessible by integration`. `git push` works regardless because git supplies the owner automatically.
7. Link the PR to the current tracker issue when the configured tracker supports it; otherwise include the PR URL in the final tracker comment. If PR can't be linked directly, you must include the issue ID directly in the PR title.
8. Post your final handoff comment.
9. Move the issue to `In Review` **last** (see ordering rule below).

## Blockers

If requirements, ownership, base branch, dependency state, credentials, or validation risk are unclear, ask for human input instead of guessing. Update the tracker comment with the blocker, what you tried, and the decision needed, then move the issue to `Needs Human` and stop.

## Completion

Validate the change before handoff. When the task is complete, leave the issue out of active states: move it to `In Review` when work is done and a PR is open or updated, or to a terminal state only when the workflow explicitly calls for it.

**Ordering rule (important): this governs the FINAL state move only — it does NOT apply to the initial claim.** The claim (move to `In Progress` + comment) always happens first, up front. At completion, the terminal/`In Review` transition must be your LAST tracker action: post the final handoff comment and link the PR FIRST, then move the issue. Moving it out of the active states is the "I'm done" signal and ends your run immediately — any comment you intended to post *after* the move is lost. Always: comment/link → then move.
