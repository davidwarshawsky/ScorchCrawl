# ScorchCrawl

**Turn websites into LLM-ready data — self-hosted, with stealth bot-detection bypass.**

[ScorchCrawl](https://github.com/user/scorchcrawl) is an MCP server that scrapes, crawls, searches, maps, and extracts structured data from any website — including sites with aggressive anti-bot protections. It powers GitHub Copilot and any MCP-compatible client with real-time web context.

> **Based on [Firecrawl](https://github.com/mendableai/firecrawl) (AGPL-3.0).** This project is NOT affiliated with, endorsed by, or sponsored by Firecrawl or Mendable/Sideguide Technologies Inc. See [LICENSE](LICENSE) for details.

---

## Why ScorchCrawl?

- **LLM-ready output** — Clean markdown, structured JSON, screenshots, HTML, and more
- **MCP native** — Full [Model Context Protocol](https://modelcontextprotocol.io/) compliance; works with VS Code Copilot, Claude Desktop, and any MCP client
- **Stealth mode** — Playwright + Browserless with stealth plugins to bypass bot detection
- **Copilot SDK agent** — Optional autonomous web research agent powered by GitHub Copilot SDK
- **Self-hosted** — One `docker compose up -d` deploys everything on your own infrastructure
- **Local proxy** — Route scraping through your residential IP instead of the server's datacenter IP
- **Reverse proxy ready** — Optional nginx config for HTTPS + API key auth

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `scorch_scrape` | Scrape a single URL (markdown, JSON, HTML, screenshot, branding) |
| `scorch_search` | Search the web and get full page content from results |
| `scorch_crawl` | Crawl multiple pages from a website |
| `scorch_map` | Discover all URLs on a website instantly |
| `scorch_extract` | LLM-powered structured data extraction |
| `scorch_agent` | Autonomous web research agent (Copilot SDK) — *requires `GITHUB_TOKEN`* |
| `scorch_agent_status` | Check agent job status |
| `scorch_agent_models` | List available agent models |
| `scorch_agent_rate_limit_status` | Check rate limit status |
| `scorch_check_crawl_status` | Check crawl job progress |

---

## Self-Hosting

### Prerequisites

- Docker ([install](https://docs.docker.com/get-docker/))

### 1. Set Environment Variables

Clone the repo and create your `.env`:

```bash
git clone https://github.com/user/scorchcrawl.git
cd scorchcrawl
cp .env.example .env
```

`.env`:
```env
# ===== Optional ENVs ======

# GitHub PAT with `copilot` scope — enables the scorch_agent tool.
# If omitted, the 7 core tools still work; only the agent tools are disabled.
# GITHUB_TOKEN=ghp_your_token_here

# ===== Network =====

# Bind to localhost only (default). Set to 0.0.0.0 for remote access.
# MCP_HOST=127.0.0.1
# SCORCHCRAWL_HOST=127.0.0.1

# ===== Proxy / LLM =====

# PROXY_SERVER=http://proxy.example.com:8080
# PROXY_USERNAME=
# PROXY_PASSWORD=

# OpenAI-compatible API for scorch_extract JSON extraction
# OPENAI_API_KEY=
# OPENAI_BASE_URL=
# MODEL_NAME=
```

### 2. Build and Run

```bash
docker compose build
docker compose up -d
```

This runs a local instance of ScorchCrawl. The scraping API is available at `http://localhost:24786`.

| Service | Port | Description |
|---------|------|-------------|
| `scorchcrawl-api` | `127.0.0.1:24786` | Scraping API |
| `playwright` | internal | Stealth browser service |
| `browserless` | internal | Chrome browser pool |
| `redis` | internal | Cache & queue backend |
| `rabbitmq` | internal | Message broker |
| `postgres` | internal | Job & metadata storage |

Check status:

```bash
docker compose ps
docker compose logs -f scorchcrawl-api
```

### 3. *(Optional)* Test the API

```bash
curl -X POST http://localhost:24786/v1/scrape \
    -H 'Content-Type: application/json' \
    -d '{"url": "https://example.com"}'
```

---

## Connect Your MCP Client

There are two ways to connect VS Code (or any MCP client) to ScorchCrawl. The choice determines what you can configure per-client:

| | **SSE** (`"type": "http"`) | **stdio** (`"type": "stdio"`) |
|---|---|---|
| How it works | VS Code connects directly to the scraping API over HTTP | You run the MCP server locally as a Node.js process; it connects to the scraping API |
| Setup | Just a URL — nothing to install | Clone the repo, run `npm install && npm run build` in `server/` |
| `GITHUB_TOKEN` | Set on the **server** (`.env`); **cannot** be overridden per-client | Set in the client's `env` block; **your own** token, used directly |
| `SCORCHCRAWL_LOCAL_PROXY` | **Not available** — scraping always uses the server's IP | Set in the client's `env` block; routes scraping through your local IP |
| Custom TLS certs | Not available | Set `NODE_EXTRA_CA_CERTS` in the client's `env` block |
| Reverse proxy | Not configurable from per-client — server decides | Configure `SCORCHCRAWL_API_URL` to point at the proxy endpoint |

> **TL;DR:** SSE is the easiest setup — just a URL. stdio gives you full per-client control over your GitHub token, local proxy, and TLS certs.

---

### SSE — Simple Connection

Point your client at the scraping API. No per-client configuration of `GITHUB_TOKEN` or proxy — those are set on the server.

#### Local scraping engine (Docker on your machine)

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

#### Remote scraping engine (Docker on a server)

If the server is behind nginx with HTTPS + API key auth (see [docs/reverse-proxy.md](docs/reverse-proxy.md)):

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

---

### stdio — Full Control

Run the MCP server locally as a Node.js process. You can set your own `GITHUB_TOKEN`, enable local proxy, and configure custom TLS certs.

#### Build the MCP server

```bash
cd server
npm install
npm run build
```

#### Local scraping engine (Docker on your machine)

```json
{
  "mcp": {
    "servers": {
      "scorchcrawl": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/scorchcrawl/server/dist/index.js"],
        "env": {
          "SCORCHCRAWL_API_URL": "http://localhost:24786",
          "SCORCHCRAWL_API_KEY": "local-dummy-key",
          "GITHUB_TOKEN": "ghp_your_own_token_here",
          "SCORCHCRAWL_LOCAL_PROXY": "true"
        }
      }
    }
  }
}
```

#### Remote scraping engine (Docker on a server, behind reverse proxy)

```json
{
  "mcp": {
    "servers": {
      "scorchcrawl": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/scorchcrawl/server/dist/index.js"],
        "env": {
          "SCORCHCRAWL_API_URL": "https://your-server.com/mcp-api/scorchcrawl/YOUR_API_KEY",
          "SCORCHCRAWL_API_KEY": "local-dummy-key",
          "SCORCHCRAWL_LOCAL_PROXY": "true",
          "GITHUB_TOKEN": "ghp_your_own_token_here",
          "NODE_EXTRA_CA_CERTS": "/path/to/custom-certs.pem"
        },
        "startupTimeout": 300000
      }
    }
  }
}
```

#### Claude Desktop (stdio only)

```json
{
  "mcpServers": {
    "scorchcrawl": {
      "command": "node",
      "args": ["/path/to/scorchcrawl/server/dist/index.js"],
      "env": {
        "SCORCHCRAWL_API_URL": "http://localhost:24786",
        "SCORCHCRAWL_API_KEY": "local-dummy-key",
        "GITHUB_TOKEN": "ghp_your_own_token_here"
      }
    }
  }
}
```

#### Client Environment Variables

| Variable | Description |
|----------|-------------|
| `SCORCHCRAWL_API_URL` | URL of the scraping API — `http://localhost:24786` for local, or the remote proxy URL |
| `SCORCHCRAWL_API_KEY` | API key for the scraping engine. Use `local-dummy-key` if auth is in the URL or disabled. |
| `GITHUB_TOKEN` | Your GitHub PAT with `copilot` scope. Used directly by the agent engine running on your machine. |
| `SCORCHCRAWL_LOCAL_PROXY` | Set to `true` to route scraping through your local IP instead of the server's. |
| `NODE_EXTRA_CA_CERTS` | Path to custom CA certificates (corporate proxies, self-signed certs). |

---

## GitHub Token (Copilot SDK Agent)

The `GITHUB_TOKEN` is **optional**. It enables the Copilot SDK agent engine — an autonomous research agent that can chain multiple scrape/search/extract calls.

| With `GITHUB_TOKEN` | Without `GITHUB_TOKEN` |
|---------------------|------------------------|
| All 10 tools available | 7 core tools work fine |
| `scorch_agent` ✅ | `scorch_agent` ❌ |
| `scorch_agent_status` ✅ | `scorch_agent_status` ❌ |
| `scorch_agent_models` ✅ | `scorch_agent_models` ❌ |

**How to get one:**

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scope: **`copilot`**
4. Copy the token

**Where to set it:**

- **SSE mode:** Set `GITHUB_TOKEN` in the server's `.env` file. All SSE clients share this token.
- **stdio mode:** Set `GITHUB_TOKEN` in the client's `env` block. Each user has their own token.

For team deployments: create a [GitHub App](https://github.com/settings/apps) with the `copilot` permission and use installation tokens.

---

## Reverse Proxy

For remote deployments, use nginx with HTTPS + API key auth to secure access.

1. Set `ENABLE_REVERSE_PROXY=true` and `MCP_HOST=0.0.0.0` in the server's `.env`
2. Configure nginx — see [docs/reverse-proxy.md](docs/reverse-proxy.md) for a complete example
3. Clients connect through the proxy URL (with API key in the path)

If `ENABLE_REVERSE_PROXY=false` (default), the server binds to `127.0.0.1` only.

---

## Configuration

### Server Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub PAT with `copilot` scope (agent tools) |
| `ENABLE_REVERSE_PROXY` | `false` | Accept external connections behind nginx |
| `MCP_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `MCP_PORT` | `24787` | MCP server external port |
| `SCORCHCRAWL_HOST` | `127.0.0.1` | Scraping API bind address |
| `SCORCHCRAWL_PORT` | `24786` | Scraping API external port |
| `COPILOT_AGENT_MODELS` | `gpt-4.1,gpt-4o,gpt-5-mini` | Allowed agent models |
| `COPILOT_AGENT_DEFAULT_MODEL` | `gpt-4.1` | Default agent model |
| `NUM_WORKERS_PER_QUEUE` | `16` | Scraping worker parallelism |
| `MAX_CONCURRENT_JOBS` | `10` | Max concurrent crawl jobs |
| `BROWSER_POOL_SIZE` | `10` | Chrome browser instances |
| `PROXY_SERVER` | — | HTTP proxy for outbound scraping |
| `OPENAI_API_KEY` | — | OpenAI key for `scorch_extract` |

See [docs/configuration.md](docs/configuration.md) for the complete reference.

---

## Development

```bash
cd server
npm install
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

See [docs/testing.md](docs/testing.md) for details.

---

## Troubleshooting

### Docker containers fail to start

Check logs:
```bash
docker compose logs scorchcrawl-api
```
Ensure all required environment variables are set in `.env` and that Docker services are healthy.

### Connection issues with Redis

Verify Redis is running:
```bash
docker compose ps redis
```
Check that `REDIS_URL` in `.env` matches the Docker Compose configuration (`redis://redis:6379`).

### Agent tools not working

The `scorch_agent` tools require a valid `GITHUB_TOKEN` with the `copilot` scope. Verify your token at [github.com/settings/tokens](https://github.com/settings/tokens).

### Custom TLS certificates (corporate networks)

If you're behind a corporate proxy with TLS inspection, set `NODE_EXTRA_CA_CERTS` in your stdio client config to point at your CA bundle.

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/how-it-works.md](docs/how-it-works.md) | Request lifecycle, architecture, tool registry, agent engine |
| [docs/configuration.md](docs/configuration.md) | Complete configuration reference |
| [docs/architecture.md](docs/architecture.md) | System architecture and service roles |
| [docs/reverse-proxy.md](docs/reverse-proxy.md) | Nginx reverse proxy with API key auth |
| [docs/testing.md](docs/testing.md) | Testing guide and CI/CD |

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

The scraping engine (`engine/` directory) is based on [Firecrawl](https://github.com/mendableai/firecrawl) (AGPL-3.0) by Sideguide Technologies Inc. See [engine/NOTICE](engine/NOTICE) for modification details.

The MCP server layer (`server/`), client package (`client/`), and Docker orchestration are original work by ScorchCrawl Contributors, also licensed under AGPL-3.0.

**Trademark Notice:** "Firecrawl" is a trademark of Mendable/Sideguide Technologies Inc. "ScorchCrawl" is NOT affiliated with, endorsed by, or sponsored by Firecrawl or Mendable/Sideguide Technologies Inc.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. THE AUTHORS AND COPYRIGHT HOLDERS DISCLAIM ALL LIABILITY FOR ANY DAMAGES ARISING FROM THE USE OF THIS SOFTWARE. USERS ASSUME ALL RISK AND RESPONSIBILITY FOR COMPLIANCE WITH APPLICABLE LAWS AND REGULATIONS. THIS SOFTWARE MUST NOT BE USED FOR ANY ILLEGAL ACTIVITY, UNAUTHORIZED ACCESS, OR IN VIOLATION OF ANY WEBSITE'S TERMS OF SERVICE.
