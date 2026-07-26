# ALG-266 e2e validation notes

- Branch/issue: `alg-266-compact-sidebar` / ALG-266
- Temp home: `.yoplai-e2e` (isolated; never `~/.yoplai`)
- Gateway/UI ports: gateway `http://127.0.0.1:4001`, UI `http://127.0.0.1:3003`
  (auto-picked; 4000/3000 were busy from other runs)

## Bug
The `/compact` command runs an internal summarization turn under an ephemeral
session id `compact:<sessionId>:<uuid>`, which persists a history file that the
sidebar listing (`GET /api/agents/sessions`) surfaced as a duplicate thread
titled "Summarize the conversat…". Fix: exclude `compact:`/`compact-` prefixed
sessions in `sessionIdIsInteractive` (api.core.ts), alongside the existing
scheduler/slack/webhook/bench exclusions.

## Test commands run (serial)
- `pnpm exec vitest run apps/gateway/src/server/api.core.test.ts` → 30 passed
  (includes new test: "excludes ephemeral compact sessions from the sidebar listing")
- `pnpm test:gateway` → 64 files, 363 tests passed
- `pnpm build` → clean (gateway typechecks)

Note: `catalog.test.ts` initially failed only because the `@yoplai/shared/dist`
build artifact was absent in a fresh worktree; after `pnpm build` it passes.
Unrelated to this change.

## Live-stack e2e (real gateway against .yoplai-e2e)
Seeded one runnable agent `sales` under `agents/`, then wrote two real history
files: a genuine session `main123` and the ephemeral
`compact:main123:11111111-…` summarization run (mirroring what compact.ts
produces).

- WITH fix: `GET /api/agents/sessions` returns ONLY `main123` — the compact
  session is filtered out. (evidence: `e2e-with-fix.txt`)
- WITHOUT fix (temporarily reverted the regex on the running source): the
  `compact:main123:…` session LEAKS as a second thread with
  firstUserMessage "Summarize the conversation so …" — reproduces the reported
  bug. (evidence: `e2e-without-fix.txt`)
- Regression guard: after also seeding `scheduler:job1`, `slack:chan1`,
  `webhook:hook1`, `bench-1` history files, the listing still shows only
  `main123` — existing filtering is unchanged. (evidence: `e2e-with-fix.txt`)

## Result
E2E PASS. Acceptance criteria met:
- `/compact` does not create a new sidebar thread (compact session excluded).
- Original thread remains the only one listed and keeps its history.
- scheduler/slack/webhook/bench filtering unchanged.
