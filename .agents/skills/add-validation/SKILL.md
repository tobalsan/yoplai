---
name: add-validation
description: >-
  Author an "## E2E Validation" section for a Yoplai spec/PRD, wherever it
  lives. Use this AFTER implementing (or before merging) any Yoplai PRD/spec to
  add concrete, PRD-specific end-to-end validation steps that prove the feature
  round-trips through the real gateway/UI — not just unit tests. Trigger
  whenever the user says "add validation", "write the validation section",
  "validation steps for this spec/PRD", or "how do I e2e-test this slice". This
  skill WRITES the validation plan back to the spec; it does NOT run the
  validation or drive a browser itself.
---

# add-validation

## What this skill does

Read a Yoplai spec/PRD, work out what the feature actually does, and add (or
replace) a `## E2E Validation` section in it. The spec may live anywhere — a
tracker, a doc, a local file — the skill is deliberately agnostic about the
medium. The section is a concrete, runnable validation plan tailored to *this*
PRD — the kind of thing someone (or another Claude session) follows by hand to
prove the feature works against the real gateway and UI before the work ships.

This is a **generator**. It produces the plan as markdown and writes it back to
the spec. It never launches the gateway, never opens a browser, never seeds
config. Those commands live in the section you write so a human or a later
validation run can execute them.

Why a written plan instead of just running it now: validation in Yoplai needs an
isolated worktree, seeded config, and a live gateway on non-prod ports. That is
a deliberate, reviewable sequence. Capturing it in the spec makes it repeatable,
reviewable, and survives across sessions — and keeps authoring (cheap, here) separate
from execution (expensive, isolated).

## Procedure

### 1. Resolve the target spec

Take whatever reference the user gives — a path, an ID, a URL — and read the spec
from there, using whatever tool fits that source. If the user gave nothing, ask
where the spec lives; don't assume. Do not guess silently — the wrong target
writes the plan into the wrong place.

Read the whole spec. Also skim the implementation if it exists (the spec usually
names the touched files/components) so the steps reference real routes, CLI
commands, tool names, and UI affordances rather than invented ones.

### 2. Ground in real Yoplai commands

The generated steps must use commands that actually exist in this repo, not
placeholders. Confirm them from the repo rather than trusting memory — read
`package.json` scripts and `CLAUDE.md`/`AGENTS.md`/`docs/llms.md` if unsure. The
canonical set is in `references/yoplai-commands.md` — read it before writing the
section.

### 3. Detect the surface(s)

A spec can touch more than one. The key question is not "what code changed" but
**"how does a real person observe this feature working?"** In Yoplai almost
everything a user touches reaches them through a browser — either the web UI
directly, or the **chat UI** where they talk to agents. So a feature is "UI" far
more often than its file footprint suggests.

- **Web UI** — web/Solid components, modals, toasts, kanban, pages under
  `apps/web`. Browser-driven.
- **Chat UI / agent-facing** — anything that changes what an *agent* can do or
  how it behaves: new agent tools, prompt/context changes, runtime behavior.
  The whole point of an agent tool is that an agent calls it **from the chat
  UI**, so the end-to-end proof is: open the chat, ask the agent to do the
  thing, and watch it call the tool and report back. This is a browser surface,
  even though no new component was added. Do **not** downgrade these to
  "backend, no UI" — that misses the actual user path.
- **CLI** — `yoplai …` subcommands. Drive with `pnpm yoplai:dev …`. Use as a
  *complement* to confirm persisted state, not as the sole proof for a feature
  that users reach through chat.
- **HTTP/WS API** — routes under `apps/gateway/src/server`, `/api/*`, `/ws`.
  Drive with curl / a WS client.

Reserve "no browser block" for features with genuinely no user-facing path: a
pure internal refactor, a schema/migration with no behavior change, an
extension-internals cleanup. If a person — directly or via an agent in chat —
can perceive the change, there is a browser scenario, and you must write it.
When unsure which surface dominates, ask.

### 4. Extract behaviors into concrete assertions

This is the heart of the skill. Walk the spec's acceptance criteria and
user-facing behaviors and turn each into a **concrete, numbered step**: an
action, the assertion(s) it must satisfy, and (for UI) the artifact to capture.
Aim for the specificity of the worked example in `references/scaffold.md`
(open → assert overlay/focus/value → capture screenshot), not vague outlines
like "test the modal works".

Cover, where the PRD implies them: the happy path, each error/invalid path, edge
cases the spec calls out (empty input, missing prerequisite, permission denied),
and any downstream effect that is the actual point of the feature (e.g. "setting
the repo unblocks orchestrator dispatch"). If a behavior has no observable
assertion, it is not a validation step — drop it.

### 5. Compose the section from the scaffold

Use the template in `references/scaffold.md`. The standard skeleton:

1. **Preamble** — one or two sentences: what this feature is and what the
   validation proves beyond unit tests.
2. **Setup (conditional)** — worktree + seed config. State the conditions
   plainly: create the worktree at `~/.worktrees/yoplai/<branch>` **only if not
   already inside a worktree**; seed config **only if `$CWD/.yoplai` is absent**.
   Otherwise reuse what exists. Then any PRD-specific canary projects/slices.
3. **Unit tests** — the scoped test command(s) for the changed package(s).
4. **Launch preview** — `YOPLAI_HOME=$(pwd)/.yoplai pnpm dev` (auto-picks free
   ports; note them; never touch prod). Needed for any browser scenario
   (web UI or chat UI). Omit only for the rare spec with no user-facing path.
5. **E2E steps** — the concrete assertions from step 4, grouped by scenario and
   surface-adapted.
6. **Artifacts** — list the required files under the repo-root `validation/`
   directory (screenshots, DOM snapshots).

**Browser-tool naming is mandatory for every browser/chat step block.** Whenever
a scenario is driven through the browser — a web-UI interaction *or* an
agent-tool exercised from the chat UI — instruct the executor to drive it with
**either the `playwright-cli` skill or the claude-in-chrome MCP tools**
(`mcp__claude-in-chrome__*`). Name both explicitly, in that block; never leave it
as a generic "drive the UI" or assume the reader knows the tool. Capture numbered
screenshots and DOM snapshots into `validation/`. A chat-driven scenario reads
like: open the chat at the running UI port → send the prompt that should make the
agent call the tool → assert the agent invoked it and the visible result/state →
screenshot. CLI/API checks may accompany this to confirm persistence, but the
browser scenario is the primary proof.

Do **not** include a THREAD/handoff log step, a formal sign-off/gate checklist,
or a teardown step — those were intentionally cut. Keep the section to the six
parts above.

### 6. Write the section back to the spec (idempotent)

Write the section into the spec's body using whatever tool fits where it lives,
following the same idempotent rule everywhere: if a `## E2E Validation` section
already exists, **replace it in place** — from that heading down to the next
sibling `##` heading (or EOF if it's last). Otherwise append it at the end.
Re-running the skill converges, never stacks duplicate sections. If the spec's
body isn't an editable home (or a long plan would bury a short body), post the
section as a comment instead and say which you did.

After writing, tell the user where it landed and give a two-line summary of which
surfaces you covered and how many scenarios.

## Reference files

- `references/yoplai-commands.md` — canonical Yoplai dev/test/seed/CLI commands to
  use in generated steps. Read before writing.
- `references/scaffold.md` — the section template plus a full worked example
  (the PRO-251 edit-repo modal validation) showing the target depth.
