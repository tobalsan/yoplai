# Session model routing

Why: routing matches each chat session to a model suited to the task, so quick lookups use a fast model and deep work gets a stronger one. It also spreads usage across the Claude and ChatGPT subscriptions instead of exhausting one mid-week while the other sits underused.

Model routing chooses a model once for a chat session of an opted-in Pi agent. It supports host and sandboxed Pi agents; container E2E is **not verified** yet ([ALG-608](https://linear.app/algodyn/issue/ALG-608/model-routing-container-runtime-e2e-in-process-adapter-runner-bridge)). Start with `off`, observe `shadow`, then enable `enforce` on one agent at a time.

See the [configuration reference](configuration.md#model-routing) and [example routing table](examples/model-routing.json). Routing is off by default and also requires the agent's `modelRouting.enabled: true`.

## Eligible turns and the decision

Routing runs for non-empty human messages from web, Slack, Discord, Telegram, Mattermost, or IRC. Explicit model overrides, agent-origin messages, background work, non-Pi agents, and `compact:`, `scheduler`, or `dream:` sessions bypass routing and its locks. Scheduler, subagent, dream, compaction, heartbeat, webhook, and other automation runs keep their configured model.

Until a session has a lock, a bounded OpenAI classifier asks whether the current message is a real work request. A `no` answer, such as a greeting, uses the usual `agent.model` and leaves the session unlocked. A `yes` answer classifies the message against the eligible table categories in two concurrent option orders. The router averages each category's probabilities and uses the highest average as its score. At or above `thresholds.score` (default `0.80`), the table supplies the model picks and the quota policy chooses a pool. Below that threshold, the router locks a snapshot of the usual model instead. There is no default category.

The classifier needs a non-empty `OPENAI_API_KEY` in the gateway process environment or `$YOPLAI_HOME/.env`. This is separate from a ChatGPT/Codex subscription login; agent-local credentials do not satisfy it. Missing, empty, or whitespace-only keys return `no_key` before creating a classifier runtime. Predicate and category deadlines default to 2000 ms and 4000 ms; both category orders share the category budget. Classifier unavailability leaves chat on the usual model without a lock, so a later eligible message can try again.

Source: [classifier](../apps/gateway/src/model-routing/classifier.ts), [session router](../apps/gateway/src/model-routing/session-router.ts).

## The durable lock

The router writes `modelRoute` into canonical history metadata before executing a pick. It is scoped by history owner, agent, and session, and contains `version: 1`, `kind` (`routed` or `usual`), `mode`, `provider`, `model`, optional `effort`, `category`, `score`, `tableVersion`, optional `pool`, `reason`, and `decidedAt`. It contains no message text or credentials. Reusing a lock makes no classifier call or new decision log entry.

A lock applies only when both the current mode and the stored lock mode are `enforce`. `shadow` stores the proposal while executing the usual model with its usual effort and fallback; a shadow lock is never promoted by changing the mode. An enforce lock survives gateway restart and compaction. Compaction's summary run uses the usual model without changing the chat's lock. Eligible follow-ups arriving during an unlocked run wait for a separate routing turn; native queueing resumes once a lock exists.

`/new hi` with a logical `sessionKey` and no explicit `sessionId` rotates to a new unlocked session; the old session keeps its history and lock. Bare `/new` returns the introduction without a model call. Session deletion through the API calls `resetSession`, removing canonical history and its lock. `/new` does not rotate an explicitly addressed session ID.

Effort precedence is the request's explicit `thinkLevel`, then the current message's `/think` directive (OAuth agents only), then route effort, then the agent default. Every applied enforce lock suppresses `fallback_model`, including a `usual` lock. Shadow and unlocked sessions retain the configured fallback.

If the locked model fails terminally after its normal retry policy, the normal failure notice reaches history/events and the lock stays. The router does not silently switch providers. Retry uses the same locked model; start `/new` for a fresh routing decision.

Source: [session router](../apps/gateway/src/model-routing/session-router.ts), [runner](../apps/gateway/src/agents/runner.ts), [session bindings](../apps/gateway/src/sessions/store.ts), [session reset](../apps/gateway/src/sessions/persistence.ts).

## Quota policy

The production reader uses only this gateway host's OAuth logins for `anthropic` (Claude pool) and `openai-codex` (ChatGPT pool), independently of the table's chat model IDs. It reads local credentials and the local in-memory store; a routing decision does not refresh tokens or call a vendor.

When both pools have known quota, one exhausted 5-hour window sends the session to the other pool. If both are exhausted, chat uses the usual model and no lock is written. An absent 5-hour window, as in the Pro-shaped fixture, is not exhaustion. Otherwise:

- `either` chooses the lower weekly pace when both paces are known (Claude on a tie).
- `prefer_claude` or `prefer_chatgpt` chooses that pool unless its known pace exceeds `thresholds.pace` (default `1.15`), then chooses the other.
- Weekly pace is the used fraction of allowance divided by the elapsed fraction of the weekly window, with elapsed time floored at 5%.

Missing login/data, error-only observations, stale readings, or a passed reset boundary make quota unknown. Observations older than 20 minutes are stale. On an `either` row, missing comparable quota produces no pool and a `usual` lock with `quota-unknown` or `quota-stale`; a preferred row may still use its configured preferred pool. If reading the store throws, chat continues on the usual model with no lock (`quota-unavailable` in the decision log, `quota-read-failed` in the attempt).

Source: [quota reader](../apps/gateway/src/model-routing/quota-reader.ts), [pool selection](../apps/gateway/src/model-routing/pool.ts), [quota policy](../apps/gateway/src/model-quota/policy.ts), [freshness constants](../apps/gateway/src/model-quota/constants.ts).

## Poller ownership per host

Each gateway process polls only OAuth logins in its own `$YOPLAI_HOME/auth.json`, only when `modelQuota.enabled` is true at startup. Pollers run on the host, not in containers. Containers send sanitized quota frames to their host; refresh tokens stay on the host. Passive Claude response-header capture runs even with polling disabled.

Keep the deployment stores separate:

| Host | Subscription ownership | ChatGPT windows |
| --- | --- | --- |
| Personal/test host | the operator's own Claude and ChatGPT Pro logins | Weekly only |
| Production host | the organization's Claude and ChatGPT Plus logins | 5-hour and weekly |

These are the intended host assignments, not a live subscription audit. No login, token, or quota snapshot is shared between hosts. Copying one host's `auth.json` to another to share a login is unsupported. Each host owns its token refresh and poller. The quota store is in memory and refills from local header observations/polling after a gateway restart; snapshots are not persisted or replicated.

Open **Admin → Quota** or `/admin/quota` to inspect the host's sanitized store. In multi-user mode, only superadmins can see the tab, page data, or `GET /api/admin/model-quota`; admin/user direct visits show `Superadmin access required.` and the API returns `403 {"error":"forbidden"}`. Single-user mode allows the local operator (API `200`). An empty store shows the `modelQuota.enabled` hint only when polling is off; viewing the page never calls a vendor.

Source: [quota runtime](../apps/gateway/src/model-quota/runtime.ts), [pollers](../apps/gateway/src/model-quota/pollers.ts), [container token handling](../apps/gateway/src/sdk/container/oauth-tokens.ts), [quota page](../apps/web/src/pages/admin/Quota.tsx).

## Rollout

### Step 0: prepare each host

1. Set `OPENAI_API_KEY` for the gateway without committing it.
2. Set `modelQuota.enabled: true` on each host using subscriptions, verify that host's own logins, then restart to start its pollers.
3. Install/review the [routing table](examples/model-routing.json), its version, model IDs, efforts, category definitions and floor. Startup validates catalog/model/effort/category compatibility; hot reload validates structure only.
4. Opt in one Pi agent in its `agent.yaml`:

   ```yaml
   modelRouting:
     enabled: true
   ```

### Step 1: shadow one agent

Set root `modelRouting.mode: "shadow"`, restart after setting up the table, and use fresh sessions. Confirm the usual model still answers while a work request records the proposed pick. Watch `[model-routing] decision` for `mode`, `kind`, `category`, `score`, `tableVersion`, `pool`, `reason`, and `latencyMs`; inspect the reason distribution and unavailable rate. The log contains decision metadata, not message text or credentials.

Collect a useful shadow window and run the report below. Its detection numbers are proxies, so do not treat high confidence as measured classification accuracy. Investigate unavailable calls, missing lock attempts, quota age, and unexpected execution mismatches before enforcement.

### Step 2: enforce the same agent

Set `modelRouting.mode: "enforce"` and restart for the first switch to enforcement so startup catalog validation runs. Shadow-locked sessions stay on the usual model. New sessions and existing still-unlocked sessions route on their next eligible turn. Confirm the persisted pick, actual model, effort, failure notice, and quota pool decision for the pilot agent.

### Step 3: widen agent by agent

Keep the table version and observation window with the rollout record. Opt in the next agent, check its eligible categories, then repeat shadow review and enforcement checks before widening again. Agent opt-in and routing mode use hot reload; validate table changes with a restart.

## Rollback and reload timing

Set root `modelRouting.mode: "off"` to roll back globally, or remove one agent's opt-in to roll it back individually. After the config reload, following turns bypass locks and use the usual model/effort/fallback. Running turns are not interrupted. Locks stay on disk; stored enforce locks resume when mode returns to `enforce` and the agent is opted in. Stored shadow locks remain unapplied.

The gateway polls config mtimes every 5000 ms by default. Wait for a successful reload before sending the verification turn; a failed reload retains the previous config. Routing reads the current config each turn. A table change or first switch to `enforce` should be followed by a restart because model catalog, effort and category validation runs at startup only. Changing `modelQuota.enabled` also requires restart to change poller startup behavior. Restart loses the in-memory quota observations, so check quota readiness again.

Source: [hot reload](../apps/gateway/src/config/hot-reload.ts), [startup validation](../apps/gateway/src/config/validate.ts), [gateway startup](../apps/gateway/src/cli/gateway.ts), [session router](../apps/gateway/src/model-routing/session-router.ts).

## Telemetry and the shadow report

`modelRoute` is the durable lock. `modelRouteAttempt` is separate, best-effort telemetry: every eligible unlocked turn that reaches the classifier appends an attempt, including predicate `no` or unavailable results. Appends are asynchronous; a completed reply does not guarantee the attempt is already on disk. Locked and off-mode turns add no attempts. Attempts contain routing facts, timings, quota state and proposed versus actual models, without message text, prompts, credentials, or account identifiers. `actual` is the router's choice, before any later adapter fallback.

Optional trace metadata contains `routingMode`, `routingTableVersion`, `routingState`, `routingActual`, and, with a lock, `routingProposed`, `routingCategory`, `routingScore`, and `routingPool` for routed locks. Local history/reporting does not require Langfuse.

```bash
yoplai model-routing report --since <ISO-date> [--until <ISO-date>] [--agent <id>] [--json] [--out <file>]
```

`--since` is required; dates accept `YYYY-MM-DD` or timestamps with a timezone. Repeat `--agent` to select multiple agents; `--json` includes session rows, and `--out` writes the chosen format to a file. The command reads root and per-user canonical histories locally without vendor calls.

Only fresh sessions whose first user entry falls at or after `since` and before `until` are included, and only if they contain a valid attempt or lock. Sessions with neither routing record never count. Mixed-mode and enforced sessions are counted separately from shadow metrics. The report groups table versions and flags sessions spanning versions.

A shadow session with a lock but no uniquely matching lock attempt stays in population and outcome counts and contributes to `outcomes.lockAttemptMissing`. It is excluded from usable-session detection, score, quota and proposed-model split metrics. Its recorded attempts still contribute to `detection.unavailableAttempts` and latency/integrity data. Read the reported denominators; an unavailable share is not necessarily over all sessions.

The seven-day warning uses the span between the earliest and latest routing records across included sessions (`window.days`), not the requested `--since`/`--until` interval. It appears when that record span is below seven days; an empty population has no span. Detection metrics are proxies (first yes, attempts until yes, possible misses, unavailable attempts), not human-label accuracy. Label scoring is [ALG-604](https://linear.app/algodyn/issue/ALG-604/model-routing-report-score-real-request-detection-against-a-labels). Execution mismatch flags compare recorded router choice with available assistant model metadata; investigate later fallback/retry and incomplete correlation rather than assuming a router switch.

Source: [attempt records](../apps/gateway/src/model-routing/attempt.ts), [report](../apps/gateway/src/model-routing/report.ts), [history reader](../apps/gateway/src/model-routing/session-reader.ts), [CLI](../apps/gateway/src/cli/model-routing.ts).

## Troubleshooting

| Decision log reason | Meaning / next check |
| --- | --- |
| `no` | Predicate did not find work; usual model, session remains unlocked. |
| `no_key` | Check gateway-process/root `.env` `OPENAI_API_KEY`; subscription OAuth is separate. |
| `timeout`, `aborted` | Check stage budgets and request cancellation; chat proceeds without a new lock. |
| `refusal`, `malformed`, `provider_error` | Classifier unavailable; inspect classifier/provider diagnostics and the next attempt. |
| `category-unavailable` | Selected category was absent from the current table; check table/category configuration. |
| `score<0.8` (or the configured threshold) | Confidence below threshold; a `usual` lock was stored. |
| `5h-exhausted` | Both pools known; the other pool was selected. |
| `both-5h-exhausted` | Both pools exhausted; usual model, no lock, later turn may retry. |
| `pace`, `preference` | Pool selected by weekly pace or configured preference. |
| `quota-unknown`, `quota-stale` | Check the host's own login, Quota page, poller and observation age; `either` locks usual, a preferred row may use its preference. |
| `lock-read-unavailable`, `lock-write-unavailable` | Check local canonical-history access; chat uses the usual model without executing an unrecorded pick. |
| `classifier-unavailable`, `quota-unavailable` | Unexpected classifier/quota read failure; chat uses the usual model without a new lock. |

Reusing a stored lock emits no new decision line; inspect its `modelRoute` and trace metadata. A normal failure notice on a locked session does not authorize provider fallback. Retry or start `/new`; use `off` for an operator rollback.

## Live canary checklist — run only after the operator authorizes it

The host suite does **not** run a live canary. Real classifier calls, subscription usage and cross-vendor history acceptance require separate authorization.

- [ ] Record the authorization, host, pilot agent, table version, observation window, and rollback owner.
- [ ] Check that host's own logins, classifier key, poller startup and fresh quota; never copy credentials between hosts.
- [ ] Start one agent in shadow with fresh sessions; verify usual-model execution, attempt persistence and proposed-model distribution.
- [ ] Collect at least seven days for the report; review unavailable reasons, score distribution, quota age, lock-attempt integrity and detection proxies.
- [ ] Authorize enforcement separately for the pilot; restart and verify fresh work routes once, follow-ups stay locked, and effort reaches the model.
- [ ] Verify real cross-vendor greeting/history replay; faux providers prove gateway replay only, not vendor acceptance.
- [ ] Verify a controlled locked-model failure shows the normal notice without silently calling the fallback; retry or `/new` recovers as expected.
- [ ] Switch to `off`, wait for reload, verify the next turn uses the usual model; restore `enforce` and verify the stored enforce lock resumes.
- [ ] Record evidence and remaining unknowns before widening agent by agent; container E2E remains ALG-608 until verified there.

## How this is verified

The [host integration suite](../container/agent-runner/tests/model-routing-e2e.test.ts) runs 11 scenario rows through the real REST route, `runAgent` and Pi adapter. Run it with `env -u YOPLAI_HOME pnpm test:e2e:routing`: all 11 host rows, the report round-trip and the three [WS/Slack/Discord parity cases](../container/agent-runner/tests/model-routing-entry-parity.test.ts) passed in ALG-598. The hot-reload row waits for the real reload callback and proves the next turn changes mode while a running turn finishes unchanged. The [harness](../container/agent-runner/tests/model-routing-harness.ts) accepts a runtime parameter so ALG-608 can add container execution without duplicating scenario rows.

Container E2E, live vendors/subscriptions, a real classifier quality check and real cross-vendor acceptance are **not verified** by this host suite. The manual real-stack check used dummy local accounts and a loopback fake chat provider: quota render/access by role, single-user quota access, missing-key chat and an actual process restart all passed. See [the E2E playbook](validation_e2e.md) and the PR evidence for executed commands and results.
