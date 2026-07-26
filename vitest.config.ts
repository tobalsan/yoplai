import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";

const sharedSrc = fileURLToPath(
  new URL("./packages/shared/src/index.ts", import.meta.url)
);
const sharedSrcDir = fileURLToPath(
  new URL("./packages/shared/src/", import.meta.url)
);
const setupFile = fileURLToPath(new URL("./vitest.setup.ts", import.meta.url));

// Extension source directories (for vitest to use src/ instead of dist/)
const extSrc = (name: string, file = "index.ts") =>
  fileURLToPath(new URL(`./packages/extensions/${name}/src/${file}`, import.meta.url));

export default defineConfig({
  plugins: [solid({ hot: false })],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/web.js" },
      { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
      {
        find: /^@yoplai\/shared\/(.+)$/,
        replacement: `${sharedSrcDir}$1.ts`,
      },
      { find: "@yoplai/shared", replacement: sharedSrc },
      // Extension aliases — keep vitest using src/ to avoid dist/ singleton splits
      { find: "@yoplai/extension-heartbeat", replacement: extSrc("heartbeat") },
      { find: "@yoplai/extension-scheduler", replacement: extSrc("scheduler") },
      { find: "@yoplai/extension-langfuse", replacement: extSrc("langfuse") },
      { find: "@yoplai/extension-discord", replacement: extSrc("discord") },
      { find: "@yoplai/extension-slack", replacement: extSrc("slack") },
      { find: "@yoplai/extension-webhooks", replacement: extSrc("webhooks") },
      { find: /^@yoplai\/extension-multi-user\/isolation$/, replacement: extSrc("multi-user", "isolation.ts") },
      { find: /^@yoplai\/extension-multi-user\/middleware$/, replacement: extSrc("multi-user", "middleware.ts") },
      { find: "@yoplai/extension-multi-user", replacement: extSrc("multi-user") },
      { find: /^@yoplai\/extension-projects\/profiles\/resolver$/, replacement: extSrc("projects", "profiles/resolver.ts") },
      { find: "@yoplai/extension-projects", replacement: extSrc("projects") },
      { find: "@yoplai/extension-board", replacement: extSrc("board") },
      { find: "@yoplai/extension-subagents", replacement: extSrc("subagents") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: [setupFile],
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
    environmentMatchGlobs: [["apps/web/src/**/*.test.tsx", "jsdom"]],
    deps: {
      inline: ["solid-js", "solid-js/web"],
    },
  },
});
