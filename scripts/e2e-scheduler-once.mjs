import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = await fs.mkdtemp(
  path.join(os.tmpdir(), "yoplai-scheduler-once-e2e-")
);
let gateway;
let gatewayLog = "";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${label}; gateway log: ${gatewayLog.slice(-3000)}`
  );
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const agentDir = path.join(home, "agents", "once-e2e");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(home, "yoplai.json"),
    JSON.stringify({
      version: 3,
      agents: ["agents/*"],
      gateway: { host: "127.0.0.1", port },
      ui: { enabled: false },
      extensions: { scheduler: { enabled: true } },
    })
  );
  await fs.writeFile(
    path.join(agentDir, "agent.yaml"),
    [
      "id: once-e2e",
      "name: One-shot E2E",
      "model:",
      "  provider: openai",
      "  model: gpt-4o-mini",
      "",
    ].join("\n")
  );
  await fs.writeFile(
    path.join(agentDir, "mark.sh"),
    '#!/bin/bash\nnode -e \'require("node:fs").appendFileSync("marker.txt", Date.now() + "\\n")\'\n'
  );

  gateway = spawn(
    "pnpm",
    [
      "--filter",
      "@yoplai/gateway",
      "exec",
      "tsx",
      "src/cli/index.ts",
      "gateway",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YOPLAI_HOME: home,
        YOPLAI_SKIP_WEB: "1",
        NODE_OPTIONS: "--conditions=development",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on("data", (chunk) => {
      gatewayLog = (gatewayLog + chunk.toString()).slice(-10_000);
    });
  }
  await waitFor(
    async () => {
      if (gateway.exitCode !== null)
        throw new Error(`Gateway exited early: ${gatewayLog}`);
      try {
        return (await globalThis.fetch(`${base}/api/capabilities`)).ok;
      } catch {
        return false;
      }
    },
    30_000,
    "gateway startup"
  );

  const runAt = new Date(Date.now() + 60_000).toISOString();
  const createdResponse = await globalThis.fetch(`${base}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "once-e2e",
      name: "one-shot e2e",
      schedule: { runAt },
      payload: { script: "mark.sh", noAgent: true },
    }),
  });
  assert.equal(
    createdResponse.status,
    201,
    createdResponse.ok ? "" : await createdResponse.text()
  );
  const created = await createdResponse.json();
  const markerPath = path.join(agentDir, "marker.txt");
  await assert.rejects(fs.stat(markerPath), { code: "ENOENT" });

  const completed = await waitFor(
    async () => {
      const response = await globalThis.fetch(
        `${base}/api/schedules?agent=once-e2e`
      );
      if (!response.ok) throw new Error(`List failed: ${response.status}`);
      const jobs = await response.json();
      const job = jobs.find((candidate) => candidate.id === created.id);
      return job?.enabled === false ? job : undefined;
    },
    360_000,
    "one-shot completion"
  );

  const marks = (await fs.readFile(markerPath, "utf8")).trim().split("\n");
  assert.equal(marks.length, 1, "script ran exactly once");
  assert(
    Number(marks[0]) >= Date.parse(runAt),
    "marker was written before runAt"
  );
  assert.equal(completed.state?.nextRunAtMs, undefined);
  const outputDir = path.join(agentDir, "cron", "output", created.id);
  const outputs = (await fs.readdir(outputDir)).filter((name) =>
    name.endsWith(".md")
  );
  assert.equal(outputs.length, 1, "one output record");
  const persisted = JSON.parse(
    await fs.readFile(path.join(agentDir, "cron", "jobs.json"), "utf8")
  );
  assert.equal(
    persisted.jobs.find((job) => job.id === created.id)?.enabled,
    false
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      runAt,
      markerAt: new Date(Number(marks[0])).toISOString(),
      jobId: created.id,
      outputs: outputs.length,
      disabled: true,
      nextRunAtMs: completed.state?.nextRunAtMs ?? null,
      gatewayPort: port,
    })
  );
} finally {
  if (gateway?.pid) {
    const closed = new Promise((resolve) => gateway.once("close", resolve));
    try {
      process.kill(-gateway.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
    const graceful = await Promise.race([
      closed.then(() => true),
      sleep(5000, false),
    ]);
    if (!graceful) {
      try {
        process.kill(-gateway.pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
      await Promise.race([closed, sleep(5000)]);
    }
  }
  await fs.rm(home, { recursive: true, force: true });
}
