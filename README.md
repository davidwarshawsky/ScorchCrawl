# ScorchCrawl

**Open-source, Copilot SDK-compliant MCP server for web scraping with stealth bot-detection bypass.**

ScorchCrawl gives GitHub Copilot (and any MCP-compatible client) the ability to scrape, search, crawl, map, and extract data from the web — including sites with aggressive anti-bot protections. It runs as a self-hosted Docker stack with a single `docker compose up -d`.

> **Based on [Firecrawl](https://github.com/mendableai/firecrawl) (AGPL-3.0).** This project is NOT affiliated with, endorsed by, or sponsored by Firecrawl or Mendable/Sideguide Technologies Inc. See [LICENSE](LICENSE) for details.

## Features

- **MCP Protocol** — Full [Model Context Protocol](https://modelcontextprotocol.io/) compliance via Streamable HTTP transport
- **GitHub Copilot SDK** — Native Copilot agent engine for autonomous web research
- **Stealth Mode** — Playwright + Browserless with stealth plugins to bypass bot detection
- **Self-Contained** — One `docker compose up -d` deploys everything: API, workers, browser pool, Redis, RabbitMQ, PostgreSQL
- **Local Proxy Mode** — Optionally route scraping through the client's residential IP
- **Rate Limiting** — Application-level concurrency, sliding-window, and quota monitoring
- **Reverse Proxy Ready** — Optional nginx config for exposing behind HTTPS with API key auth

## Architecture

```
┌────────────────────────────────────────────────────┐
│  Client (VS Code / Copilot / MCP Client)           │
│  └─ scorchcrawl-mcp (npm package)                  │
└──────────────────┬─────────────────────────────────┘
                   │ MCP over Streamable HTTP
                   ▼
┌────────────────────────────────────────────────────┐
│  ScorchCrawl MCP Server (port 3000)                │
│  ├─ Copilot SDK Agent Engine                       │
│  ├─ Rate Limiter & Quota Monitor                   │
│  └─ Tool Registry                                  │
└──────────────────┬─────────────────────────────────┘
                   │ Internal HTTP
                   ▼
┌────────────────────────────────────────────────────┐
│  ScorchCrawl API (port 3002)                       │
│  ├─ Scrape / Search / Crawl / Map / Extract        │
│  ├─ Worker Queue (RabbitMQ)                        │
│  ├─ Playwright Stealth Service                     │
│  └─ Browserless Chrome Pool                        │
├────────────────────────────────────────────────────┤
│  Redis │ RabbitMQ │ PostgreSQL                     │
└────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Clone & Configure

```bash
git clone https://github.com/user/scorchcrawl.git
cd scorchcrawl
cp .env.example .env
```

Edit `.env` with your settings:

```env
# REQUIRED: Your GitHub Personal Access Token (for Copilot SDK agent)
GITHUB_TOKEN=ghp_your_token_here

# OPTIONAL: Allow clients to use your server as a reverse proxy
ENABLE_REVERSE_PROXY=false

# OPTIONAL: Bind to all interfaces (for remote access)
# MCP_HOST=0.0.0.0
```

### 2. Deploy with Docker Compose

```bash
docker compose up -d
```

That's it. The full stack starts:

| Service | Port | Description |
|---------|------|-------------|
| `scorchcrawl-mcp` | `127.0.0.1:24787` | MCP server (connect your client here) |
| `scorchcrawl-api` | `127.0.0.1:24786` | Scraping API |
| `playwright` | internal | Stealth browser service |
| `browserless` | internal | Chrome browser pool |
| `redis` | internal | Cache & queue backend |
| `rabbitmq` | internal | Message broker |
| `postgres` | internal | Job & metadata storage |

Check status:

```bash
docker compose ps
docker compose logs -f scorchcrawl-mcp
```

### 3. Run with Docker (standalone container)

If you only want to run the MCP server (and provide your own scraping API):

```bash
docker build -t scorchcrawl-mcp ./server

docker run -d \
  --name scorchcrawl-mcp \
  -p 127.0.0.1:24787:3000 \
  -e HTTP_STREAMABLE_SERVER=true \
  -e SCORCHCRAWL_API_URL=http://your-scraping-api:3002 \
  -e GITHUB_TOKEN=ghp_your_token_here \
  scorchcrawl-mcp
```

### 4. Configure Your MCP Client

#### VS Code (settings.json)

For a **local** ScorchCrawl server:

```json
{
  "mcp": {
    "servers": {
      "scorchcrawl": {
        "type": "http",
        "url": "http://localhost:24787/mcp"
      }
    }
  }
}
```

For a **remote** server behind nginx with API key auth:

```json
{
  "mcp": {
    "servers": {
      "scorchcrawl": {
        "type": "http",
        "url": "https://your-server.com/mcp-api/scorchcrawl/{YOUR_API_KEY}/mcp"
      }
    }
  }
}
```

#### Claude Desktop (claude_desktop_config.json)

```json
{
  "mcpServers": {
    "scorchcrawl": {
      "command": "npx",
      "args": ["scorchcrawl-mcp"],
      "env": {
        "SCORCHCRAWL_URL": "http://localhost:24787"
      }
    }
  }
}
```

#### Copilot CLI / Other MCP Clients

Install the `scorchcrawl-mcp` client package:

```bash
npm install -g scorchcrawl-mcp
```

Then run:

```bash
SCORCHCRAWL_URL=http://localhost:24787 scorchcrawl-mcp
```

This bridges stdio to HTTP so any MCP client that speaks stdio can connect to a remote ScorchCrawl server.

## Getting a GitHub Token for Copilot

The agent engine uses the GitHub Copilot SDK, which requires a GitHub Personal Access Token (PAT).

### Option 1: Use your existing Copilot subscription

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scopes: `copilot` (required)
4. Copy the token into your `.env` as `GITHUB_TOKEN`

### Option 2: Use a GitHub App token

If you're deploying for a team/org:

1. Create a GitHub App at [github.com/settings/apps](https://github.com/settings/apps)
2. Grant the `copilot` permission
3. Install the app and generate an installation token
4. Set `GITHUB_TOKEN` to the installation token

### Option 3: Per-user tokens (recommended for shared servers)

Each user can pass their own token via the `x-copilot-token` or `x-github-token` header. The server falls back to `GITHUB_TOKEN` if no per-user token is provided.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub PAT with `copilot` scope (required for agent) |
| `ENABLE_REVERSE_PROXY` | `false` | Allow remote clients to connect |
| `MCP_PORT` | `24787` | MCP server port |
| `MCP_HOST` | `127.0.0.1` | MCP bind address (`0.0.0.0` for remote) |
| `SCORCHCRAWL_PORT` | `24786` | Scraping API port |
| `SCORCHCRAWL_HOST` | `127.0.0.1` | Scraping API bind address |
| `COPILOT_AGENT_MODELS` | `gpt-4.1,gpt-4o,gpt-5-mini` | Allowed models for the agent |
| `COPILOT_AGENT_DEFAULT_MODEL` | `gpt-4.1` | Default agent model |
| `RATE_LIMIT_MAX_GLOBAL_CONCURRENCY` | `10` | Max concurrent agent jobs |
| `RATE_LIMIT_MAX_PER_USER_CONCURRENCY` | `3` | Max concurrent agent jobs per user |
| `NUM_WORKERS_PER_QUEUE` | `16` | Scraping worker parallelism |
| `MAX_CONCURRENT_JOBS` | `10` | Max concurrent crawl jobs |
| `BROWSER_POOL_SIZE` | `10` | Chrome browser instances |

### Reverse Proxy Mode

When `ENABLE_REVERSE_PROXY=true`, the server binds to `0.0.0.0` and accepts connections from any client. Use this with an nginx reverse proxy for HTTPS + API key authentication.

See [docs/reverse-proxy.md](docs/reverse-proxy.md) for a full nginx configuration example.

### Local Proxy Mode

Set `SCORCHCRAWL_LOCAL_PROXY=true` in the client environment to route scraping through the client's residential IP instead of the server's datacenter IP.

## MCP Tools

| Tool | Description |
|------|-------------|
| `scorch_scrape` | Scrape a single URL (markdown, JSON, HTML, screenshot) |
| `scorch_search` | Web search with optional content extraction |
| `scorch_map` | Discover all URLs on a website |
| `scorch_crawl` | Crawl multiple pages from a website |
| `scorch_extract` | LLM-powered structured data extraction |
| `scorch_agent` | Autonomous web research agent (Copilot SDK) |
| `scorch_agent_status` | Check agent job status |
| `scorch_agent_models` | List available agent models |
| `scorch_agent_rate_limit_status` | Check rate limit status |
| `scorch_check_crawl_status` | Check crawl job progress |

## Development

```bash
cd server

# Install dependencies
npm install

# Build
npm run build

# Run locally (stdio mode)
npm start

# Run as HTTP server
HTTP_STREAMABLE_SERVER=true npm run start:server
```

### Testing

```bash
cd server

# Unit tests
npm test

# Watch mode
npm run test:watch

# Integration tests (requires running server)
MCP_TEST_URL=http://localhost:24787 npm run test:integration
```

See [docs/testing.md](docs/testing.md) for full details.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/how-it-works.md](docs/how-it-works.md) | **How ScorchCrawl-MCP works** — request lifecycle, architecture, tool registry, agent engine |
| [docs/configuration.md](docs/configuration.md) | **Complete configuration reference** — every env variable explained with defaults and examples |
| [docs/architecture.md](docs/architecture.md) | System architecture and service roles |
| [docs/reverse-proxy.md](docs/reverse-proxy.md) | Nginx reverse proxy with API key auth |
| [docs/testing.md](docs/testing.md) | Testing guide and CI/CD |
| [.env.example](.env.example) | All configuration variables with defaults |

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

The scraping engine (`engine/` directory) is based on [Firecrawl](https://github.com/mendableai/firecrawl) (AGPL-3.0) by Sideguide Technologies Inc. See [engine/NOTICE](engine/NOTICE) for modification details.

The MCP server layer (`server/`), client package (`client/`), and Docker orchestration are original work by ScorchCrawl Contributors, also licensed under AGPL-3.0.

**Trademark Notice:** "Firecrawl" is a trademark of Mendable/Sideguide Technologies Inc. "ScorchCrawl" is NOT affiliated with, endorsed by, or sponsored by Firecrawl or Mendable/Sideguide Technologies Inc.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. THE AUTHORS AND COPYRIGHT HOLDERS DISCLAIM ALL LIABILITY FOR ANY DAMAGES ARISING FROM THE USE OF THIS SOFTWARE. USERS ASSUME ALL RISK AND RESPONSIBILITY FOR COMPLIANCE WITH APPLICABLE LAWS AND REGULATIONS. THIS SOFTWARE MUST NOT BE USED FOR ANY ILLEGAL ACTIVITY, UNAUTHORIZED ACCESS, OR IN VIOLATION OF ANY WEBSITE'S TERMS OF SERVICE.
