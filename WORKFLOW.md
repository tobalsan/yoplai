---
tracker:
  kind: linear
  team: ALG
  label: 
    - repo:yoplai
    - repo:yoplai-extensions
  active_states: [Todo, In Progress]
  terminal_states: [In Review, Ready to Merge, Done, Cancelled]
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

Keep that same tracker comment updated with progress, validation results, blockers, and the final handoff, **but only while it is still the newest comment on the issue**. Before every update, re-read the issue's comments. If anyone (a human, Pom, a reviewer or another agent) has commented after yours, do NOT edit your earlier comment: post a new comment instead, and keep updating that new one under the same rule. Editing an older comment makes your update appear above the comments it answers, so readers lose the chronology. Otherwise, do not create a noisy comment stream.

## Dependencies

Before coding, inspect the current issue's dependencies in the configured tracker. Fetch each blocker and confirm it is in a terminal/completed state such as `In Review` or `Ready to Merge` (PR open), `Done`, `Closed`, `Cancelled`, `Canceled`, or `Duplicate`. If any blocker is incomplete, update the tracker comment with the blocker and stop without coding. A blocker in `In Review` or `Ready to Merge` is satisfied: build on its open PR (see **Stacked PRs** below for issues in a project).

For completed blockers, read their comments for prior workspace, branch, commit, and PR notes. If a completed dependency has an available workspace or branch, base your work on it so changes stack instead of diverging.

When this issue is a sub-issue of a parent that has other sub-issues, stack on already-resolved sibling work. Use one PR per parent: if a PR already exists for the parent, push your work onto that branch and update that PR; if no PR exists yet, create one.

When this issue belongs to a tracker **project** (and is not a sub-issue), follow **Stacked PRs** below instead: one PR per issue, stacked with the project's other PRs in the same repo.

## Stacked PRs (issues in the same project)

Issues in the same project ship as a **GitHub stack**: one PR per issue, chained so each PR only shows its own layer. Docs: https://docs.github.com/en/pull-requests/get-started/about-stacked-prs. Tool: the `gh stack` GitHub CLI extension (if `gh stack --help` fails, run `gh extension install github/gh-stack`). It uses the same `GH_TOKEN` as `gh` (see step 6 of the PR flow).

What matters about stacks:
- A stack is a **single linear chain** in **one repo**: the bottom PR targets `main`, every other PR targets the branch of the PR below it. No trees, no cross-repo, no forks.
- Merging is **bottom-up only**. Merging a PR also merges every unmerged PR below it; the PRs above are retargeted automatically.
- Required checks and reviews apply to every PR as if it targeted `main`.
- A stack needs a linear history to merge. When a lower branch changes or `main` moves, the upper branches need a cascading rebase.

Rules:
1. **One stack per (project, repo).** The tracker's blocker graph can be a tree, but a stack is a line, so PRs are appended in the order issues are worked. Your blockers are `In Review`, `Ready to Merge` or `Done` before you are dispatched, so the current top of the stack always contains your unmerged blockers.
2. **Find the stack.** Read the handoff comments / PR links of the project's other issues to find open PRs in your repo. In your workspace clone, run `gh stack checkout <one-of-those-pr-numbers>` then `gh stack view --json` to get the stack number and the top branch. If there is one open project PR but no stack yet, that PR's branch is the top. If no project PR is open in this repo (first issue, or everything already merged), you start from `origin/main`.
3. **Branch from the top.** Create your `<issue-id>-<short-slug>` branch from the top branch (or `origin/main` when starting). This replaces the "base on `origin/main` if it advanced" rule in Workspace: to pick up newer `main`, run `gh stack sync` rather than leaving the stack.
4. **Open the PR yourself, then link it.** Always `gh pr create --base <top-branch>` (or `--base main` when starting) with your own title (including the issue ID) and body, so `gh stack` never auto-generates a PR. Then:
   - first PR in the repo for this project: nothing to link yet;
   - second PR: `gh stack link <first-pr-number> <your-pr-number>` creates the stack;
   - later PRs: `gh stack link <stack-number> <your-pr-number>` appends yours to the top.
5. **Race check before linking.** Other workers in the same project may append at the same time. Right before linking, re-read the stack (`gh stack sync`, then `gh stack view --json`). If the top is no longer the branch you based on: `git rebase --onto <new-top> <old-base>`, rerun your tests, `git push --force-with-lease`, `gh pr edit --base <new-top>`, then link. After linking, confirm with `gh stack view --json` that your PR is on top and not flagged as needing a rebase.
6. **Review only your layer.** Your reviewer subagent reviews `git diff <base-branch>...HEAD`, not the whole stack.
7. **Lower layers belong to their own issue.** Don't patch a lower PR's code from your layer. If your issue *is* the fix for a lower PR (e.g. review feedback): `gh stack checkout <that-pr>`, commit on its branch, `gh stack rebase --upstack`, `gh stack push`. If a rebase conflicts and you can't resolve it confidently, `gh stack rebase --abort`, then move to `Needs Human`.
8. **Non-interactive only.** Always pass explicit arguments. Never run interactive commands (`gh stack modify`, `gh stack switch`, bare `gh stack checkout` / `gh stack submit`); if you use `submit`, pass `--auto`. Never unstack or delete a stack.
9. **Handoff comment** includes: PR URL, stack number, your position in the stack, and the branch directly below yours.
10. **Merging** (whoever merges): bottom-up only, with `gh stack merge <pr-number> --yes --merge` (lands that PR and everything below it in one operation). Only do it when every PR up to that one is approved and green. Don't `gh pr merge` a mid-stack PR, and don't enable auto-merge (unsupported on stacks).

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
3. Spawn a reviewer subagent and ask it to review the code changes (for a stacked PR: only your layer's diff against its base branch).
4. Do not commit until the reviewer comes back clean.
5. After a clean review, commit the work in the worktree.
6. Create or update the GitHub PR using `gh` (for project issues, with the base branch and stack linking from **Stacked PRs**). Mint the token with the repo owner explicit — `GH_TOKEN=$(gh-app-token --owner <owner>)` (e.g. `--owner tobalsan` for `tobalsan/yoplai`). Do NOT call the credential helper without a repo path: with no owner it falls back to the default installation (a different account) and `gh pr create` fails with `Resource not accessible by integration`. `git push` works regardless because git supplies the owner automatically.
7. Link the PR to the current tracker issue when the configured tracker supports it; otherwise include the PR URL in the final tracker comment. If PR can't be linked directly, you must include the issue ID directly in the PR title.
8. Post your final handoff comment.
9. Move the issue to `In Review` **last** (see ordering rule below).

## Blockers

If requirements, ownership, base branch, dependency state, credentials, or validation risk are unclear, ask for human input instead of guessing. Update the tracker comment with the blocker, what you tried, and the decision needed, then move the issue to `Needs Human` and stop.

## Completion

Validate the change before handoff. When the task is complete, leave the issue out of active states: move it to `In Review` when work is done and a PR is open or updated, or to a terminal state only when the workflow explicitly calls for it.

**Ordering rule (important): this governs the FINAL state move only — it does NOT apply to the initial claim.** The claim (move to `In Progress` + comment) always happens first, up front. At completion, the terminal/`In Review` transition must be your LAST tracker action: post the final handoff comment and link the PR FIRST, then move the issue. Moving it out of the active states is the "I'm done" signal and ends your run immediately — any comment you intended to post *after* the move is lost. Always: comment/link → then move.
