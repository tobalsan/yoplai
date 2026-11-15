# Remote configuration transport

Status: rounds 3a and 3b1 supply the transport only. The next round must connect the pages and test the browser flows.
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

## Dashboard viewer transport

Round 3b1 adds the backend for remote dashboards. It does not add the trusted host page, the configuration pages, popups, or frame wiring.
The next worker builds those parts from this contract. The remote configuration batch is not complete.

The linked bearer never reaches the browser. A short-lived local grant lets a sandboxed frame load dashboards of one linked gateway.
The remote edit token authorizes every write. The grant alone gives no write authority.

JSON dashboard routes (list, recipients, pin, sharing, claim, delete) keep using `/api/relay/gateways/:name/api/dashboards...`.
The remote `link` and `chatHref` values are not local navigation targets. Build local URLs as described below.

### Routes

All routes live under `/api/relay/dashboard-views`.
The gateway claims every spelling of this prefix before the extension gate and the generic relay.
A malformed path returns `404 invalid_dashboard_view_route` and never reaches another handler.
An unsupported method returns `405 method_not_allowed` with an `Allow` header.
Every route needs a supported relay mode and loopback forwarding.
Otherwise it returns `403 relay_unavailable`. Local multi-user mode is not supported.
No route returns a redirect. The global CORS middleware skips this prefix.

| Route | Caller | Result |
| --- | --- | --- |
| `POST /api/relay/dashboard-views` | Trusted UI code | Creates a grant. Returns 201. |
| `GET /api/relay/dashboard-views/:grant/current` | Trusted UI code | Returns the latest view result of the grant. |
| `GET /api/relay/dashboard-views/:grant/:id/` | Frame navigation | Returns the bounded viewer HTML. |
| `POST /api/relay/dashboard-views/:grant/:id/edit` | Frame script | Forwards one token-authenticated edit. |
| `POST /api/relay/dashboard-views/:grant/:id/add` | Frame script | Forwards one token-authenticated add. |

`:grant` has 43 base64url characters (256 random bits). `:id` is a real dashboard ID with 32 base64url characters.
A version ID, an encoded separator, or a missing trailing slash on the view route is refused before any remote call.

### Trusted host contract

The copied host URL is `/remote-dashboards/:gateway/:id`. It holds no grant and no edit token.
The host code does these steps:

1. Send `POST /api/relay/dashboard-views` with `Content-Type: application/json` and `{"gateway":"<linked name>","dashboardId":"<id>"}`.
   The body has no other field and stays under 1 KiB. The request must be a same-origin fetch from an exact configured UI origin
   (`server/origins.ts`). The gateway checks `Origin` and `Sec-Fetch-Site: same-origin`. A foreign or opaque origin gets `403 untrusted_origin`.
   A cross-site fetch gets `403 same_origin_required`. Other refusals: `415 json_required`, `404 unknown_gateway`, `400 invalid_dashboard_id`, `413 request_too_large`.
2. Read `{frameUrl, expiresAt, gateway, dashboardId}` from the answer. `frameUrl` is a path, such as `/api/relay/dashboard-views/<grant>/<id>/`.
   `expiresAt` is an ISO time 30 minutes after creation. At most 128 grants are active. The 129th request gets `429 too_many_dashboard_views`.
3. Create the frame with `src=frameUrl` and exactly `sandbox="allow-scripts allow-downloads allow-modals"`.
   Never add `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-popups-to-escape-sandbox`, or `allow-forms`.
   Set no `allow` attribute. Never put `frameUrl` in the address bar, a copied link, a log, or a message.
4. After each frame `load` event, call `GET /api/relay/dashboard-views/:grant/current` as a same-origin fetch.
   It needs `Sec-Fetch-Site: same-origin`. If it sends `Origin`, the value must equal the grant origin.
   Read `{expiresAt, view}`. `view` is `null` before the first view. Otherwise it is
   `{seq, dashboardId, ok: true, meta}` or `{seq, dashboardId, ok: false, error, status}`. `seq` grows with each view through the grant.
   The record describes the latest view. After a drill-down in the frame, `dashboardId` names the dashboard that the frame now shows.
   The frame cannot read this route (its origin is opaque, and no CORS header exists), and the host must not trust a frame message for the same facts.

