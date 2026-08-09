# Scheduling and periodic work

Scheduler extension owns cron jobs, scripts/gates, run outputs, and delivery. Heartbeat and nightly dreams are related periodic services with distinct configuration.

## Enable scheduler

```json
{
  "extensions": {
    "scheduler": { "enabled": true }
  }
}
```

Jobs live in `<agent-workspace>/cron/jobs.json`; output lives under `cron/output/<job-id>/`.

## CLI

```bash
yoplai scheduler add my-agent --cron "0 * * * *" --tz UTC \
  -m "Run hourly check"

yoplai scheduler add my-agent --cron "0 9 * * *" \
  --tz America/New_York \
  -m "Generate standup" \
  --provider anthropic --model claude-sonnet-4

yoplai scheduler list --agent my-agent
yoplai scheduler run my-agent <job-id>
yoplai scheduler tail my-agent <job-id>
yoplai scheduler rm my-agent <job-id> -y
```

Manual run uses same execution/output path, works for disabled jobs, and does not shift next cron fire. Concurrent execution of same job is rejected/skipped.

Scheduler supports plain agent prompts, script-only jobs, wake-agent script gates, quiet outputs, model overrides, timeouts, and channel/user delivery. For exact JSON schemas, script security, tool fields, and examples see [scheduler README](../packages/extensions/scheduler/README.md).

## HTTP example

```bash
curl -X POST http://127.0.0.1:4000/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Hourly check",
    "agentId": "my-agent",
    "schedule": { "cron": "0 * * * *", "tz": "UTC" },
    "payload": { "message": "Run hourly check" }
  }'
```

Scheduler hot-reloads config, agent YAML, and cron files. Enabled agents receive self-only scheduler tools.

## Heartbeat

Heartbeat periodically asks agent to check in and only alerts configured channel on notable response.

```yaml
heartbeat:
  every: 30m
  prompt: Check on your human
  ackMaxChars: 300
```

Agent replies containing `HEARTBEAT_OK` within acknowledgement limit are not delivered. Empty response is also quiet. Alerts and errors write output under `cron/output/__heartbeat__/`. Heartbeat requires scheduler enabled; otherwise it logs warning and does not run.

## Nightly dreams

Dreams consolidate durable lessons from recent sessions:

```yaml
dream: true
# or
dream:
  enabled: true
  time: "02:30"
  provider: anthropic
  model: claude-sonnet-4
```

`provider` and `model` must be paired. State and journals live in agent `dreams/`; successful run advances consolidation window.

Global overrides:

```json
{
  "dream": {
    "prompt": "Custom consolidation instructions...",
    "timeoutMs": 1800000,
    "coldStartHours": 24
  }
}
```

Run now or inspect without mutation:

```bash
yoplai dream my-agent
yoplai dream my-agent --dry-run
```
