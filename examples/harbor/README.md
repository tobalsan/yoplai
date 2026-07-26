# Harbor eval engine for Yoplai

Vendor-neutral [Harbor](https://www.harborframework.com/) eval infrastructure for Yoplai agents.

See `docs/plans/harbor-evals-for-yoplai-migration.md` for the full design.

## What lives here

```
base/
  yoplai-eval/          # base Docker image every task FROMs (runtime only, no agent config)
agents/
  yoplai_installed.py   # generic Harbor BaseInstalledAgent reference wrapper
tasks/
  smoke/               # minimal contract test for the eval CLI
```

This directory provides the **eval engine** — the runtime, base image, and agent wrapper. Product-specific content (tasks, fake sidecars, agent config) lives in the blueprint repo that consumes these artifacts.

## Running the smoke task

Prerequisites: [Harbor](https://www.harborframework.com/docs/getting-started) installed, Docker running.

```bash
# Build the base image (from repo root)
docker build -t yoplai-eval-base:local \
  -f examples/harbor/base/yoplai-eval/Dockerfile .

# Run the smoke task
harbor run \
  -p examples/harbor/tasks/smoke \
  --agent-import-path examples.harbor.agents.yoplai_installed:InstalledAgent \
  --env docker
```

## For blueprint repos

Blueprint repos (e.g. cloudihub) consume the base image and provide their own:
- Agent config (`yoplai.json`, `models.json`, `agents/`, `connectors/`)
- Fake HTTP sidecars for connector stubbing
- Harbor tasks, datasets, and verifiers
- Product-specific agent wrapper with a default agent id

See the plan doc for the full Option C ownership model.
