// Starts a whole gateway (the same startup as `yoplai gateway`) in its own process, for the browser link tests.
// Env: FIXTURE_HOME (state dir), FIXTURE_PORT (gateway port), FIXTURE_MODE (`remote` has email and password sign-in).
// The web UI is off. Every secret here is synthetic.
import path from "node:path";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const home = process.env.FIXTURE_HOME ?? "";
const port = Number(process.env.FIXTURE_PORT);
const catalogUrl = process.env.FIXTURE_CATALOG_URL;
const remote = process.env.FIXTURE_MODE === "remote";
process.env.YOPLAI_HOME = path.join(home, ".yoplai");
process.env.HOME = home;

await writeTestV3Config(process.env.YOPLAI_HOME, {
  agents: [{ id: "pom" }],
  ...(remote
    ? { extensions: { sample: { enabled: true }, multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "synthetic-link-session-secret-32chars!" } } }
    : {}),
  extraConfig: {
    ...(catalogUrl ? { extensionCatalog: { url: catalogUrl } } : {}),
    gateway: { port, host: "127.0.0.1" },
    server: { baseUrl: `http://127.0.0.1:${port}` },
    ui: { enabled: false, port: port + 1 },
    // The app view listener has a fixed default port. Moving it keeps the test off ports that a real stack uses.
    apps: { port: port + 2 },
  },
});

const { startGatewayCommand } = await import("../cli/gateway.js");
await startGatewayCommand({ port: String(port) });
console.log(`READY ${port}`);
