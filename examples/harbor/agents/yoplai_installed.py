"""
Harbor installed-agent wrapper for Yoplai.

Generic, vendor-neutral reference implementation. Drops into Harbor via
`--agent-import-path`. Expects the container to be built FROM
`yoplai-eval-base`, which bakes the `yoplai` CLI.

The wrapper does not boot Yoplai itself — it only shells out to
`yoplai eval run` inside the container. All agent behavior lives in the
Yoplai runtime; Harbor just orchestrates trials and reads the output
contract (`/logs/agent/result.json` + `/logs/agent/trajectory.json`).

Blueprint repos should copy this file and set DEFAULT_AGENT to
their own agent id, or set `yoplai_agent` in task.toml [metadata].
"""
from __future__ import annotations

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class InstalledAgent(BaseInstalledAgent):
    """
    Minimal wrapper. `yoplai_agent` is the agent id (as defined in the eval
    container's yoplai.json) to evaluate. Set via task.toml [metadata]
    yoplai_agent, or override DEFAULT_AGENT in a subclass.
    """

    DEFAULT_AGENT: str | None = None
    INSTRUCTION_PATH = "/app/instruction.md"
    RESULT_PATH = "/logs/agent/result.json"
    TRAJECTORY_PATH = "/logs/agent/trajectory.json"

    @staticmethod
    def name() -> str:
        return "yoplai-installed"

    def version(self) -> str | None:
        return "0.1.0"

    async def install(self, environment: BaseEnvironment) -> None:
        # The yoplai CLI is baked into yoplai-eval-base; nothing to install.
        return None

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Write the instruction into the container so yoplai eval run can
        # read it from a stable path.
        await self.exec_as_agent(
            environment,
            command=f"mkdir -p /app && cat > {self.INSTRUCTION_PATH} <<'YOPLAI_EOF'\n{instruction}\nYOPLAI_EOF",
        )

        agent_id = self._resolve_agent_id(context)
        # Fall back to the pre-rename `aihub` binary in case the base image
        # was built before the yoplai rename and only has that CLI baked in.
        cmd = (
            "BIN=$(command -v yoplai || command -v aihub) &&"
            ' "$BIN" eval run'
            f" --agent {shlex.quote(agent_id)}"
            f" --instruction-file {self.INSTRUCTION_PATH}"
            f" --output {self.RESULT_PATH}"
            f" --trace {self.TRAJECTORY_PATH}"
        )
        await self.exec_as_agent(environment, command=cmd)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """
        Read result.json and populate AgentContext for Harbor's metrics
        aggregation. Errors are non-fatal: if the agent failed to write
        result.json, the verifier will detect it via its own assertions.
        """
        result_path = self.logs_dir / "agent" / "result.json"
        if not result_path.exists():
            return
        try:
            result = json.loads(result_path.read_text())
        except Exception:
            return

        metrics = result.get("metrics") or {}
        context.cost_usd = float(metrics.get("costUsd", 0) or 0)
        context.n_input_tokens = int(metrics.get("inputTokens", 0) or 0)
        context.n_output_tokens = int(metrics.get("outputTokens", 0) or 0)

    def _resolve_agent_id(self, context: AgentContext) -> str:
        # task.toml [metadata] can set yoplai_agent to target a different
        # agent from the default. Harbor passes metadata through on
        # AgentContext.metadata. aihub_agent is accepted for task.toml files
        # written before the yoplai rename.
        metadata = getattr(context, "metadata", None) or {}
        if isinstance(metadata, dict):
            value = metadata.get("yoplai_agent") or metadata.get("aihub_agent")
            if isinstance(value, str) and value:
                return value
        if self.DEFAULT_AGENT is None:
            raise ValueError(
                "No agent id configured. Set yoplai_agent in task.toml "
                "[metadata] or override DEFAULT_AGENT in a subclass."
            )
        return self.DEFAULT_AGENT
