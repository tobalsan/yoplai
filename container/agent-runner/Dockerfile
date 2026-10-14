FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ripgrep fd-find jq curl sqlite3 \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Keep the CLI and its matching browser in the image, outside writable mounts.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    PLAYWRIGHT_MCP_CONFIG=/opt/playwright-cli.json
RUN npm install -g @playwright/cli@0.1.22 \
    && /usr/local/lib/node_modules/@playwright/cli/node_modules/.bin/playwright install --with-deps --no-shell chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY container/agent-runner/playwright-cli.json /opt/playwright-cli.json

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY container/agent-runner/package.json ./container/agent-runner/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter @yoplai/agent-runner... 2>/dev/null || pnpm install --prod --filter @yoplai/agent-runner...
COPY packages/shared/dist/ ./packages/shared/dist/
COPY container/agent-runner/dist/ ./container/agent-runner/dist/
ENV UV_CACHE_DIR=/tmp/uv-cache \
    XDG_CACHE_HOME=/tmp/playwright/cache \
    XDG_CONFIG_HOME=/tmp/playwright/config
# OneCLI CA cert will be bind-mounted at runtime
WORKDIR /app/container/agent-runner
USER node
ENTRYPOINT ["node", "dist/index.js"]
