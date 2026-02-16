# ScorchCrawl Configuration Reference

Complete reference for all environment variables, configuration options, and deployment settings.

## How Configuration Works

ScorchCrawl reads configuration from environment variables. There are three ways to set them:

1. **`.env` file** (recommended) — Copy `.env.example` to `.env` at the project root. Docker Compose reads this automatically.
2. **Shell environment** — `export GITHUB_TOKEN=ghp_...` before running `docker compose up`.
3. **Docker Compose override** — Set values directly in `docker-compose.override.yaml`.

The MCP server (`server/src/index.ts`) loads `.env` via `dotenv` on startup. Docker Compose passes env vars to containers via the `environment:` block in `docker-compose.yaml`.

---

## Required Variables

### `GITHUB_TOKEN`

| | |
|---|---|
| **Required** | Yes (for agent features) |
| **Default** | — |
| **Example** | `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

A GitHub Personal Access Token with the `copilot` scope. Required for the Copilot SDK agent engine (`scorch_agent` tool). Without it, the 7 non-agent tools still work, but `scorch_agent`, `scorch_agent_status`, and `scorch_agent_models` will fail.

**How to get one:**
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scope: **`copilot`**
4. Copy the token

**Per-user tokens:** Clients can send their own token via the `x-copilot-token` or `x-github-token` HTTP header. The server falls back to this env var if no per-user header is present.

### `SCORCHCRAWL_API_URL` or `SCORCHCRAWL_API_KEY`

| | |
|---|---|
| **Required** | At least one (unless `CLOUD_SERVICE=true`) |
| **Default** | — |
| **Example** | `http://scorchcrawl-api:3002` |

The MCP server needs to know where the scraping engine is:

- **`SCORCHCRAWL_API_URL`** — URL of the scraping API. In Docker Compose, this is set to `http://scorchcrawl-api:3002` automatically.
- **`SCORCHCRAWL_API_KEY`** — If using a remote/hosted scraping API that requires auth.

If neither is set, the server exits with an error on startup.

---

## Network & Ports

### `MCP_PORT`

| | |
|---|---|
| **Default** | `24787` |
| **Docker mapping** | `127.0.0.1:24787 → container:3000` |

The **external** port where the MCP server is accessible. This is the port your MCP client connects to.

Inside the container, the server always runs on port 3000 (set via `PORT=3000` in `docker-compose.yaml`). `MCP_PORT` controls the host-side mapping.

### `MCP_HOST`

| | |
|---|---|
| **Default** | `127.0.0.1` |
| **Remote access** | `0.0.0.0` |

The **bind address** for the MCP port mapping. By default, only `localhost` can connect. Set to `0.0.0.0` to allow remote connections (always use with nginx + API key auth in production).

### `SCORCHCRAWL_PORT`

| | |
|---|---|
| **Default** | `24786` |
| **Docker mapping** | `127.0.0.1:24786 → container:3002` |

The external port for direct access to the scraping API (bypassing the MCP layer). Useful for debugging or direct API calls.

### `SCORCHCRAWL_HOST`

| | |
|---|---|
| **Default** | `127.0.0.1` |

Bind address for the scraping API port. Same semantics as `MCP_HOST`.

### `INTERNAL_PORT`

| | |
|---|---|
| **Default** | `3002` |

Internal port the scraping engine listens on inside its container. Rarely needs changing.

---

## Copilot Agent Configuration

### `COPILOT_AGENT_MODELS`

| | |
|---|---|
| **Default** | `gpt-4.1,gpt-4o,gpt-5-mini` |
| **Format** | Comma-separated model names |

Which LLM models the `scorch_agent` tool can use. When a client calls `scorch_agent` with a `model` parameter, it must be one of these. The `scorch_agent_models` tool returns this list to clients.

### `COPILOT_AGENT_DEFAULT_MODEL`

| | |
|---|---|
| **Default** | First item from `COPILOT_AGENT_MODELS` (usually `gpt-4.1`) |

Which model is used when the client doesn't specify one in the `scorch_agent` call.

---

## Rate Limiting

The MCP server has three rate limiting layers that work together:

### `RATE_LIMIT_MAX_GLOBAL_CONCURRENCY`

| | |
|---|---|
| **Default** | `10` |

Maximum number of agent jobs running simultaneously across all users. When reached, new `scorch_agent` requests are rejected with a "system at maximum capacity" message.

### `RATE_LIMIT_MAX_PER_USER_CONCURRENCY`

| | |
|---|---|
| **Default** | `3` |

Maximum concurrent agent jobs per user (identified by their Copilot token). Prevents one user from monopolizing the system.

### Rate Window Settings (advanced)

