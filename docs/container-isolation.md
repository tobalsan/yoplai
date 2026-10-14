# Container isolation

Agents can run in fresh Docker containers for filesystem, network, and credential separation. Every invocation uses `docker run -i --rm`; Docker is not required for normal in-process agents.

## When to use

- untrusted or third-party agent tools
- multi-tenant deployments
- restricted filesystem access
- controlled network egress and credential injection

## Prerequisites

Install and start Docker. Build image from repository root:

```bash
docker build -t yoplai-agent:latest -f container/agent-runner/Dockerfile .
```

Default image is also content-hashed and rebuilt by gateway when relevant build inputs drift; custom images are never auto-rebuilt.

The image includes pinned `playwright-cli` and Chromium for dashboard visual checks, with headless launch defaults (`--no-sandbox`, `--disable-dev-shm-usage`). Browser binaries live in the image; browser state/output defaults to `/tmp/playwright`, never the workspace. Follow the dashboard skill's "Check it visually" recipe; no browser installation or custom rendering harness is needed.

### Rootless Docker

Rootless Docker maps the daemon owner's host uid to container uid 0, so the gateway's own uid names an id that owns nothing inside the container and every bind mount fails with `EACCES`. Set `YOPLAI_CONTAINER_USER=0:0` in the gateway environment. A rootful daemon maps uid to uid and needs no change.

Rootless Docker also blocks the host loopback from containers, so a run cannot reach the gateway at `host.docker.internal` and every gateway tool (`dashboard_link`, scheduler tools, `extract_document`, extension and MCP tools) and OAuth renewal fail with `fetch failed`. Use the socket transport below.

### Gateway transport

Sandboxed runs call the gateway's `/internal` routes for every gateway-provided tool and for OAuth token renewal. By default they dial `http://host.docker.internal:<port>`, which needs a network path from the container to the host. Rootless Docker removes that path, and Docker `internal` networks (the default sandbox network) are designed to have no route out either.

Set the root `sandbox.gatewayTransport` to `socket` to use a Unix socket instead:

```json
{ "sandbox": { "gatewayTransport": "socket" } }
```

The gateway then also listens on `$YOPLAI_HOME/run/sandbox-gateway/gateway.sock` (directory `0700`, socket `0600`), serving only `/internal`: nothing else of the gateway, notably `/api`, is reachable through it, and every call still requires the run's agent token. The socket starts whenever the socket transport is configured, even before any agent is sandboxed, so an agent whose sandbox is enabled later by a config reload finds it listening; changing `gatewayTransport` itself takes a gateway restart. Each sandboxed run mounts that directory read-only at `/run/yoplai`. No network route to the host is needed. The socket is owned by the gateway user, which matches the container user in both rootful (`--user` = gateway uid) and rootless (`YOPLAI_CONTAINER_USER=0:0`) setups. Docker Desktop on macOS cannot pass Unix sockets through its file sharing; keep the default `http` there.

## Enable one agent

```yaml
id: sandboxed-agent
name: Sandboxed Agent
model:
  provider: anthropic
  model: claude-sonnet-4-5
sandbox:
  enabled: true
```

Defaults:

| Field               | Default               | Meaning                        |
| ------------------- | --------------------- | ------------------------------ |
| `image`             | `yoplai-agent:latest` | Docker image                   |
| `network`           | global network        | Docker network                 |
| `memory`            | `2g`                  | Memory limit                   |
| `cpus`              | `1`                   | CPU limit                      |
| `maxRunTime`        | `1800`                | Kill deadline in seconds       |
| `workspaceWritable` | `false`               | Workspace mount writes         |
| `env`               | `{}`                  | Explicit container environment |
| `mounts`            | `[]`                  | Additional validated binds     |

`timeout` remains legacy fallback for `maxRunTime`.

The idle watchdog defaults to 300 seconds. Each observed tool call suspends idle
expiry and gets its own deadline: a positive finite tool `timeout` in seconds,
or 300 seconds for missing/invalid timeouts, plus 15 seconds
of grace. There is no policy cap on an explicit timeout. Tool results re-arm
a full idle interval when no calls remain; text and queued messages never extend
a tool deadline. Overdue calls fail the run with `tool_deadline`.

`maxRunTime` is independent and never renewed. Pi Bash timeouts are reduced when
they exceed the remaining turn time, leaving one second for the native timeout
error to be delivered; the tool result includes `timeout reduced to Ns: turn time limit`.

Gateway tools, including extension/MCP tools, `dashboard_link`,
`extract_document`, and `describe_image`, also accept optional `timeout` seconds
and reserve one second when trimming to the remaining turn time. Their deadline
returns `tool <name> timed out after <N>s` so the agent can continue before the
watchdog fires. The gateway strips `timeout` from forwarded extension arguments.
Each call has an independent abort signal, combined with run cancellation;
manual abort, max runtime, idle shutdown, and tool-deadline shutdown cancel
in-flight gateway work. Late results and progress are discarded. Extension
authors must cooperate by forwarding `context.signal` to external requests and
checking it before side effects: timeout does not prove a remote write did not
happen. MCP transport cancellation requires the external extension to forward
this signal.
The turn watchdog still wins if the agent cannot finish within the turn budget.
Shutdown coalesces stop requests, falls back to kill after stop failure, and
verifies stopped/absent state within a 15-second enforcement budget. Late output
cannot turn a timeout into success.

