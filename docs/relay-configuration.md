# Remote configuration transport

Status: round 3a supplies the transport only. Round 3b must connect the pages and test the browser flows.
The full remote configuration batch is not complete.

## Target selection

`/api/relay/gateways/:name` selects one linked gateway before an allowed `/api/...` path.
The name comes from the local link store. The caller cannot supply a gateway URL.
The relay keeps no global target state.

Agent paths, `agent` query fields, and the schedule create field `agentId` also accept `<agentId>@<name>` without the prefix.
An exact local agent ID wins without the prefix.
An explicit prefix accepts a raw remote agent ID, even when a local agent has that raw ID.
The prefix rejects a suffixed agent that selects another gateway or matches an exact local ID.
Object IDs, pool IDs, team IDs, server names, and arbitrary body strings stay unchanged.
Object requests need the prefix on every request, including later actions and refreshes.

## Allowed configuration routes

Every path below starts with `/api`. Use the prefix for a path without an agent selector.
The table adds no general administrative proxy.
Existing chat and media routes keep their contracts.

| Method | Path after `/api` | Agent selector |
| --- | --- | --- |
| GET | `/agents` | Gateway prefix |
| GET | `/agents/:id` and `/agents/:id/{extensions,connections,webhooks,dashboards,avatar}` | Path `id` |
| PATCH | `/agents/:id/{extensions,webhooks}/:name` | Path `id` |
| DELETE | `/agents/:id/extensions/:name/credentials` | Path `id` |
| DELETE | `/agents/:id/connections/:kind/:integration` | Path `id` |
| GET | `/oauth/:provider/status` | Query `agent` |
| POST | `/oauth/:provider/disconnect` | Query `agent` |
| GET, POST | `/mcp/servers` and `/mcp/servers/config` | Query `agent` |
| GET | `/mcp/servers/personal-status` | Query `agent` |
| POST | `/mcp/servers/{remove,shared,label,icon/refresh}` | Query `agent` |
| GET | `/mcp/oauth/status` | Query `agent` |
| POST | `/mcp/oauth/disconnect` | Query `agent` |
| GET | `/schedules` | Query `agent` |
| POST | `/schedules` | Body `agentId` |
| PATCH, DELETE | `/schedules/:agentId/:jobId` | Path `agentId` |
| POST | `/schedules/:agentId/:jobId/run` | Path `agentId` |
| GET | `/schedules/:agentId/:jobId/runs` and `/schedules/:agentId/:jobId/runs/:runId/trace` | Path `agentId` |
| GET | `/mcp/catalog`, `/schedule-alerts`, `/dashboards`, `/dashboards/recipients` | Gateway prefix |
| PUT, DELETE | `/dashboards/:id/pin` | Gateway prefix |
| PATCH | `/dashboards/:id/sharing` | Gateway prefix |
| POST | `/dashboards/:id/claim` | Gateway prefix |
| DELETE | `/dashboards/:id` | Gateway prefix |
| GET | `/pool`, `/pool/:id/avatar`, `/pool-actions`, `/teams`, `/admin/forks` | Gateway prefix |
| PUT | `/admin/forks/:poolId/teams` | Gateway prefix |
| PATCH | `/admin/forks/:poolId/visibility` | Gateway prefix |
| DELETE | `/admin/teams/:teamId/agents/:poolId` | Gateway prefix |
| GET | `/top-extensions`, `/capabilities` | Gateway prefix |

The relay uses only the linked bearer. The remote gateway checks agent access and permissions.
The relay removes caller cookies, authorization, Origin, Host, forwarded headers, and `x-yoplai-*` identity headers.
The relay refuses encoded separators, traversal, double encoding, and unsafe paths before a remote fetch.
Remote fetches use manual redirects and a 30-second deadline for response headers.
Streams can continue after that deadline.
An ordinary redirect stays inside the selected gateway and the allowed GET routes, or the relay returns `unsafe_remote_redirect`.
The relay returns `gateway_offline` with status 502 when the remote fetch fails.

## Remote requester context

`GET /api/relay/gateways/:name/api/capabilities` already supplies safe requester context.
No new remote endpoint is necessary.

| Field | Meaning for the selected remote |
| --- | --- |
| `multiUser` | The remote uses account authentication. This is not the local authentication mode. |
| `user.id` | The remote identity of the linked bearer owner. Use it for personal item filters. |
| `user.name`, `user.email` | Public profile values of that remote requester. |
| `user.role` | The remote role or role array. Missing data grants no administrative rights. |
| `extensions` | Extension IDs that the remote loads. |
| `forkedAgents` | The remote uses the pool and fork model. |
| `enableCronMonitoring` | The remote permits schedule monitoring views. |
| `agents` | Raw remote agent IDs visible to this requester. |

Single-user remotes omit `user`. Personal connections can require a remote account.
A failed context read is an unknown state, not local administrator access.
The page must also use remote `canConfigureTeam`, `canEditLabels`, `editable`, team `canManage`, and dashboard ownership fields.
A role alone does not grant agent management rights.
The remote remains the authority when a request returns 401 or 403.

Agent catalog rows use suffixed `id`, `gateway`, and avatar paths.
Known response fields named `agentId` use the gateway suffix, including dashboard result containers.
Pool IDs and fork fields remain remote values. Capability `agents` also remain raw remote IDs.
The page must retain the selected gateway separately from each object.
It must not replace global local capabilities or the local session.

## OAuth start contract

The page sends `POST /api/relay/oauth/start` with JSON:

```json
{
  "gateway": "east",
  "agentId": "assistant@east",
  "kind": "core",
  "provider": "google",
  "scope": "personal",
  "scopes": ["email"]
}
```