`meta` is the only source of host control facts:

```json
{
  "dashboardId": "<32 characters>",
  "agentId": "<raw remote agent ID>",
  "canWrite": true,
  "canEdit": true,
  "chat": { "sessionId": "<id>" },
  "annotation": true
}
```

- `chat` is `null` when the viewer has no agent access. Otherwise it holds the creating session or `null`.
  Build the Chat URL as `/chat/<encodeURIComponent(agentId + "@" + gateway)>?session=<sessionId>&dashboard=<dashboardId>`
  with a session, or `?dashboard=<dashboardId>&new=1` without one. Take `gateway` from host state, never from the frame.
- `annotation` is true only for a viewer who can write, has agent access, and is not impersonated.
  Show the annotation control only then. Accept `yoplai-annotate` messages only when `event.source` is the frame window.
  Replace the `agentId` of a message with `agentId@gateway` from `meta`. Ignore the agent that the message names.
  Annotation messages never start a run on their own.
- `canWrite` and `canEdit` describe the page. A read-only viewer can still make guarded edits. The remote decides each write.
- `meta` never holds the edit token. The token reaches only the frame HTML.

External links, Copy link, and popups belong to the host. The frame has no popup permission.
The host shows the destination, accepts only plain HTTP or HTTPS addresses without credentials and not on the local machine,
and opens them with `noopener,noreferrer` after a user click. Copy link copies `/remote-dashboards/:gateway/:id` only.

When `frameUrl` stops working, create a new grant with the same request and replace the frame source.
The relink flow is the same, because a relink ends old grants. Keep the gateway name and dashboard ID in the host URL,
so a reload or restored tab can create a new grant. Restored inline frames must also store the gateway.
The host decides when to retry. It must show Retry after an error, and it must not cache an update-required state across a relink.

### Viewer GET

`GET /api/relay/dashboard-views/:grant/:id/` needs the grant and `Sec-Fetch-Dest: iframe` or `document`.
Any other destination gets `403 navigation_required`. A drill-down inside the frame has a cross-site context, and the grant covers it.
An unknown, expired, unlinked, or relinked grant gets `410 dashboard_view_expired`.
The gateway keeps no grant after a restart.

The gateway calls only `GET <linked url>/d/<id>/embed` with these request headers:
`Authorization: Bearer <linked bearer>`, `Accept: text/html`, and `X-Yoplai-Embed-Theme: light|dark` when the local `yoplai-theme` cookie is valid.
It sends no cookie, `Origin`, `Referer`, forwarded header, or local identity header. It never follows a redirect.
The query is the browser query without names that start with `__yoplai_` (reserved for transport). It must stay within 8 KiB (`414 query_too_large`).

| Remote result | Local answer |
| --- | --- |
| 200 with a supported embed marker, valid metadata, and HTML | 200 HTML under the local policy |
| 401, or a redirect to `/login` | `401 remote_unauthorized` |
| 403 | `403 forbidden` with an optional `ownerName` |
| 404 with the embed marker | `404 not_found`, or `404 canvas_disabled` |
| 404 without the marker | The gateway reads remote `/api/capabilities`. No `dashboardEmbed` gives `409 remote_update_required` (`reason: missing_capability`). Otherwise `404 not_found`. |
| 200 without the marker, or an unsupported version | `409 remote_update_required` with `reason` `missing_embed_marker`, `embed_version`, `asset_version`, or `policy_version` |
| Other redirect, other status, bad JSON metadata, wrong content type | `502 invalid_remote_response` |
| Page over 5 MiB after decompression | `502 remote_response_too_large` |
| Remote does not answer, or the body stalls, for 30 seconds | `504 remote_timeout` with `Retry-After` |
| Fetch failure | `502 gateway_offline` |
| A ninth active call for one gateway | `429 too_many_dashboard_view_requests` with `Retry-After: 1` |

An error body is local JSON `{error, ...}` with no remote HTML, bearer, edit token, or grant.
A client disconnect aborts the remote call and releases the slot. The answer is status 499 with no body.
A bare 404 never proves an old remote. A missing capability decides it, and each Retry reads it again. The gateway caches nothing.

Success headers: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
and this `Content-Security-Policy` (`o` is the UI origin that issued the grant, `p` is `/api/relay/dashboard-views/<grant>/<id>`):