Transient provider errors are retried the same way inside and outside the sandbox; see the agent-level `retryMaxAttempts`/`retryBaseDelay` keys in [configuration.md](configuration.md).

## Global sandbox policy

```json
{
  "sandbox": {
    "sharedDir": "~/agents/shared",
    "network": { "name": "yoplai-agents", "internal": true },
    "mountAllowlist": {
      "allowedRoots": ["~/agents", "~/projects"],
      "blockedPatterns": [".ssh", ".gnupg", ".aws", ".env"]
    }
  }
}
```

Custom mounts must resolve beneath allowed roots and avoid blocked patterns. Container target paths must be absolute without traversal.

## Files and tools

- agent data mounts writable at `/workspace/data`
- request uploads mount read-only at `/workspace/uploads`
- workspace is read-only unless explicitly writable
- workspace `.env` is shadowed with `/dev/null`
- extension prompts/tools serialize in `ContainerInput`
- tool calls return through authenticated `/internal/tools`
- outbound file requests are validated, copied, and registered in managed media

Pi extension tools work in and out of containers. Sandbox Claude rejects configured extension tools rather than silently dropping them.

Each run gets unique container name, authentication token, and IPC directory. Follow-ups and aborts are addressed by agent/session/run so concurrent containers cannot consume each other's messages.

Pi tool subprocesses receive `YOPLAI_GATEWAY_URL`, `YOPLAI_AGENT_TOKEN`, and `YOPLAI_DASHBOARD_URL_PREFIX` (`$YOPLAI_GATEWAY_URL/internal/dashboards`). The per-run token already enters the container through stdin; exporting it to Bash adds no new trust boundary. Treat these private preview URLs as credentials.

`GET /internal/dashboards/:slug/html` accepts `X-Agent-Token` or a `token` query parameter on this route only, because browser navigation cannot set headers. It renders only the token owner's dashboard, with null viewer bindings, normal query params, optional `theme=light|dark`, the viewer CSP, and `Cache-Control: no-store`. Drill-down links carry the token and theme. Previewing does not record a dashboard version. The browser still has only the sandbox's configured network access.

## Network and credentials

Default internal network has no direct internet. Top-level `onecli` can provide controlled proxy egress; set per-agent `onecliToken`.

```json
{
  "onecli": {
    "enabled": true,
    "gatewayUrl": "http://localhost:10255",
    "mode": "proxy",
    "ca": { "source": "file", "path": "~/.onecli/gateway/ca.pem" }
  }
}
```

### Provider API keys with OneCLI

Keep real provider keys out of the gateway host. Store each key as a OneCLI generic secret whose host pattern is the provider API host (e.g. `openrouter.ai` for `openrouter`, `opencode.ai` for `opencode-go`); the proxy swaps it into outbound requests. The gateway still needs a non-empty `<PROVIDER>_API_KEY` in `$YOPLAI_HOME/.env` to pass credential resolution, so set a dummy value there (e.g. `OPENCODE_API_KEY=onecli`). This applies to both sandboxed and host agents, since host agents also route through OneCLI when it is enabled.

Without OneCLI, choose network with direct egress and explicitly provide required non-secret/safe env through sandbox configuration. Agent-local `.env` is not injected into containers.

### OAuth providers in sandboxed agents

OAuth-only providers (e.g. `openai-codex`) cannot use the OneCLI static-key swap. Log in on the host once (`yoplai auth login openai-codex`), then set the agent's auth mode:

````yaml
sdk: pi
auth:
  mode: oauth
model:
  provider: openai-codex
  model: gpt-5.6-terra
sandbox:
  enabled: true
````

The gateway also detects OAuth credentials for explicit per-run model
overrides, so a scheduler job can use an OAuth provider even when the agent's
default provider uses an API key. The gateway pre-refreshes OAuth credentials
on the host (from `$YOPLAI_HOME/auth.json`) and passes only short-lived access
tokens into the container via `ContainerInput.oauthTokens`; the runner renews
only providers authorized for that run through `POST /internal/oauth-token`
(with the same per-run identity checks as `/internal/tools`) when under 10
minutes of validity remain. Refresh tokens never enter the sandbox. Do not add
a OneCLI secret mapping for an OAuth provider's API host — the proxy would
overwrite the injected Authorization header.

## Security notes

- Containers run unprivileged and are removed on exit.
- Secret-looking sandbox env keys/values are filtered.
- Custom mounts use allowlist/blocklist validation.
- Startup and shutdown clean orphan containers.
- Isolation is only as strong as Docker host policy, mounted paths, network config, and callback tools.
- Never expose Docker socket to agent container.
````
