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

| Field               | Default               | Meaning                                             |
| ------------------- | --------------------- | --------------------------------------------------- |
| `image`             | `yoplai-agent:latest` | Docker image                                        |
| `network`           | global network        | Docker network                                      |
| `memory`            | `2g`                  | Memory limit                                        |
| `cpus`              | `1`                   | CPU limit                                           |
| `maxRunTime`        | `1800`                | Kill deadline in seconds                            |
| `retryMaxAttempts`  | `3`                   | Attempts for a zero-output transient provider error |
| `retryBaseDelay`    | `2`                   | Initial retry delay in seconds                      |
| `workspaceWritable` | `false`               | Workspace mount writes                              |
| `env`               | `{}`                  | Explicit container environment                      |
| `mounts`            | `[]`                  | Additional validated binds                          |

`timeout` remains legacy fallback for `maxRunTime`.

Retry delays double after each attempt unless the provider supplies a `Retry-After` hint. Only a failed turn with no emitted text, thinking, or tool activity is retried.

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

Without OneCLI, choose network with direct egress and explicitly provide required non-secret/safe env through sandbox configuration. Agent-local `.env` is not injected into containers.

## Security notes

- Containers run unprivileged and are removed on exit.
- Secret-looking sandbox env keys/values are filtered.
- Custom mounts use allowlist/blocklist validation.
- Startup and shutdown clean orphan containers.
- Isolation is only as strong as Docker host policy, mounted paths, network config, and callback tools.
- Never expose Docker socket to agent container.
