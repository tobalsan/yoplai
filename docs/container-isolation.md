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

### Rootless Docker

Rootless Docker maps the daemon owner's host uid to container uid 0, so the gateway's own uid names an id that owns nothing inside the container and every bind mount fails with `EACCES`. Set `YOPLAI_CONTAINER_USER=0:0` in the gateway environment. A rootful daemon maps uid to uid and needs no change.

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
