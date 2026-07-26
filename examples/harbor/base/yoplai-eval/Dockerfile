# Vendor-neutral base image every Harbor task FROMs.
# Bakes the yoplai CLI so `yoplai eval run` works headlessly inside the
# trial container.  Agent config (yoplai.json, models.json, agents/,
# connectors/) is NOT included — consuming repos provide it via
# bind-mount or COPY in their task Dockerfile.
#
# Built once per dev loop from the repo root (context must be the
# monorepo root so the builder stage can access packages/ + apps/):
#
#   docker build -t yoplai-eval-base:local \
#     -f examples/harbor/base/yoplai-eval/Dockerfile .
#
# Task images then: FROM yoplai-eval-base:local

# ---------- builder stage ----------
# Build yoplai CLI from source. Produces a self-contained /out via
# `pnpm deploy --prod` (resolves workspace:* deps into real node_modules).
FROM node:20-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /build

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/extensions/projects/package.json packages/extensions/projects/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

# Copy sources and build shared -> projects extension -> gateway.
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/extensions/projects packages/extensions/projects
COPY apps/gateway apps/gateway

# Build via project references (composite: true) from repo root.
# Using `tsc -b` sequences shared -> projects extension -> gateway correctly; running
# each package's `build` script individually fails to resolve workspace
# .d.ts files inside a clean container for reasons that are not worth
# debugging on the spike.
RUN pnpm exec tsc -b

# pnpm deploy flattens workspace:* deps into /out/node_modules,
# producing a self-contained production tree for @yoplai/gateway.
RUN pnpm --filter @yoplai/gateway deploy --prod /out

# ---------- runtime stage ----------
FROM node:20-slim

# System deps:
# - curl, ca-certificates: outbound HTTPS to the LLM API at run time
# - python3: required by uv-managed pytest at verifier runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

# Install uv (and uvx) as static binaries from the official Astral image.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Install pytest into a system-wide uv tool location so the non-root
# `agent` user can run it offline at verifier time.
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/opt/uv/bin \
    PATH=/opt/uv/bin:${PATH}
RUN mkdir -p /opt/uv && uv tool install pytest==8.4.1

# Create the non-root user Harbor expects (task.toml [agent].user = "agent")
RUN useradd --create-home --shell /bin/bash agent

# Install the baked yoplai CLI from the builder stage.
COPY --from=builder /out /opt/yoplai
# pnpm deploy preserves source file modes (often 0600 for workspace
# packages), so the non-root `agent` user cannot read package.json /
# dist files.  Make the whole tree world-readable.
RUN chmod -R a+rX /opt/yoplai \
    && chmod +x /opt/yoplai/dist/cli/index.js \
    && ln -s /opt/yoplai/dist/cli/index.js /usr/local/bin/yoplai

# YOPLAI_HOME for the eval container. Consuming repos bind-mount or
# COPY their own yoplai.json, models.json, agents/, connectors/ into
# /eval at task-image build time or via docker-compose volumes.
ENV YOPLAI_HOME=/eval
RUN mkdir -p /eval /logs/agent /logs/verifier /app/out

# Placeholder yoplai.json — consuming repos override this.
COPY examples/harbor/base/yoplai-eval/yoplai.json /eval/yoplai.json

# External connectors loaded from /eval/connectors/*/index.js walk up
# looking for node_modules. Point them at the gateway's flat deps tree
# so they resolve zod (and anything else) without a separate install.
RUN ln -s /opt/yoplai/node_modules /eval/node_modules

RUN chown -R agent:agent /eval /logs /app

USER agent
WORKDIR /app
