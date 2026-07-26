# Yoplai commands for validation steps

Canonical commands to use in generated `## E2E Validation` sections. These are
real `package.json` scripts and conventions in this repo. Verify against
`package.json` if anything here looks stale before writing it into a spec.

## Worktree (conditional)

Create only if NOT already inside a worktree. Branch name usually matches the
PRD/slice.

```bash
git -C ~/code/yoplai worktree add ~/.worktrees/yoplai/<branch> -b <branch>
cd ~/.worktrees/yoplai/<branch>
pnpm install
```

If already in a worktree, skip this — `cd` to the existing one and `pnpm install`
if `node_modules` is missing.

## Seed config (conditional)

Seed only if `$CWD/.yoplai` is absent. This writes `.yoplai/yoplai.json` and
`.yoplai/agents/`.

```bash
pnpm init-dev-config        # = node scripts/create-local-config.js
```

The seed template (`scripts/config-template.json`) ships a minimal config. If
the feature depends on `orchestrator` / `board` / a specific extension being
enabled, the steps must say to add those blocks to `.yoplai/yoplai.json` so the
preview matches prod.

Seed PRD-specific canary projects/slices with the dev CLI:

```bash
YOPLAI_HOME=$(pwd)/.yoplai pnpm yoplai:dev project create "<name>" --area Yoplai
YOPLAI_HOME=$(pwd)/.yoplai pnpm yoplai:dev projects update PRO-XXX --repo ~/code/yoplai
YOPLAI_HOME=$(pwd)/.yoplai pnpm yoplai:dev slices add --project PRO-XXX --specs "<spec>" "<slice title>"
```

## Unit tests (scoped)

Use the scoped script for the changed package — faster and avoids cross-package
flakiness. Run serially (one command at a time).

```bash
pnpm test:web        # apps/web
pnpm test:gateway    # apps/gateway
pnpm test:shared     # packages/shared
pnpm test:cli        # packages/extensions/projects CLI
```

Single file: `pnpm exec vitest run <path-to-test-file>`. Avoid positional
filters (`pnpm test -- <path>`) — unreliable in this repo.

## Launch preview gateway

```bash
YOPLAI_HOME=$(pwd)/.yoplai pnpm dev
```

`pnpm dev` (= `tsx scripts/dev.ts`) auto-picks free ports — gateway 4001+, UI
3001+. Note the chosen ports in the run. Dev mounts the web UI at `/`. Never run
against the prod `~/.yoplai` home.

## CLI / API drive

- CLI: `YOPLAI_HOME=$(pwd)/.yoplai pnpm yoplai:dev <subcommand>` — e.g.
  `project ...`, `subagents ...`, `scheduler ...`, `send`, `agent list`.
- HTTP/WS: hit `http://127.0.0.1:<gateway_port>/api/...` or `/ws` with
  curl / a WS client. Re-fetch state to assert server-side persistence.

## UI browser drive (web UI AND chat UI)

Drive with **either** (name both in the generated steps — don't leave it generic):

- the `playwright-cli` skill (`~/dotagents/skills/browser-testing/playwright-cli`),
  or
- the claude-in-chrome MCP tools (`mcp__claude-in-chrome__*`).

Two kinds of browser scenario:

- **Web UI** — navigate to a page/modal, click, assert rendered state, capture.
- **Chat UI / agent tool** — open the chat at the running UI port, send a prompt
  that should make the agent use the new tool/behavior, assert the agent invoked
  it and the visible result, capture. This is the primary proof for any PRD that
  changes what an agent can do — an agent tool exists to be called from chat, so
  validating it means watching an agent call it there. Confirm persisted state
  afterward via the CLI / a re-read (e.g. `yoplai:dev scheduler list`,
  `.yoplai/agents/<id>/cron/jobs.json`).

Capture numbered screenshots and DOM snapshots into the repo-root `validation/`
directory.

## Artifact location

Repo-root `validation/`. Numbered screenshots (`01-*.png`, `02-*.png`, …) and
DOM snapshots (`*.dom.txt`).