```text
sandbox allow-scripts allow-downloads allow-modals; default-src 'none';
script-src 'unsafe-inline' o/d-assets/; style-src 'unsafe-inline' o/d-assets/;
img-src data: blob:; font-src data: o/d-assets/; connect-src o/p/edit o/p/add;
frame-src 'none'; worker-src 'none'; base-uri 'none'; object-src 'none';
frame-ancestors 'self'; form-action 'none'
```

The local policy replaces the remote headers. The gateway drops the remote cookies, redirects, `Refresh`, CORS, `Link`, framing, reporting, and download headers.
The page keeps its own restrictive `<meta>` policy, but the local header does not rely on it. HTML has no CORS grant.
A raw top-level open of the frame URL keeps the same sandbox.

### Edit and add

`POST .../:grant/:id/edit` and `.../add` need the grant, `Origin: null`, `Content-Type: text/plain`, and a JSON body of at most 256 KiB
with a string `token`. The gateway forwards the exact bytes to `POST <linked url>/d/<id>/edit|add` with no bearer, cookie, or browser header.
The remote checks the signed edit token, the current access, and the declared fields and rows. Guarded reader edits still work. Only writers can add.
The gateway returns the remote JSON object with status 200, 400, 401, 403, 404, or 503. It returns `502 invalid_remote_response` for a redirect,
another status, HTML, or a JSON value that is not an object with a boolean `ok`. It returns `502 remote_response_too_large` for an answer over 256 KiB.
Other refusals: `403 opaque_origin_required`, `415 text_plain_required`, `413 request_too_large`, `400 invalid_edit_request`, `429`, `504`, and `410`.
Every answer to a request with `Origin: null` has `Access-Control-Allow-Origin: null` and `Vary: Origin`, so the page can read it. No answer has credentials.
Bearer revocation stops later views. It does not revoke an edit token that the remote already issued. Share changes affect each later edit on the remote.

### Remote contract

A remote gateway with this round serves `GET /d/:id/embed`. It reuses the normal viewer authentication, access policy, draft choice, queries, and token issue.
Differences: sibling links are `../<id>/`, the edit base is `.`, the page has no Chat button, a failure returns bounded JSON (`401`, `403`, `404`) and not a redirect or HTML,
and the link builder resolves against the document URL. Annotation also needs a viewer who is not impersonated.
Every answer of the route has `X-Yoplai-Dashboard-Embed: 1`, `X-Yoplai-Dashboard-Embed-Assets: v3`, and `X-Yoplai-Dashboard-Embed-Policy: 1`.
A 404 for a disabled Canvas adds `X-Yoplai-Dashboard-Embed-Reason: canvas_disabled`. A 200 adds `X-Yoplai-Dashboard-Embed-Meta` (base64url JSON, at most 2,048 characters, strict schema).
`GET /api/capabilities` adds `dashboardEmbed: {version, assetVersion, policyVersion, enabled}`. Update the remote before it serves a local viewer.

Dashboard IDs have 32 base64url characters. Pages load the local `/d-assets` kit. The embed asset version `v3` must match.
Assets answer `Origin: null` with `Access-Control-Allow-Origin: *` and no credentials. Other API routes keep their CORS rules.
The page uses the local UI theme unless the dashboard sets `data-theme`.

### Safe fixtures and limits

Use only synthetic agents, fake bearers (for example `fake-bearer-alice`), disposable `YOPLAI_HOME` directories, and ephemeral loopback ports.
`apps/gateway/src/server/dashboard-views.http.test.ts` runs the real adapter, the real global middleware, and a remote with the real renderer and a SQLite file.
It switches users by relinking the fake bearer, which also proves that a relink ends old grants.
The tests do not prove browser behavior: opaque-origin loading, CSP enforcement, `Sec-Fetch-*` values, Vite proxy headers, drill-down, CSV download, popups, and annotation need a real browser check.
Remote HTML cannot share the origin of the trusted host. If the browser check fails, serve the viewer from a separate loopback origin.

Global administration, agent creation, account Slack pairing, and shared catalog writes remain outside this batch.
The external MCP source stays unchanged.
Synthetic transport tests do not prove the external MCP runtime or browser popup behavior.
