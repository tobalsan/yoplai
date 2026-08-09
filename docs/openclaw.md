# OpenClaw SDK

OpenClaw adapter connects Yoplai to an existing [OpenClaw](https://github.com/openclaw/openclaw) gateway over WebSocket.

## Agent configuration

```yaml
# agents/cloud/agent.yaml
id: cloud
name: Cloud
sdk: openclaw
openclaw:
  gatewayUrl: ws://127.0.0.1:18789
  token: "$env:OPENCLAW_GATEWAY_TOKEN"
  sessionKey: agent:main:main
model:
  provider: openclaw
  model: claude-sonnet-4
```

Store token in agent `.env` or another untracked env source.

| Field                 | Meaning                                               |
| --------------------- | ----------------------------------------------------- |
| `openclaw.gatewayUrl` | Gateway WebSocket URL; default `ws://127.0.0.1:18789` |
| `openclaw.token`      | OpenClaw gateway token                                |
| `openclaw.sessionKey` | Target OpenClaw session                               |

Yoplai schema still requires `model`; actual model is controlled by OpenClaw and Yoplai field is display/validation metadata.

## Session keys

OpenClaw keys commonly look like `agent:<agent-name>:<session>`. First two segments must match OpenClaw agent. `agent:main:main` shares main conversation; another final segment selects distinct session.

Inspect available sessions on OpenClaw host:

```bash
openclaw sessions list
```

## Debugging

Set `OPENCLAW_DEBUG=1` before gateway startup to log raw WebSocket frames. Treat logs as sensitive because frames may include conversation content.
