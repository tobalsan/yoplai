FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ripgrep fd-find jq curl \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY container/agent-runner/package.json ./container/agent-runner/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter @yoplai/agent-runner... 2>/dev/null || pnpm install --prod --filter @yoplai/agent-runner...
COPY packages/shared/dist/ ./packages/shared/dist/
COPY container/agent-runner/dist/ ./container/agent-runner/dist/
ENV UV_CACHE_DIR=/tmp/uv-cache
# OneCLI CA cert will be bind-mounted at runtime
WORKDIR /app/container/agent-runner
USER node
ENTRYPOINT ["node", "dist/index.js"]