These are configured in `server/src/rate-limiter.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `rateLimitWindowMs` | `60000` (1 min) | Sliding window duration |
| `maxRequestsPerWindow` | `20` | Max requests per user per window |
| `maxGlobalRequestsPerWindow` | `100` | Max global requests per window |
| `quotaRejectThresholdPercent` | `5` | Reject when user quota drops below this % |
| `staleJobTimeoutMs` | `300000` (5 min) | Mark jobs as stale after this duration |
| `gcIntervalMs` | `60000` (1 min) | Garbage collection interval |

---

## Scraping Engine Configuration

### `NUM_WORKERS_PER_QUEUE`

| | |
|---|---|
| **Default** | `16` |

Number of parallel workers processing scrape/crawl jobs from the RabbitMQ queue. Higher = more throughput, more memory.

### `MAX_CONCURRENT_JOBS`

| | |
|---|---|
| **Default** | `10` |

Maximum concurrent crawl jobs. Each crawl job can spawn many individual scrape tasks.

### `CRAWL_CONCURRENT_REQUESTS`

| | |
|---|---|
| **Default** | `20` |

How many pages a single crawl job fetches in parallel.

### `BROWSER_POOL_SIZE`

| | |
|---|---|
| **Default** | `10` |

Number of Chrome browser instances in the Browserless pool. Each instance can handle one page at a time.

### `SCRAPE_MAX_ATTEMPTS`

| | |
|---|---|
| **Default** | `6` |

How many times to retry a failed scrape before giving up. Includes fallback strategies (e.g., switching from Playwright to Browserless).

### Anti-Bot / Stealth Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_MICROSERVICE_URL` | `http://playwright:3000/scrape` | Stealth browser service endpoint |
| `BLOCK_MEDIA` | (empty) | Block images/video to speed up scraping |
| `MAX_CONCURRENT_PAGES` | `20` | Max pages Playwright handles at once |

---

## Proxy / Residential IP

### `PROXY_SERVER`

| | |
|---|---|
| **Default** | (empty — no proxy) |
| **Example** | `http://proxy.example.com:8080` |

HTTP proxy for outbound scraping requests. Use a residential proxy to avoid datacenter IP blocks.

### `PROXY_USERNAME` / `PROXY_PASSWORD`

Credentials for the proxy server, if required.

### Local Proxy Mode

Set `SCORCHCRAWL_LOCAL_PROXY=true` on the **client** side to route scraping through the client's own IP instead of the server's. The MCP server's `local-scraper.ts` handles this by fetching pages from the client machine and forwarding them.

---

## Data Stores

All managed automatically by Docker Compose. Only change these if using external services.

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password |
| `POSTGRES_DB` | `postgres` | Database name |
| `POSTGRES_HOST` | `postgres` | Database hostname |
| `POSTGRES_PORT` | `5432` | Database port |

---

## Optional Integrations

### LLM (for `scorch_extract`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (empty) | OpenAI API key for LLM extraction |
| `OPENAI_BASE_URL` | (empty) | Custom OpenAI-compatible endpoint |
| `MODEL_NAME` | (empty) | Model for extraction (e.g., `gpt-4o`) |

### SearxNG

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_ENDPOINT` | (empty) | SearxNG URL for `scorch_search` fallback |

---

## Authentication

### `USE_DB_AUTHENTICATION`

| | |
|---|---|
| **Default** | `false` |

When `true`, the scraping API requires per-user API keys stored in PostgreSQL. When `false` (self-hosted default), all requests are accepted.

### `BULL_AUTH_KEY`

| | |
|---|---|
| **Default** | `scorchcrawl-admin` |

Admin key for accessing the Bull queue dashboard (if exposed).

### `CLOUD_SERVICE`

| | |
|---|---|
| **Default** | `false` |

Internal flag. When `true`, the MCP server requires every request to include an API key via `Authorization: Bearer <key>` or `x-api-key` header.

---

## Server Runtime

### `HTTP_STREAMABLE_SERVER`

| | |
|---|---|
| **Default** | `false` |

When `true`, the server starts as an HTTP Streamable MCP server (stateless JSON-RPC 2.0 over HTTP). When `false`, it runs in stdio mode (for Claude Desktop, direct CLI use).

In Docker Compose, this is always set to `true`.

### `PORT` / `HOST`

| | |
|---|---|
| **Default** | `3000` / `0.0.0.0` (inside container) |

The port and bind address the Node.js process listens on inside the container. These are set in `docker-compose.yaml` — don't change them unless you also update the Dockerfile.

### `LOGGING_LEVEL`

| | |
|---|---|
| **Default** | `info` |
| **Options** | `debug`, `info`, `warn`, `error` |

Controls log verbosity for both the MCP server and the scraping engine.

### `ENABLE_REVERSE_PROXY`

| | |
|---|---|
| **Default** | `false` |

Documentation flag. When `true`, indicates the server is behind an nginx reverse proxy. This doesn't change server behavior directly — it's used by `setup.sh` to configure nginx.

---

## Quick Reference Table

| Variable | Default | Category |
|----------|---------|----------|
| `GITHUB_TOKEN` | — | **Required** |
| `SCORCHCRAWL_API_URL` | — | **Required** |
| `MCP_PORT` | `24787` | Network |
| `MCP_HOST` | `127.0.0.1` | Network |
| `SCORCHCRAWL_PORT` | `24786` | Network |
| `COPILOT_AGENT_MODELS` | `gpt-4.1,gpt-4o,gpt-5-mini` | Agent |
| `COPILOT_AGENT_DEFAULT_MODEL` | `gpt-4.1` | Agent |
| `RATE_LIMIT_MAX_GLOBAL_CONCURRENCY` | `10` | Rate Limit |
| `RATE_LIMIT_MAX_PER_USER_CONCURRENCY` | `3` | Rate Limit |
| `NUM_WORKERS_PER_QUEUE` | `16` | Scraping |
| `MAX_CONCURRENT_JOBS` | `10` | Scraping |
| `BROWSER_POOL_SIZE` | `10` | Scraping |
| `PROXY_SERVER` | (empty) | Proxy |
| `OPENAI_API_KEY` | (empty) | LLM |
| `USE_DB_AUTHENTICATION` | `false` | Auth |
| `HTTP_STREAMABLE_SERVER` | `false` | Runtime |
| `LOGGING_LEVEL` | `info` | Runtime |
