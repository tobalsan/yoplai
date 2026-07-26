#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const UI_PORT_RANGE = {
  start: 3001,
  end: 3100,
};
const GATEWAY_PORT_RANGE = {
  start: 4001,
  end: 4100,
};
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const templatePath = path.join(scriptDir, "config-template.json");
const agentsSourceDir = path.join(scriptDir, "agents");
const outputDir = path.join(repoRoot, ".yoplai");
const outputPath = path.join(outputDir, "yoplai.json");
const agentsOutputDir = path.join(outputDir, "agents");
const projectsOutputDir = path.join(outputDir, "projects");

const orchestratorProjects = [
  {
    folder: "orchestrator-test",
    linearProjectSlug: "a48c97c1f7fc",
  },
];

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port);
  });
}

async function findAvailablePort(range) {
  const ports = [];
  for (let port = range.start; port <= range.end; port += 1) {
    ports.push(port);
  }

  const results = await Promise.all(ports.map((port) => checkPort(port)));
  const index = results.findIndex(Boolean);

  if (index === -1) {
    throw new Error(
      `No available port found between ${range.start} and ${range.end}.`
    );
  }

  return ports[index];
}

function workflowFile(project) {
  return `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ${project.linearProjectSlug}
  active_states: [Todo, In Progress]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]
  needs_human: Needs Human
polling:
  interval_ms: 30000
  jitter_ms: 5000
workspace:
  root: ./workspaces
  cleanup_on_terminal: false
agent:
  runner: claude
  model: claude-sonnet-4-6
  max_concurrent: 3
---
You are working on Linear issue {{issue.identifier}}.

## DO THIS FIRST

1. Fetch Linear issue {{issue.identifier}}.
2. If current state is \`Todo\`, move it to \`In Progress\`.
3. Add or update one Linear comment signaling you are working on the issue.
4. Continue only after those Linear updates succeed.

Do not perform task work before this claim step.

## Workspace Rule

Work only inside the issue workspace. If repositories are needed, clone or use them inside this workspace unless hooks prepared them already.

## Linear Workflow

Update Linear with concise progress, validation results, and final handoff. Prefer updating your initial Linear comment while no other comments follow it. If another person or agent has commented after your initial comment, post a new comment instead so the timeline stays clear.

When the work is complete and validated, move the issue to \`In Review\`. If you are blocked, move the issue to \`Needs Human\` and update the comment with the blocker, what you tried, and the decision needed.

## Code Changes and Review Flow

If, and only if, you need to make code changes:

1. Create a worktree from the \`main\` branch and work there.
2. Spawn a reviewer subagent to run a code review.
3. Do not commit anything until the review comes back clean.
4. Once review is clean, commit inside the worktree, create a PR using \`gh\`, link the PR to the Linear issue, and move the issue to \`In Review\`.

## Golden Rule: Clarification Over Assumption

Ask rather than assume when requirements, ownership, or risk are unclear. Involve HITL by updating the Linear comment with the question or blocker and moving the issue to \`Needs Human\`.
`;
}

async function seedOrchestratorProjects() {
  await mkdir(projectsOutputDir, { recursive: true });

  await Promise.all(
    orchestratorProjects.map(async (project) => {
      const projectDir = path.join(projectsOutputDir, project.folder);
      await rm(projectDir, { recursive: true, force: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, "WORKFLOW.md"),
        workflowFile(project)
      );
    })
  );
}

async function main() {
  const [template, gatewayPort, uiPort] = await Promise.all([
    readFile(templatePath, "utf8"),
    findAvailablePort(GATEWAY_PORT_RANGE),
    findAvailablePort(UI_PORT_RANGE),
  ]);
  const content = template
    .replaceAll("__GATEWAY_PORT__", String(gatewayPort))
    .replaceAll("__UI_PORT__", String(uiPort));

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, content);
  await cp(agentsSourceDir, agentsOutputDir, { recursive: true });
  await seedOrchestratorProjects();

  stdout.write(
    `Wrote ${path.relative(repoRoot, outputPath)} with gateway ${gatewayPort} and ui ${uiPort}\n`
  );
  stdout.write(
    `Copied agents to ${path.relative(repoRoot, agentsOutputDir)}\n`
  );
  stdout.write(
    `Seeded ${orchestratorProjects.length} orchestrator projects in ${path.relative(repoRoot, projectsOutputDir)}\n`
  );
}

await main();
