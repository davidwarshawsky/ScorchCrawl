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

A GitHub Personal Access Token with the `copilot` scope. Required for the Copilot SDK agent engine (`scorch_agent` tool). Without it, the 7 non-agent tools still work, but `scorch_agent` and `scorch_agent_models` will fail.

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

## Response Processing

ScorchCrawl automatically processes all tool responses through three layers: error mapping, content truncation, and AI summarization. These are implemented in `server/src/response-utils.ts`.

### Error Mapping

All tool errors are caught and classified into structured, LLM-friendly error codes with actionable suggestions. No configuration needed — this is always active.

Error codes: `ACCESS_DENIED`, `NOT_FOUND`, `RATE_LIMITED`, `SERVER_ERROR`, `TIMEOUT`, `ENGINE_UNAVAILABLE`, `CONNECTION_FAILED`, `TLS_ERROR`, `EMPTY_CONTENT`, `SPA_DETECTED`, `UNKNOWN_ERROR`.

### Content Truncation

#### `SCORCHCRAWL_MAX_CONTENT_CHARS`

| | |
|---|---|
| **Default** | `25000` |

Maximum characters allowed in a tool response. When exceeded, content is truncated at the nearest paragraph, heading, or sentence boundary, and a truncation notice is appended. Metadata, links, and structured data are never truncated. Set to `0` to disable truncation.

### AI Summarization

When enabled, long content is summarized by the Copilot SDK before truncation is applied, preserving factual data while reducing token usage.

#### `SCORCHCRAWL_SUMMARIZE_AFTER_WORDS`

| | |
|---|---|
| **Default** | `5000` |

Word count threshold above which AI summarization is attempted. Content with fewer words is left unchanged. Set to `0` to disable summarization entirely.

#### `SCORCHCRAWL_SUMMARIZE_MODEL`

| | |
|---|---|
| **Default** | `gpt-4o` |

LLM model used for summarization via the Copilot SDK.

#### `SCORCHCRAWL_SUMMARIZE_CACHE_SIZE`

| | |
|---|---|
| **Default** | `100` |

Maximum number of summarization results cached in memory (LRU cache, 30-minute TTL). Prevents re-summarizing the same page content.

#### `SCORCHCRAWL_SUMMARIZE_MAX_PER_MINUTE`

| | |
|---|---|
| **Default** | `10` |

Maximum summarization API calls per minute (sliding window). When reached, content falls back to truncation instead of summarization.

#### `SCORCHCRAWL_SUMMARIZE_TIMEOUT_MS`

| | |
|---|---|
| **Default** | `300000` |

Maximum time (in milliseconds) to wait for the Copilot SDK summarization session to become idle. Increase this if large pages routinely time out.

---

## Scraping Engine Configuration

### `NUM_WORKERS_PER_QUEUE`

| | |
|---|---|
| **Default** | `5` |

Number of parallel workers processing scrape/crawl jobs from the RabbitMQ queue. Higher = more throughput, more memory.

### `MAX_CONCURRENT_JOBS`

| | |
|---|---|
| **Default** | `3` |

Maximum concurrent crawl jobs. Each crawl job can spawn many individual scrape tasks.

### `CRAWL_CONCURRENT_REQUESTS`

| | |
|---|---|
| **Default** | `3` |

How many pages a single crawl job fetches in parallel. In the Docker stack this also feeds the Playwright service's `MAX_CONCURRENT_PAGES` limit, so raising it increases browser memory pressure quickly.

### `BROWSER_POOL_SIZE`

| | |
|---|---|
| **Default** | `3` |

Number of Chrome browser sessions allowed in the Browserless pool. Higher values improve throughput only if the host still has free RAM and CPU; otherwise latency and crash risk increase.

### `SCRAPE_MAX_ATTEMPTS`

| | |
|---|---|
| **Default** | `3` |

How many handled retries a scrape gets before the engine gives up. This includes engine fallback and feature-discovery retries, not just identical replays of the same request.

For constrained hosts, lowering this to `3` is a sensible default. That cuts wasted browser work on clearly blocked targets and reduces queue churn. Keep it closer to `4-6` only if you care more about recovery on hostile PDF/document targets than raw throughput.

### `SCRAPE_MAX_PDF_PREFETCHES`

| | |
|---|---|
| **Default** | `1` |

How many anti-bot recovery attempts the engine makes for blocked PDF downloads before failing the scrape.

### `SCRAPE_MAX_DOCUMENT_PREFETCHES`

| | |
|---|---|
| **Default** | `1` |

How many anti-bot recovery attempts the engine makes for blocked document downloads such as DOCX/XLSX before failing the scrape.

### `SCRAPE_MAX_FEATURE_TOGGLES`

| | |
|---|---|
| **Default** | `2` |

How many times the engine may retry after discovering it needs extra scrape capabilities such as PDF/document handling or other feature flags.

### Low-RAM Tuning

If the machine only has about `3-4 GB` of free RAM available for ScorchCrawl, tune for stability first and increase cautiously:

