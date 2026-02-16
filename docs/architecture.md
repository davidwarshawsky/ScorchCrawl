# ScorchCrawl Architecture

## High-Level Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        MCP Clients                               │
│  (VS Code Copilot, Claude Desktop, CLI, custom HTTP clients)     │
└───────────────────────────┬──────────────────────────────────────┘
                            │  JSON-RPC 2.0 over HTTP Streamable / stdio
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                  scorchcrawl-mcp (server/)                       │
│                                                                  │
│  ┌────────────┐ ┌──────────────┐ ┌──────────────────────────┐   │
│  │ Tool       │ │ Copilot SDK  │ │ Rate Limiter             │   │
│  │ Registry   │ │ Agent Engine │ │ (concurrency + quota +   │   │
│  │            │ │              │ │  sliding window)          │   │
│  │ scorch_*   │ │ startAgent() │ │                          │   │
│  │ 10 tools   │ │ getStatus()  │ │  RateLimitGuard          │   │
│  └────────────┘ └──────────────┘ └──────────────────────────┘   │
│                                                                  │
│  ┌────────────────────────┐  ┌───────────────────────────────┐  │
│  │ Local Proxy Mode       │  │ HTTP Streamable Transport     │  │
│  │ (scrape through        │  │ (stateless JSON-RPC 2.0)     │  │
│  │  user's IP)            │  │                               │  │
│  └────────────────────────┘  └───────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                scorchcrawl-api (engine/)                         │
│                                                                  │
│  Scraping engine based on Firecrawl (AGPL-3.0)                  │
│                                                                  │
│  ┌───────────┐ ┌───────────┐ ┌────────┐ ┌────────┐             │
│  │ Scrape    │ │ Crawl     │ │ Map    │ │ Extract│             │
│  │ Workers   │ │ Workers   │ │ Engine │ │ (LLM)  │             │
│  └─────┬─────┘ └─────┬─────┘ └────────┘ └────────┘             │
│        │              │                                          │
│        ▼              ▼                                          │
│  ┌────────────────────────┐                                     │
│  │ Queue Manager          │                                     │
│  │ (RabbitMQ + Redis)     │                                     │
│  └────────────────────────┘                                     │
└───────────────────────────┬──────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Playwright│ │Browserless│ │ Redis    │
        │ (stealth │ │ (Chrome  │ │ + Rabbit │
        │ browser) │ │  pool)   │ │ + PG     │
        └──────────┘ └──────────┘ └──────────┘
```

## Service Roles

| Service | Purpose | Port |
|---------|---------|------|
| `scorchcrawl-mcp` | MCP server — Copilot SDK agent, tool registry, rate limiting | 24787 |
| `scorchcrawl-api` | Scraping engine — HTTP API, workers, queue management | 24786 (internal) |
| `playwright` | Stealth browser with anti-detection patches | Internal only |
| `browserless` | Chrome browser pool for parallel scraping | Internal only |
| `redis` | Cache, queue backend, rate limit counters | Internal only |
| `rabbitmq` | Message broker for async job processing | Internal only |
| `postgres` | Job metadata and crawl state persistence | Internal only |

## MCP Tools

The server exposes 10 tools via the MCP protocol:

| Tool | Description |
|------|-------------|
| `scorch_scrape` | Single-page content extraction (markdown, JSON, branding) |
| `scorch_map` | Discover all URLs on a website |
| `scorch_search` | Web search with optional content extraction |
| `scorch_crawl` | Multi-page crawl with depth/limit control |
| `scorch_check_crawl_status` | Poll crawl job progress |
| `scorch_extract` | LLM-powered structured data extraction |
| `scorch_agent` | Copilot SDK autonomous research agent |
| `scorch_agent_status` | Poll agent job progress |
| `scorch_agent_models` | List available agent models |
| `scorch_agent_rate_limit_status` | Rate limit observability |

## Rate Limiting Layers

1. **Copilot SDK built-in**: 429 retries, exponential backoff, `retry-after` headers
2. **Application-level** (this package):
   - Global + per-user concurrency tracking
   - Sliding-window request rate limiter
   - Proactive quota monitoring (rejects before exhaustion)
   - Stale job garbage collection

## Anti-Bot Detection

The stealth layer is provided by the engine (Playwright service + browserless):

- Stealth browser fingerprinting
- Human-like scrolling and timing
- Proxy rotation support (residential IPs optional)
- TLS fingerprint randomization
- Cookie and session persistence

## Deployment Modes

### 1. Local Development (stdio)
```bash
cd server && npm run build && node dist/index.js
```

### 2. Docker Compose (recommended)
```bash
cp .env.example .env   # fill in GITHUB_TOKEN
docker compose up -d
```

### 3. With Reverse Proxy (production)
See [reverse-proxy.md](reverse-proxy.md) for Nginx configuration that:
- Provides API key authentication
- Routes `/mcp-api/scorchcrawl/{API_KEY}/mcp` to the MCP server
- Avoids the need for residential IPs by routing through your server's IP
