# ScorchCrawl MCP Server
#
# Uses Debian-based node:22-slim (NOT Alpine) because the bundled
# @github/copilot-linux-x64 CLI binary is dynamically linked against glibc.

# 1) Build stage (Alpine is fine here — only compiling TS)
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm run build

# 2) Runtime stage (Debian slim — glibc for copilot CLI binary)
FROM node:22-slim AS release

RUN corepack enable && corepack prepare pnpm@latest --activate

# curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# Ensure the bundled copilot CLI binary is executable
RUN chmod +x node_modules/@github/copilot-linux-x64/copilot 2>/dev/null || true

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-3000}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