```dotenv
NUM_WORKERS_PER_QUEUE=2
MAX_CONCURRENT_JOBS=1
CRAWL_CONCURRENT_REQUESTS=2
BROWSER_POOL_SIZE=1
SCRAPE_MAX_ATTEMPTS=3
SCRAPE_MAX_PDF_PREFETCHES=1
SCRAPE_MAX_DOCUMENT_PREFETCHES=1
SCRAPE_MAX_FEATURE_TOGGLES=2
BLOCK_MEDIA=true
```

Start there, then raise only one variable at a time:

- Raise `CRAWL_CONCURRENT_REQUESTS` from `2` to `3-4` if pages are mostly lightweight and you still have headroom.
- Raise `BROWSER_POOL_SIZE` from `1` to `2` only if Browserless is the bottleneck and the host is not swapping.
- Keep `MAX_CONCURRENT_JOBS=1` on small hosts unless you are certain your crawl jobs are shallow.
- Prefer markdown or JSON formats on constrained hosts because browser-heavy workflows increase memory pressure.

### Medium-RAM Deployment Profile

If the host has roughly `6-7 GB` free when idle and you want the stack to keep accepting work, queue aggressively, and tolerate `20-30s` waits rather than fail fast, this is a reasonable starting profile:

```dotenv
NUM_WORKERS_PER_QUEUE=5
MAX_CONCURRENT_JOBS=3
CRAWL_CONCURRENT_REQUESTS=3
BROWSER_POOL_SIZE=3
SCRAPE_MAX_ATTEMPTS=3
SCRAPE_MAX_PDF_PREFETCHES=1
SCRAPE_MAX_DOCUMENT_PREFETCHES=1
SCRAPE_MAX_FEATURE_TOGGLES=2
BLOCK_MEDIA=true
```

Why this profile works better than the defaults:

- `MAX_CONCURRENT_JOBS=3` allows multiple top-level requests to stay admitted instead of rejecting work too early.
- `CRAWL_CONCURRENT_REQUESTS=3` keeps each crawl shallow enough that the browser layer can queue rather than thrash.
- `BROWSER_POOL_SIZE=3` gives Browserless a small but useful amount of parallelism.
- `NUM_WORKERS_PER_QUEUE=5` keeps the queue draining without letting too many browser-heavy tasks run at once.
- `SCRAPE_MAX_ATTEMPTS=3` avoids burning RAM and time on long retry waterfalls when a target is clearly blocked.

This is a throughput-via-queueing profile, not a low-latency profile.

### Important Limitation: Queueing Is Not Memory-Aware Yet

Today, ScorchCrawl queues work based on fixed concurrency controls, not container memory pressure.

- The scraping engine already queues jobs when crawl or team concurrency limits are reached.
- The Playwright service also has an internal semaphore queue once `MAX_CONCURRENT_PAGES` is reached.
- The MCP agent server, however, currently rejects over-limit agent jobs instead of placing them into a durable wait queue.

There is currently no built-in rule like: "when container RSS exceeds 90% of 4 GB, stop starting new work and queue everything." That would require an additional memory monitor plus admission-control hook.

### Important Limitation: `4 GB` Must Mean the Whole Browser Path

If you cap only `scorchcrawl-api` at `4 GB`, that does not cap total scraping memory usage. In the default Docker Compose stack, the heavy browser work lives in separate services:

- `scorchcrawl-api`
- `playwright`
- `browserless`

If you want a real `4 GB` operating budget, set limits with the full browser path in mind, not just the API container.

### Anti-Bot / Stealth Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_MICROSERVICE_URL` | `http://playwright:3000/scrape` | Browser-rendering service endpoint used for JavaScript-heavy and anti-bot-sensitive pages |
| `BLOCK_MEDIA` | (empty) | Block images/video to speed up scraping |
| `MAX_CONCURRENT_PAGES` | `20` | Max pages Playwright handles at once |

The current stack is harder to detect than plain `fetch` or raw HTTP clients because it uses a real browser runtime and can route through proxies, but it is not equivalent to state-of-the-art anti-detection stacks. Do not assume it is "undetectable" on Cloudflare/DataDome-class targets.

### Unsupported Formats

Screenshot requests are not part of the supported public API. Request schemas reject screenshot formats and screenshot actions.

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
| `SCORCHCRAWL_MAX_CONTENT_CHARS` | `25000` | Response |
| `SCORCHCRAWL_SUMMARIZE_AFTER_WORDS` | `5000` | Response |
| `SCORCHCRAWL_SUMMARIZE_MODEL` | `gpt-4o` | Response |
| `SCORCHCRAWL_SUMMARIZE_CACHE_SIZE` | `100` | Response |
| `SCORCHCRAWL_SUMMARIZE_MAX_PER_MINUTE` | `10` | Response |
| `SCORCHCRAWL_SUMMARIZE_TIMEOUT_MS` | `300000` | Response |
| `NUM_WORKERS_PER_QUEUE` | `16` | Scraping |
| `MAX_CONCURRENT_JOBS` | `10` | Scraping |
| `BROWSER_POOL_SIZE` | `10` | Scraping |
| `PROXY_SERVER` | (empty) | Proxy |
| `OPENAI_API_KEY` | (empty) | LLM |
| `USE_DB_AUTHENTICATION` | `false` | Auth |
| `HTTP_STREAMABLE_SERVER` | `false` | Runtime |
| `LOGGING_LEVEL` | `info` | Runtime |
