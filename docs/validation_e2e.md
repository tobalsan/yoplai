# E2E Validation Playbook

Use this after finishing any ALG-339 child issue. Unit tests are still required,
but the issue is not done until the changed behavior is proven against a real
gateway, a real web UI, and an isolated `YOPLAI_HOME`.

This document is a reusable recipe. Each worker should adapt the final scenario
steps to the slice they implemented.

## Principles

- Never validate against `~/.yoplai` or a real customer config.
- Always use a temporary `YOPLAI_HOME` inside the working repo.
- Always launch the actual gateway/web stack, not only unit tests.
- Capture evidence under `validation/`.
- Keep the seeded config minimal. Add only the pool agents, fork dirs, teams,
  users, and auth state needed by the slice.

## 1. Prepare a Temporary Home

From the repo root:

```bash
rm -rf .yoplai-e2e validation
mkdir -p .yoplai-e2e/{pool,agents} validation
```

Create two tiny pool agents. Keep them cheap and deterministic; the goal is to
validate routing/access/UI, not model quality.

```bash
mkdir -p .yoplai-e2e/pool/sales .yoplai-e2e/pool/support

cat > .yoplai-e2e/pool/sales/agent.yaml <<'EOF'
id: sales
name: Sales
role: Sales Assistant
description: Handles sales handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Sales test agent. Reply with "sales-ok".
EOF

cat > .yoplai-e2e/pool/support/agent.yaml <<'EOF'
id: support
name: Support
role: Support Assistant
description: Handles support handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Support test agent. Reply with "support-ok".
EOF
```

Write the temporary config:

```bash
cat > .yoplai-e2e/yoplai.json <<'EOF'
{
  "version": 3,
  "pool": "pool/*",
  "agents": "agents/*",
  "gateway": {
    "host": "127.0.0.1",
    "port": 4000
  },
  "ui": {
    "enabled": true,
    "port": 3000
  },
  "extensions": {
    "multiUser": {
      "enabled": true,
      "oauth": {
        "google": {
          "clientId": "e2e-google-client",
          "clientSecret": "e2e-google-secret"
        }
      },
      "sessionSecret": "e2e-session-secret-at-least-32-characters"
    }
  }
}
EOF
```

If the slice needs a pre-existing runnable agent, copy one from `pool` into
`agents` and update the config or database link state required by the slice.
Do not point this temp config at a real Yoplai/customer pool unless the slice
specifically needs those definitions.

## 2. Run Required Tests First

Run the scoped tests for the changed packages, serially:

```bash
pnpm test:shared
pnpm test:gateway
pnpm test:web
```

For narrow changes, an exact test file is fine:

```bash
pnpm exec vitest run <path-to-test-file>
```

Do not use `pnpm test -- <path>`.

## 3. Launch the Real Stack

Start the dev gateway/web stack with the temporary home:

```bash
YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev
```

`pnpm dev` auto-picks free ports if `4000` or `3000` are busy. Record the actual
gateway and UI ports printed in the banner. Leave this process running; use a
second terminal/pane for browser, API, and SQLite checks.

Use those ports for every command below:

```bash
export YOPLAI_E2E_HOME="$(pwd)/.yoplai-e2e"
export YOPLAI_E2E_API="http://127.0.0.1:<gateway-port>"
export YOPLAI_E2E_UI="http://127.0.0.1:<ui-port>"
```

## 4. Seed Slice-Specific State

Seed only what the issue needs.

Examples:

- Superadmin/role issue: create first user, verify it becomes `superadmin`,
  then promote/demote another user.
- Teams CRUD issue: create a team, edit name/description/color/icon, delete it.
- Membership issue: create two users and two teams, assign one user to both.
- Agent assignment issue: assign `sales` from the pool, verify a runnable fork
  appears under `.yoplai-e2e/agents`.
- Access issue: create one allowed user and one denied user, then prove chat/API
  access differs.
- UI action-state issue: create pool agents covering each state: no fork,
  fork assigned to user's team, fork assigned to another team, teamless fork.

Prefer public/admin APIs or UI flows. Direct SQLite writes are acceptable only
when the slice under test is not responsible for creating that data.

## 5. Validate Through the Browser

Drive browser scenarios with either the `playwright-cli` skill or the
claude-in-chrome MCP tools. Save screenshots and DOM snapshots into
`validation/`.

Minimum browser checks for ALG-339 slices:

1. Open `${YOPLAI_E2E_UI}` and confirm the app is using the temp home data.
2. Open `/agents` and confirm pool agents render from `.yoplai-e2e/pool`.
3. Open `/teams` and verify the slice-specific team UI behavior.
4. If the slice changes auth/access, validate with at least two users:
   one allowed and one denied.
5. Capture `validation/01-*.png` plus a matching `validation/01-*.dom.txt`
   for each meaningful state.

For chat/access slices, browser validation must prove the actual user path:

- An allowed user can reach the chat action and send to the assigned agent.
- A denied user can see the pool/team information but cannot chat/run it.
- A staff user can bypass team membership when the PRD says staff bypass applies.

## 6. Validate APIs and Persistence

After the browser check, re-fetch server state.

Useful probes:

```bash
curl -s "$YOPLAI_E2E_API/api/capabilities" | jq .
curl -s "$YOPLAI_E2E_API/api/pool" | jq .
curl -s "$YOPLAI_E2E_API/api/agents" | jq .
```

Inspect persisted files:

```bash
find "$YOPLAI_E2E_HOME" -maxdepth 3 -type f | sort
sqlite3 "$YOPLAI_E2E_HOME/auth.db" '.tables'
```

For assignment/access slices, verify both sides:

- Filesystem: fork folders exist or remain absent as expected.
- Database: team, membership, and agent-team link rows match the UI.
- Runtime/API: allowed users can access the agent; denied users cannot.

## 7. Guard-Surface Checklist

Use this when the slice touches access control.

Prove the denied user is blocked from every surface implemented by that slice:

- `/api/agents`
- `/api/agents/:id`
- `/api/agents/:id/history`
- REST run dispatch
- WebSocket send
- WebSocket subscribe/status, when applicable
- upload/media routes tied to agent sessions, when applicable
- bearer/API-token access, when applicable

Do not stop at "the Chat button is hidden". Hidden UI is not an access control
proof.

## 8. Evidence to Leave Behind

Leave `validation/` with:

- screenshots for each browser state;
- DOM snapshots for those states;
- a short `validation/notes.md` containing:
  - branch/issue id;
  - temp home path;
  - gateway/UI ports;
  - test commands run;
  - browser scenarios completed;
  - API/persistence checks completed;
  - any known gap.

If a validation step cannot be run, say why in `validation/notes.md` and in the
issue handoff. Do not claim E2E coverage for a path that was not exercised.
