// Starts a gateway with a fake model, for the relay tests. It runs in its own process.
// Env: FIXTURE_HOME (state dir), FIXTURE_AGENTS (comma list of agent ids), FIXTURE_LABEL (reply prefix).
import path from "node:path";
import type { AddressInfo } from "node:net";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const home = process.env.FIXTURE_HOME ?? "";
const label = process.env.FIXTURE_LABEL ?? "gateway";
process.env.YOPLAI_HOME = path.join(home, ".yoplai");
process.env.HOME = home;

await writeTestV3Config(process.env.YOPLAI_HOME, {
  agents: (process.env.FIXTURE_AGENTS ?? "").split(",").map((id) => ({ id })),
});

const { piAdapter } = await import("../sdk/pi/adapter.js");
piAdapter.run = async (params) => {
  const text = `${label} answers ${params.agentId}: ${params.message}`;
  params.onHistoryEvent({ type: "user", text: params.message, timestamp: Date.now() });
  params.onEvent({ type: "text", data: text });
  params.onHistoryEvent({ type: "assistant_text", text, timestamp: Date.now() });
  params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
  return { text };
};

const { startServer } = await import("../server/index.js");
const server = startServer(0, "127.0.0.1");
server.once("listening", () => {
  console.log(`PORT ${(server.address() as AddressInfo).port}`);
});
