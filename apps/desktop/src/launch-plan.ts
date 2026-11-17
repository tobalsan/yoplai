import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface ChildLaunch {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Everything the shell needs to start and load the app. */
export interface LaunchPlan {
  children: ChildLaunch[];
  /** URLs that must answer 2xx before the window loads. */
  readyUrls: string[];
  /** URL the main window loads. */
  uiUrl: string;
}

export interface LaunchPorts {
  gatewayPort: number;
  uiPort: number;
}

export const BASE_GATEWAY_PORT = 4000;
export const BASE_UI_PORT = 3000;
/** The shell always uses loopback, whatever the home config says. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Dev-mode plan: run the gateway and the Vite dev server from repo source.
 * Mirrors scripts/dev.ts. Vite runs as a separate child and the gateway gets
 * YOPLAI_SKIP_WEB=1, so the UI port is the port chosen by the shell.
 * This is the only module that knows about pnpm, tsx, and Vite.
 */
export function createDevLaunchPlan({ gatewayPort, uiPort }: LaunchPorts): LaunchPlan {
  const uiUrl = `http://${LOOPBACK_HOST}:${uiPort}`;
  const gatewayNodeOptions = [process.env.NODE_OPTIONS, "--conditions=development"]
    .filter(Boolean)
    .join(" ");
  return {
    uiUrl,
    readyUrls: [`http://${LOOPBACK_HOST}:${gatewayPort}/health`, uiUrl],
    children: [
      {
        name: "web",
        command: "pnpm",
        args: ["--filter", "@yoplai/web", "dev"],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          YOPLAI_DEV: "1",
          YOPLAI_GATEWAY_PORT: String(gatewayPort),
          YOPLAI_UI_PORT: String(uiPort),
          YOPLAI_UI_HOST: LOOPBACK_HOST,
          YOPLAI_GATEWAY_HOST: LOOPBACK_HOST,
          VITE_YOPLAI_DEV: "true",
          VITE_YOPLAI_UI_PORT: String(uiPort),
        },
      },
      {
        name: "gateway",
        command: "pnpm",
        args: [
          "--filter", "@yoplai/gateway", "exec", "tsx", "src/cli/index.ts",
          "gateway", "--dev", "--host", LOOPBACK_HOST, "--port", String(gatewayPort),
        ],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          YOPLAI_SKIP_WEB: "1",
          YOPLAI_DEV: "1",
          YOPLAI_WORKSPACE_ROOT: REPO_ROOT,
          YOPLAI_GATEWAY_PORT: String(gatewayPort),
          YOPLAI_UI_PORT: String(uiPort),
          YOPLAI_UI_HOST: LOOPBACK_HOST,
          YOPLAI_GATEWAY_HOST: LOOPBACK_HOST,
          NODE_OPTIONS: gatewayNodeOptions,
        },
      },
    ],
  };
}