For MCP, use `kind: "mcp"` and `server` instead of `provider` and `scopes`.
The scope must be `personal` or `team`.
The request must carry an Origin from the configured trusted browser origins.
The request must use `Content-Type: application/json`.
The strict Origin check and JSON-only POST protect this local start from cross-site requests.
The endpoint accepts no return URL or requester identity.
Direct remote authorize navigation through the relay returns `use_oauth_start` with status 405.

Success returns `{ authorizationUrl: string }` with `Cache-Control: no-store`.
The local server does not fetch the provider URL.
The URL must use HTTP or HTTPS without userinfo, a fragment, or credential query fields.
Remote login redirects and unsafe URLs return a local error.
Remote permission denials retain status 401, 403, or 404.
Other unexpected responses return status 502.

The remote stores OAuth state and tokens.
The provider returns to the remote callback URL.
The remote callback consumes its stored state without a browser session and renders its result page.
The relay omits remote `returnTo`.
The remote must use the correct callback base and provider registration.

## Core start result

The relay checks the provider name as one safe path segment.
It does not require that provider in the local extension registry.
The selected remote checks its own provider and permissions.
An unknown remote core provider returns status 404 with `unknown_remote_provider`.

For core OAuth, the relay sends `Accept: application/json` to the remote authorize route.
The remote must support this response contract:

```json
{
  "kind": "oauth_authorization",
  "provider": "google",
  "authorizationUrl": "https://provider.example.test/authorize?state=example"
}
```

The core handler returns status 200 with `Content-Type: application/json` and `Cache-Control: no-store`.
It returns this body only after it starts state for the checked provider, agent, scope, and requester.
The relay checks the result kind, provider, and URL before it returns the URL to the page.
It rejects all core redirects, including unrelated external login redirects.
It also rejects the old core redirect response instead of using an unsafe fallback.
Update the remote gateway before a core OAuth start through this relay.

Ordinary browser requests keep the scope page and provider redirect.
A JSON start requires an explicit scope and returns `missing_scope` without it.
The callback, one-use state, token store, and browser return path keep their existing behavior.
The shared schema is `OAuthAuthorizationStartSchema`.
Dynamic MCP discovery keeps its separate redirect contract and does not use the static core result.
The external MCP extension remains unchanged.

## Body and redirect limits

Configuration selection runs before the local extension gate only for the allowed remote routes.
Local requests still pass through that gate.
The relay still refuses untrusted clients and local multi-user mode.
Schedule selection reads one body stream with a one-MiB limit.
The relay rebuilds valid local requests before the local handler reads them.
Oversized bodies return status 413 with `configuration_body_too_large` without a cancellation wait.
Malformed JSON and failed reads return bounded errors before any mutation.
The Node adapter of Hono replaces the global `Response` class when the server starts.
The relay checks results with `isResponse`, not `instanceof Response`, so these errors reach the client.
`apps/gateway/src/server/relay-configuration.http.test.ts` checks them through the real adapter on ephemeral loopback ports.

Media and merged agent lists follow at most five same-origin redirects.
Uploads accept only 307 or 308 and reuse their buffered form and file bytes.
Downloads accept 301, 302, 303, 307, or 308 within the UUID download routes.
Agent lists accept those GET redirects only within the same list route, with an optional trailing slash.
Each redirect must stay within the configured gateway base path.
Missing Location, unsafe paths, other origins, userinfo, fragments, loops, and excessive hops fail before another fetch.
Failed media redirects return status 502 with `unsafe_remote_redirect`.
Failed list redirects omit that remote list and keep the local list.
The relay never uses unrestricted Fetch redirects.

## Round-3b page contract

1. Open a blank popup during the click event, before the asynchronous start request.
2. Request the start URL through the local endpoint with the selected gateway and explicit scope.
3. Navigate that popup to the returned `authorizationUrl` without changing the configuration route.
4. Poll remote status through the relay for the same agent, provider or server, and scope.
5. Close the popup and refresh the remote configuration after the status confirms success.

The page must detect a blocked popup before it starts a grant.
It must show start failures, poll failures, denied scopes, popup closure, and a finite timeout.
Popup closure is not proof of success. Existing connected status alone is not proof of a successful reconnect.
A reconnect needs a fresh status comparison, such as connection time, when the remote response supplies it.
The page must not claim a reconnect result that status cannot prove.
It must not trust a message from an arbitrary popup origin.
No new popup framework exists in round 3a.

MCP add can start OAuth itself.
Remote `POST /mcp/servers` therefore uses the same Origin and JSON checks as the start endpoint.
The relay removes body `returnTo` and checks any returned `authorizationUrl`.
The page must open the popup before add, then use that returned URL directly.
It must not call the start endpoint for the same add result.
Without an authorization URL, the page closes the blank popup and refreshes the server list.
After an add error, the page must read the remote list before retrying.
The remote add can succeed before the relay rejects its response.

## Dashboard boundary and remaining work

JSON dashboard reads, recipients, sharing, claim, pin, and delete target the selected gateway.
Dashboard viewer HTML, `/d/:id`, edit/add requests, and `/d-assets` do not use this API prefix.
The current frame uses a local relative `/d/:id` path.
Remote dashboard `link` and `chatHref` values are not local navigation targets.
Round 3b must build gateway-aware links instead of using those values as local paths.
A direct remote frame lacks the linked bearer and conflicts with the remote frame policy.
Round 3b needs a narrow viewer path and auth design before the Open and frame controls work remotely.
A passing dashboard list does not prove viewer or asset support.

Global administration, agent creation, account Slack pairing, and shared catalog writes remain outside this batch.
The external MCP source stays unchanged.
Synthetic transport tests do not prove the external MCP runtime or browser popup behavior.
