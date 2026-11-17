# Remote configuration transport

Status: rounds 3a and 3b1 supply the transport. Round 3b2 adds the trusted dashboard host. Round 3c adds the configuration pages and OAuth popups.
Browser acceptance of the whole batch (popups, dashboard confinement, chat frames) is still open. Node and jsdom tests do not prove it.

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

## OAuth page contract

The round-3c pages follow this contract. See [OAuth popups](#oauth-popups) for the implementation.

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

## Configuration pages (round 3c)

The pages in `apps/web` use the routes above. They add no new transport route.

### Gateway context

- The route of an agent page holds the qualified agent ID (`<agentId>@<name>`). The page resolves the gateway once from the merged local agent list (`lib/agent-target.ts`).
  A name without `@` is local and needs no list. A name with `@` is remote only when the list names a `gateway` for that exact ID. The ID suffix alone never selects a gateway.
  When the list fails or does not hold the ID, the page shows "This agent is unavailable" with Retry and makes no configuration call. It never falls back to a local call.
- Every API function takes an optional `gateway` argument (`api/gateway.ts`). With a name, the URL is `/api/relay/gateways/<name>` plus the normal path. The qualified agent ID stays in the path or query, and the relay checks that it belongs to that gateway.
  Object IDs (job, run, dashboard, pool, team, MCP server) stay unchanged. Caches and resource keys include the gateway, so equal IDs on two gateways never share data.
  Pages read route params with `decodeRouteParam`, because the router keeps the raw path segment.
- `lib/requester.ts` gives the requester of the gateway. A local page uses the local session and capabilities. A remote page reads `GET .../api/capabilities` of its gateway: the remote user ID, role, `multiUser`, `forkedAgents`, `enableCronMonitoring`, and extension flags.
  A failed read is "unknown" and grants no rights. Pages also use remote `canConfigureTeam`, `canEditLabels`, `editable`, and dashboard ownership fields.
- Navigation keeps the context in the qualified agent ID: extension cards, MCP cards, schedule and run links, Back links, and the settings link of a chat. A remote catalog names the raw remote agent in `configRoutePath`, and `connectPath` of a schedule alert.
  The page moves those paths to the qualified agent (`qualifyAgentRoute`), or falls back to the details or Edit page.
- Global pages need an explicit gateway. `/dashboards?gateway=<name>` selects one linked gateway. The selector lists the gateways of the loaded agents and the one in the address. The local list is the default. A gateway change drops dialogs, pins in flight, and late answers of the old gateway.
  A remote dashboard row opens `/remote-dashboards/<name>/<id>`, and Chat opens `/chat/<agentId>@<name>?dashboard=<id>` (with `session` when the row has one). The remote `link` and `chatHref` values are never local targets.
- The Edit page of a remote agent reads Top flags from its gateway (`GET .../api/top-extensions`), the pool, teams, forks, and pool actions of its gateway, and saves team and visibility changes there. Pool IDs and fork fields stay remote values.
  Pool avatar paths load through the relay prefix. The local Top flags and the local session never apply to a remote agent.
- The webhook config route (`/agents/:agentId/extensions/webhooks`) is always mounted. It checks the extension on the gateway of the agent, and opens the generic details page when that gateway does not load it.
- Schedule alerts are kept per gateway (`lib/schedule-alerts.ts`). A chat with a remote agent also loads the alerts of that gateway.

### Identity of a page

- A page binds its catalog, forms, dialogs, and actions to one identity: the gateway, the agent, and where it applies the extension or server. A change of identity mounts the forms again and clears drafts, pending actions, and dialogs. The extension page keys its form by gateway, agent, and extension. Its catalog key stays agent-wide.
- Each mutation captures the identity and a visit generation before it starts. A visit ends when the identity changes, also when the page returns to the same target, and when the page closes. A result, an error, a refresh, a form change, or a navigation of an older visit changes nothing. This covers extension toggles and credential forms, MCP controls and forms, schedule actions, connection actions, alert resume, dashboard delete and share, webhook changes, and core sign-in disconnect.
- Each MCP add attempt has its own record. It ends on Cancel, on a newer attempt, on a new target, and when the page closes. A late answer of an ended attempt changes no dialog or toast. The page reads the list of the same target again. A cancelled submitted add stays uncertain, because a cancelled fetch or popup does not prove that the server stopped. The dialog then reads the list of its target before another add.
- A lookup that failed leaves no catalog, no mutation control, and no request. No handler falls back to a local call.
- After an uncertain MCP add error (the remote can add before its answer fails), the add dialog reads the list of the same target and stays busy until that read settles. When the read fails, the dialog shows an unknown state with a "Read list" button, and another add stays off until a read works. A successful add frees the dialog, also for a local agent with no redirect.

### OAuth popups

Local agents keep the redirect flow. A remote agent uses `lib/oauth-popup-flow.ts`:

1. The click opens a blank popup (`window.open("", "yoplai-oauth-<n>")`) before any asynchronous work. A blocked popup shows a message and starts no grant.
2. The flow reads the status through the relay (the baseline), then starts the grant with `POST /api/relay/oauth/start` (`api/oauth.ts` `startRemoteOAuth`). The request holds the gateway, the qualified agent, the kind, the provider or server, the explicit scope, and the provider scopes. It holds no return path.
   A custom MCP add (`POST /mcp/servers`) opens the popup first and uses the `authorizationUrl` of the add result. It does not start a second grant. Without an URL it closes the popup and refreshes the list. After an add error it reads the remote list again.
3. The popup navigates to the returned web address. The whole flow has one budget of 5 minutes that starts at the click. The baseline read, the start request, each pause, and each poll share it, and each wait ends at the remaining time. The flow polls the remote status every 2 seconds. The baseline read and the start request each have a 30 second limit inside that budget (the add has 50 seconds). An answer that arrives after the budget ends never reports success.
4. The flow trusts no `postMessage`. It decides only from fresh status of the same gateway, agent, provider or server, and scope. A new connection needs a state change, or a new `connectedAt` for core status. MCP status has no connection time, so a connected server cannot prove a reconnect and the flow reports "unconfirmed" instead of success.
5. Success closes the popup and refreshes the status. Blocked, closed, cancelled, failed, denied, unconfirmed, and timed-out flows show a visible message. A newer flow, a changed agent, gateway, provider, or scope, a Cancel click, or the end of the page ends the old flow and closes its popup. A late status of an old flow changes nothing.

### Limits

- `ConnectToolsPrompt` and the "Connect tools" button need local multi-user mode, and the relay is off there. They stay local.
- Admin pages (the Admin link of the local UI opens `/admin/extensions` and the others), the MCP catalog admin page, skills, and account Slack pairing act on the local gateway only. Gateway-aware administration is outside this batch.
- The schedule alert dot of the agent list shows local alerts only.
- A job ID or server name that decodes to `%`, `/`, or `\` is refused by the relay path check.
- Tests use synthetic gateways: `apps/web/src/remote-configuration*.test.tsx`, `api/remote-configuration.test.ts`, `lib/oauth-popup-flow.test.ts`, and `remote-gateway.fixture.ts`. They run the real router and pages with a fake fetch and a fake popup.
  Real popups, provider redirects, the external MCP extension, and the browser behavior of the relay need a browser check.

## Dashboard viewer transport

Round 3b1 adds the backend for remote dashboards and a small trusted shell.
Round 3b2 adds the host page and the frame wiring of the chat page. See [Web host](#web-host). These two rounds add no configuration pages or popups. Round 3c adds them (see [Configuration pages](#configuration-pages-round-3c)).

The linked bearer never reaches the browser. The remote edit token authorizes every write.
JSON dashboard routes (list, recipients, pin, sharing, claim, delete) keep using `/api/relay/gateways/:name/api/dashboards...`.
The remote `link` and `chatHref` values are not local navigation targets.

### Design: one snapshot, one shell, one renderer

The host cannot see which document a frame shows. A frame can navigate itself, and a message from a frame does not name its current document.
So the gateway does not try to attest a document. It confines it.

1. The host sends one prepare request. The gateway makes one checked remote read and stores the result as a snapshot: the HTML bytes and the checked metadata, together and unchanged.
2. The host shows a local shell in a frame. The shell runs only local code and holds one opaque renderer frame.
3. The renderer loads the snapshot bytes once. The parent policy of the shell lets the renderer load only the exact snapshot path.
4. Every drilldown, reload, retry, and history step is a new prepare request with a new snapshot, a new shell, and a new renderer.

A snapshot never describes another dashboard, and no frame or top-level request can change it. A race between two requests can deny a delivery. It cannot change which dashboard a snapshot names.
The checked metadata is the only source of Chat, annotation, agent, and gateway facts.
Readiness only shows that scripts ran. A `ready` or `delivered` state does not prove that a browser shows the page.

Browser confinement is not proven by these Node tests. Iris owns the browser gate.
The gate must show that the shell policy stops self-navigation, other viewers, aliases, queries, redirects, `about:blank`, `data:`, `blob:`, `javascript:`, history, and cached restoration.
If another source can keep enabled controls, stop and ask. Do not add a nonce condition. The gate runs in Chromium first. WebKit is unproven until a real engine check exists.

### Routes

All routes live under `/api/relay/dashboard-views`.
The gateway claims every spelling of this prefix before the extension gate and the generic relay.
A malformed path, an encoded alias, a suffix change, or any query string returns `404 invalid_dashboard_view_route` and never reaches another handler.
An unsupported method returns `405 method_not_allowed` with an `Allow` header.
Every route needs a supported relay mode and loopback forwarding.
Otherwise it returns `403 relay_unavailable`. Local multi-user mode is not supported.
No route returns a redirect. The global CORS middleware skips this prefix.

`:handle` has 43 base64url characters (256 random bits). No path holds a dashboard ID, so no URL change can select another dashboard.

| Route | Caller | Result |
| --- | --- | --- |
| `POST /api/relay/dashboard-views` | Trusted UI code | Prepare. Makes one remote read and one snapshot. Returns 201. |
| `POST /api/relay/dashboard-views/read` | Trusted UI code | Reads the checked metadata of one snapshot. The handle is in the JSON body. |
| `GET /api/relay/dashboard-views/:handle/shell` | The host, as an iframe | Returns the trusted shell. Loads once. |
| `GET /api/relay/dashboard-views/:handle/frame` | The shell, as an iframe | Returns the snapshot bytes. Delivers once. |
| `POST /api/relay/dashboard-views/:handle/edit` | Renderer script | Forwards one token-authenticated edit to the snapshot dashboard. |
| `POST /api/relay/dashboard-views/:handle/add` | Renderer script | Forwards one token-authenticated add to the snapshot dashboard. |

Link lifetime: the link store saves a random `generation` with each new link in `remote-gateways.json`.
The gateway checks the link name, URL, bearer, and generation each time a snapshot is used.
Another process can remove a link and create it again with equal values, for example `yoplai disconnect` and then `yoplai connect`.
The new link gets a new generation, so its old snapshots end with `410`, and the gateway makes no remote call.
A save with equal values keeps the generation and the snapshots. A link file from an older version has no generation. It gets one on the next save.
The link that a snapshot was read through owns the snapshot, also when the link changes during the read.

Lifetime and capacity. These are fixed defaults, not settings.

| Item | Value |
| --- | --- |
| Metadata, edit and add | 30 minutes after prepare |
| Delivery window for the bytes | 2 minutes. A snapshot that nobody delivers ends. |
| Stored snapshots | At most 128. The 129th prepare gets `429 too_many_dashboard_views` before any remote read. |
| Stored bytes | At most 32 MiB for all snapshots that wait for delivery. Over it, prepare gets `429 dashboard_view_storage_full`. |
| Bytes after delivery | Removed at once. The metadata stays until expiry. |
| Page | 5 MiB after decompression |

Both `429` answers have `Retry-After: 60`. Expiry, unlink, relink, and restart end a snapshot and its bytes. A failed remote read stores nothing.
One timer without a reference waits for the next deadline of any snapshot. It frees undelivered bytes at the end of the delivery window and removes metadata at its expiry, also while no request arrives. The store sets the timer again after each store, delivery, and removal. The timer does not keep the process alive. Each use still checks the expiry and the link.

### Trusted host contract

The copied host URL is `/remote-dashboards/:gateway/:id`. It holds no handle and no edit token.
The host page does these steps for each view. All requests are same-origin `fetch` calls with `Content-Type: application/json` and a body under 12 KiB.
The gateway checks that `Origin` is an exact configured UI origin (`server/origins.ts`) and that `Sec-Fetch-Site` is `same-origin`.
A foreign or opaque origin gets `403 untrusted_origin`. A cross-site fetch gets `403 same_origin_required`.
A body that stops arriving gets `408 request_timeout` after 5 seconds. A declared length over the limit gets `413 request_too_large`.
At most 16 prepare and read bodies can wait at the same time (`429 too_many_dashboard_view_requests`). This limit is separate from the stored snapshot cap.

1. **Disable identity controls.** Disable Chat, annotation, and every control that uses a dashboard identity. Discard any older shell for this view.
2. **Prepare.** `POST /api/relay/dashboard-views` with `{"gateway":"<linked name>","dashboardId":"<id>","query":"<optional>","theme":"<optional light|dark>"}` and no other field.
   `query` is a query string without `?`. Fields that start with `__yoplai_` are removed. The rest must stay within 8 KiB (`414 query_too_large`).
   `theme` is the local UI theme. The gateway sends it to the remote. It never reads a cookie.
   A remote failure is a typed error of this request, and no snapshot exists. See the table below. Show it as trusted host text with Retry.
   Success is `201` with `{handle, instance, shellUrl, expiresAt, gateway, dashboardId}`. Keep `handle` and `instance` in memory. Never put them in an address bar, a copied link, a log, or a message.
3. **Create the shell.** Make a new iframe element for this preparation. Give it `src=shellUrl`. A same-origin host page can use the shell frame without `sandbox`, because the shell holds only local code.
   The shell loads once (`409 dashboard_view_shell_delivered` for a second request). Bind your host generation and the expected `instance` to this element.
4. **Accept shell messages.** Accept a message only when `event.source` is the `contentWindow` of this shell element, `event.origin` is the host origin, `event.data.channel` is `"yoplai-shell"`, and `event.data.instance` equals the expected `instance`.
   A remote renderer can call `window.top.postMessage` and reach the host window directly. Its `event.source` and `event.origin` (`"null"`) differ, so the check ignores it.
5. **Wait for readiness.** The shell sends `shell-started`, `renderer-loaded`, and `renderer-ready`. `renderer-ready` means that scripts ran and that the renderer loaded exactly once. It does not select metadata.
6. **Read the metadata.** `POST /api/relay/dashboard-views/read` with `{"handle":"<handle>"}`. Never send the handle in a URL.
   The gateway answers only the issuer origin. Success is `200 {expiresAt, state, gateway, dashboardId, meta}` with `state` `ready` or `delivered`.
   An unknown or ended snapshot is `410 {state:"expired", error:"dashboard_view_expired", status:410}`. An error body never holds `meta`.
7. **Enable controls.** Enable them only when all of these hold: the shell is the expected instance, `renderer-ready` arrived, the read state is `delivered`, `expiresAt` has not passed, and the host has not seen `ended`.
   `delivered` means that the gateway handed the bytes to one frame. It does not mean that a browser committed them. The browser gate decides whether confinement holds.
8. **Fail closed.** If any state is unknown, keep identity controls disabled and show an unknown-display state with Reload. No later message or successful read can clear it.

`meta` is the only source of control facts:

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
  with a session, or `?dashboard=<dashboardId>&new=1` without one. Take `gateway` from host state, never from a message. The target is immutable for this snapshot.
- `annotation` is true only for a viewer who can write, has agent access, and is not impersonated. Show the annotation control only then.
- `canWrite` and `canEdit` describe the page. A read-only viewer can still make guarded edits. The remote decides each write.
- `meta` never holds the edit token. The token reaches only the renderer.

Shell messages. All of them have `channel:"yoplai-shell"` and the shell `instance`:

| `event` | Meaning and host action |
| --- | --- |
| `shell-started` | The shell code runs. No action. |
| `renderer-loaded` | The renderer frame fired `load` once. |
| `renderer-ready` | The renderer page ran its bootstrap after exactly one load. |
| `ended` with `reason` `extra_load` or `host` | The instance is over. The shell removed the renderer. Clear authority and show Reload. |
| `link-request` with `href` | An untrusted request. See below. |
| `annotation` with `message` | An untrusted annotation message of the renderer. See below. |

An additional load of the renderer ends the instance. The host must not reuse the shell, the renderer window, or any state of it.
To end an instance, remove the shell element. A host `{channel:"yoplai-shell", instance, event:"end"}` message also ends it.

A link request. The shell forwards the absolute `href` that the renderer page reported. It is a request, never authority.
Classify it in host code. A target on the host origin with the path `/api/relay/dashboard-views/<32 characters>/` names a dashboard of the same gateway.
Take the ID and the query from it, apply the rules of step 2, and start a new view. Do not use the claimed agent or gateway.
Where the UI claims a relationship between dashboards, use the checked link targets of the remote and not the message.
Any other `http` or `https` target is an external link. Show the destination in host UI, accept only plain addresses without credentials and not on the local machine,
and open it with `noopener,noreferrer` after a user click. Ignore every other target.

Annotation. The renderer annotation script sends `{channel:"yoplai-annotate", type, ...}` to its parent, which is the shell. The shell wraps it in an `annotation` event.
Treat it as a claim from untrusted script. Accept it only when `meta.annotation` is true, annotation mode is active, and the shell instance is current.
Replace the agent with `meta.agentId + "@" + gateway`. Ignore the agent in the message. Bound the number and the size of notes. Send only after an explicit user action. Clear notes when the instance ends.
To change the mode, send `{channel:"yoplai-shell", instance, event:"annotation", message:{channel:"yoplai-annotate", type:"set"|"remove"|"clear", ...}}` to the shell.
The shell relays it only to a ready renderer, only for that channel, and only under 16 KiB.

Reload, Retry, Back, and Forward. Run the steps again from step 1. Do not reload a frame in place and do not use frame history as proof.
On host `pagehide`, clear authority. On `pageshow`, replace the shell and renderer with a fresh instance before enabling any control, also after a cached restoration.
When view A is replaced by view B, disable A before B starts. If B fails, show B's error. Restore A only through a new explicit load.
Restored inline frames must store the gateway and the dashboard ID, and they get a new prepare request.

### Prepare errors

Every error body is local JSON `{error, ...}`, with no remote HTML, bearer, edit token, or handle. Status mapping:

| Remote result | Local answer |
| --- | --- |
| 200 with a supported embed marker, valid metadata for this ID, and HTML | `201` and a snapshot |
| 401, or a redirect to `/login` | `401 remote_unauthorized` |
| 403, with any embed marker or none | `403 forbidden` with an optional `ownerName` of up to 200 characters. Show it as text. The gateway checks this before the embed versions, so a 403 is never an update prompt. |
| 404 with the embed marker | `404 not_found`, or `404 canvas_disabled` |
| 404 without the marker | The gateway reads remote `/api/capabilities` and checks `dashboardEmbed`. It needs `version`, `assetVersion`, `policyVersion` (numbers and text as in the marker) and a boolean `enabled`. No `dashboardEmbed` gives `409 remote_update_required` (`reason: missing_capability`). An unsupported `version`, `assetVersion`, or `policyVersion` gives `409 remote_update_required` with `reason` `embed_version`, `asset_version`, or `policy_version`. A field of the wrong type gives `502 invalid_remote_response`. `enabled: false` gives `404 canvas_disabled`. Otherwise `404 not_found`. |
| 200 without the marker, or an unsupported version | `409 remote_update_required` with `reason` `missing_embed_marker`, `embed_version`, `asset_version`, or `policy_version` |
| Other redirect, other status, bad metadata, metadata for another ID, wrong content type | `502 invalid_remote_response` |
| Page over 5 MiB after decompression | `502 remote_response_too_large` |
| No answer, or a stalled body, for 30 seconds | `504 remote_timeout` with `Retry-After: 5` |
| Fetch failure | `502 gateway_offline` |
| A ninth active call for one gateway | `429 too_many_dashboard_view_requests` with `Retry-After: 1` |
| Client disconnect | The remote call aborts, the slot is free, status 499 with no body |

The gateway calls only `GET <linked url>/d/<id>/embed` with `Authorization: Bearer <linked bearer>`, `Accept: text/html`, and `X-Yoplai-Embed-Theme: light|dark` when the body names a theme.
It sends no cookie, `Origin`, `Referer`, forwarded header, or local identity header. It never follows a redirect.
Each prepare repeats the remote read checks. A snapshot is not an authorization cache. The gateway caches no capability state.
The HTML body is the exact byte sequence that the gateway counted. The gateway does not decode it as text, so invalid UTF-8 cannot grow past the limit.

### Shell and frame responses

The shell answers a same-origin iframe navigation (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin`) once.
Another destination gets `403 navigation_required`, a cross-site request gets `403 same_origin_required`, and a second request gets `409 dashboard_view_shell_delivered`. A refusal uses nothing up.
Its headers are `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and this policy.
`p` is the exact path `/api/relay/dashboard-views/<handle>/frame`, `o` is the UI origin that issued the snapshot, and the hash covers the one inline script of the shell:

```text
default-src 'none'; script-src 'sha256-<hash>'; frame-src o/p; connect-src 'none';
img-src 'none'; style-src 'none'; base-uri 'none'; object-src 'none';
form-action 'none'; frame-ancestors 'self'
```

`frame-src` names one path with no trailing slash, so it matches no other path. The policy has no `blob:`, `data:`, or viewer prefix. The shell has no CORS grant.
The shell creates the renderer with `sandbox="allow-scripts allow-downloads allow-modals"` and no other flag. It has no `allow-same-origin`, top navigation, popups, forms, or `allow` attribute.

The frame route delivers the bytes once. It needs `Sec-Fetch-Dest: iframe`.
A top-level request or any other destination gets `403 navigation_required` as sandboxed JSON and uses nothing up.
A later request, or a second frame, gets `409 dashboard_view_delivered`, never another document. An unknown or ended snapshot gets `410`.
Success headers: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
and this `Content-Security-Policy` (`p` is `/api/relay/dashboard-views/<handle>`):

```text
sandbox allow-scripts allow-downloads allow-modals; default-src 'none';
script-src 'unsafe-inline' o/d-assets/; style-src 'unsafe-inline' o/d-assets/;
img-src data: blob:; font-src data: o/d-assets/; connect-src o/p/edit o/p/add;
frame-src 'none'; worker-src 'none'; base-uri 'none'; object-src 'none';
frame-ancestors 'self'; form-action 'none'
```

The local policy replaces the remote headers. The gateway drops the remote cookies, redirects, `Refresh`, CORS, `Link`, framing, reporting, and download headers.
The page keeps its own restrictive `<meta>` policy, but the local header does not rely on it. HTML has no CORS grant.
Link clicks in the renderer become `link-request` messages. A script that sets `location` is blocked by the policy of the shell. This is expected.

### Logs

A handle in a path is a secret. The gateway access log replaces the whole target of every owned request with `/api/relay/dashboard-views/[redacted]`.
This includes the query and the encoded, double encoded, and mixed case spellings.
The access log, the CORS skip, and the route code use one ownership test, `ownsDashboardViewPath`.
The viewer middleware runs on every path and passes each path that the test does not claim to the next handler.
Each owned spelling therefore gets the same typed refusal and the same final sandbox headers.
The Vite dev proxy of `apps/web/vite.config.ts` does the same in its proxy error log, for example when the gateway is down.
Other proxy errors keep their request URL.

### Edit and add

`POST /api/relay/dashboard-views/:handle/edit` and `.../add` need a delivered snapshot (`409 dashboard_view_not_delivered` before), `Origin: null`, `Content-Type: text/plain`, and a JSON body of at most 256 KiB
with a string `token`. The path holds no dashboard ID. The gateway forwards the exact bytes to `POST <linked url>/d/<snapshot dashboard>/edit|add` with no bearer, cookie, or browser header.
The remote checks the signed edit token, the current access, and the declared fields and rows. Guarded reader edits still work. Only writers can add.
The gateway returns the remote JSON object with status 200, 400, 401, 403, 404, or 503. It returns `502 invalid_remote_response` for a redirect,
another status, HTML, or a JSON value that is not an object with a boolean `ok`. It returns `502 remote_response_too_large` for an answer over 256 KiB.
Other refusals: `403 opaque_origin_required`, `415 text_plain_required`, `413 request_too_large`, `400 invalid_edit_request`, `429`, `504`, and `410`.
Every answer to a valid write route with `Origin: null` has `Access-Control-Allow-Origin: null` and `Vary: Origin`, so the page can read it. No answer has credentials.
Bearer revocation stops later prepares. It does not revoke an edit token that the remote already issued.
An edit token keeps its signed identity for eight hours. This policy is unchanged. Share and eligibility checks still apply to each later edit.

### Remote contract

A remote gateway with this round serves `GET /d/:id/embed`. It reuses the normal viewer authentication, access policy, draft choice, queries, and token issue.
Differences: sibling links are `../<id>/`, the edit base is `.`, the page has no Chat button, a failure returns bounded JSON (`401`, `403`, `404`) and not a redirect or HTML,
and the link builder resolves against the document URL. Annotation also needs a viewer who is not impersonated.
Every answer of the route has `X-Yoplai-Dashboard-Embed: 1`, `X-Yoplai-Dashboard-Embed-Assets: v3`, and `X-Yoplai-Dashboard-Embed-Policy: 1`.
A 404 for a disabled Canvas adds `X-Yoplai-Dashboard-Embed-Reason: canvas_disabled`. A 200 adds `X-Yoplai-Dashboard-Embed-Meta` (base64url JSON, at most 2,048 characters, strict schema).
`GET /api/capabilities` adds `dashboardEmbed: {version, assetVersion, policyVersion, enabled}`. Update the remote before it serves a local viewer.

An embed page that runs inside a frame posts two messages to its parent, with `targetOrigin` `*`:
`{channel:"yoplai-embed", type:"ready"}` once when its bootstrap runs, and `{channel:"yoplai-embed", type:"link", href}` when the user clicks a link.
`href` is the absolute `http` or `https` target, at most 2048 characters. The page stops the navigation.
A click on a link to the same document, a link with another scheme, a modified click, and a link with `download` keep their default behavior.
Both messages come from untrusted remote script. The shell treats `ready` as proof that scripts run and `link` as a request.
Ordinary pages and pages that are not framed post nothing.

Dashboard IDs have 32 base64url characters. Pages load the local `/d-assets` kit. The embed asset version `v3` must match.
Assets answer `Origin: null` with `Access-Control-Allow-Origin: *` and no credentials. Other API routes keep their CORS rules.
The page uses the theme of the prepare request unless the dashboard sets `data-theme`.

### Web host

The web app builds the host contract above in `apps/web`. Remote HTML never enters the web DOM.

| Part | File |
| --- | --- |
| Public route `/remote-dashboards/:gateway/:id` | `pages/RemoteDashboard.tsx`, mounted in `App.tsx` |
| Host lifecycle | `components/chat/remoteDashboardHost.ts` |
| Remote `FrameView` | `components/chat/RemoteFrameView.tsx`, chosen by `FrameView` when `target.gateway` is set |
| Prepare and read client | `api/dashboard-views.ts` |
| Route, Chat target, and link rules | `lib/remote-dashboard.ts` |
| Annotation entry | `remoteFrame` in `components/chat/dashboardAnnotations.ts` |

- The public route holds the gateway, the dashboard ID, and the clean query. It holds no handle, instance, or token. Copy and Open in browser use only this route.
- The host keeps the handle and the instance in memory. It never writes them to a URL, storage, a log, or the clipboard. Saved chat tabs store only the gateway, the dashboard ID, the title, and the query.
- Each preparation makes a new generation and a new shell iframe. Reload, a link of the same gateway, a history step, a query change, a gateway change, a theme change, and a cached page restoration all prepare a new view. Disposal and replacement abort the prepare and read requests and ignore every late result of an older generation.
- Controls stay off until the shell sent `renderer-loaded` and `renderer-ready`, the read answered `delivered` for the same gateway and dashboard, and the view has not expired. Any other state shows an error and Reload: a second load, an early ready, an `ended` event, a read failure, a prepare timeout (40 seconds), and a readiness timeout (30 seconds). Nothing that arrives later clears a failure.
- Chat access, the agent, and annotation rights come from the checked `meta`. The Chat link and the annotation target use `meta.agentId` plus the host gateway. The standalone route shows Chat. A frame in a chat panel shows Annotate when the chat agent equals that checked agent.
- Annotation messages reach the chat staging only when `meta.annotation` is true. The host replaces the page ID and the agent with the checked values. Staged notes and the page announcement of an ended or replaced instance are dropped. A note still needs an explicit send from the chat composer.
- A link request resolves against the checked dashboard. A viewer path of the same gateway prepares a new view. An external HTTP or HTTPS link shows its destination and opens with `noopener,noreferrer` only after a click on Open link. Executable schemes, credentials, and addresses of this machine or network never open.
- `ChatView` opens `?dashboard=<id>` for a remote agent (`name@gateway`) through the host. It waits for the loaded agent and uses the `gateway` of that agent.
- A dashboard that a tool call of a remote chat shows (`CapturedFrameView`) uses the gateway of the locally resolved chat agent (`agent.gateway`). `ChatView` passes it to the transcript rows and the side panel. The captured result supplies only the dashboard ID and title. A `gateway` or `query` field in the result changes nothing. An ID suffix never implies a gateway, so a local agent with `@` in its ID keeps the local frame. While the agent loads, the frame shows a loading status. The existing relay already forwards the captured-frame data path.
- The host counts loads of each shell iframe. The first load is normal. A second load clears the checked view, the staged notes, and the iframe, and shows Reload. The host does not wait for an `ended` message, because a refusal document sends none.
- Opening the same remote gateway and dashboard again with an explicit query (`openFrame`) updates the existing tab and prepares a fresh view. An omitted query keeps the selected one. Local dashboards have no query.
- A final DNS dot does not change the link policy: `localhost.`, `nas.local.`, and `app.localhost.` stay blocked.

Tests: `components/chat/RemoteFrameView.test.tsx`, `lib/remote-dashboard.test.ts`, `api/dashboard-views.test.ts`, `App.remote-dashboard.test.tsx` (actual router), and `components/ChatView.remote-dashboard.test.tsx`, and `components/chat/CapturedRemoteFrame.test.tsx`. They use fake shell windows and a fake fetch. Browser confinement still needs the real browser gate.

### Safe fixtures and limits

Use only synthetic agents, fake bearers (for example `fake-bearer-alice`), disposable `YOPLAI_HOME` directories, and ephemeral loopback ports.
`apps/gateway/src/server/dashboard-views.http.test.ts` runs the real adapter, the real global middleware, and a remote with the real renderer and a SQLite file.
It switches users by relinking the fake bearer, which also proves that a relink ends old snapshots.
`apps/gateway/src/relay/dashboard-view-shell.test.ts` runs the shell script against a fake window. It checks what the shell tells its host.
The tests do not prove browser behavior: that the shell policy confines the renderer, opaque-origin loading, `Sec-Fetch-*` values, Vite proxy headers, history and cached restoration, CSV download, popups, and annotation need a real browser check.
If the browser check fails, stop and ask. A separate loopback origin would still need a document identity contract.

Global administration, agent creation, account Slack pairing, and shared catalog writes remain outside this batch.
The external MCP source stays unchanged.
Synthetic transport tests do not prove the external MCP runtime or browser popup behavior.
