# How ScorchCrawl-MCP Works

A detailed explanation of the ScorchCrawl MCP server — what it does, how data flows through it, and how every component connects.

---

## What Is It?

ScorchCrawl-MCP is a **Model Context Protocol (MCP) server** that turns the ScorchCrawl web scraping engine into a set of tools that AI coding assistants (GitHub Copilot, Claude Desktop, etc.) can call directly.

Instead of:
```
User → AI → "Here's some code to scrape that" → User runs code manually
```

With ScorchCrawl-MCP:
```
User → AI → MCP tool call → ScorchCrawl engine → structured data → AI → response
```

The AI assistant calls ScorchCrawl tools as naturally as it calls a function. The MCP protocol handles serialization, transport, and capability negotiation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                            │
│         (VS Code Copilot, Claude Desktop, etc.)          │
└────────────────────────┬────────────────────────────────┘
                         │ JSON-RPC 2.0 over HTTP
                         │ (or stdio for local use)
                         ▼
┌─────────────────────────────────────────────────────────┐
│              ScorchCrawl MCP Server                       │
│                  (server/src/index.ts)                    │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐   │
│  │  Tool     │  │  Rate    │  │  Copilot Agent      │   │
│  │  Registry │  │  Limiter │  │  Engine              │   │
│  └──────────┘  └──────────┘  └─────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP REST calls
                         ▼
┌─────────────────────────────────────────────────────────┐
│             ScorchCrawl Scraping API                      │
│              (apps/api on port 3002)                      │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐      │
│  │  Crawl   │  │  Scrape  │  │  Extract (LLM)   │      │
│  │  Engine  │  │  Engine  │  │  Processor        │      │
│  └──────────┘  └──────────┘  └──────────────────┘      │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐  ┌───────────────┐
   │ Playwright │  │Browserless│  │  go-html-to-md │
   │ (stealth)  │  │ (Chrome)  │  │  (converter)   │
   └───────────┘  └───────────┘  └───────────────┘
```

---

## Request Lifecycle

Here's what happens when Copilot calls `scorch_scrape("https://example.com")`:

### Step 1: Client sends JSON-RPC request

The MCP client (VS Code) sends a `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "scorch_scrape",
    "arguments": {
      "url": "https://example.com",
      "formats": ["markdown"]
    }
  }
}
```

### Step 2: MCP server receives and validates

`server/src/index.ts` handles the request:

1. **Authentication** — If `CLOUD_SERVICE=true`, checks for a valid API key in headers.
2. **Session lookup** — For Streamable HTTP, identifies the session via `Mcp-Session-Id` header.
3. **Rate limiting** — Checks per-user and global concurrency limits.
4. **Tool dispatch** — Looks up `scorch_scrape` in the tool registry and calls its handler.

### Step 3: Tool handler calls the scraping API

The `scorch_scrape` handler:

1. Builds an HTTP request to `SCORCHCRAWL_API_URL/v1/scrape`
2. Sends the request with the page URL and options
3. Waits for the scraping API to return results

### Step 4: Scraping API processes the request

The scraping API (`apps/api`):

1. **Job creation** — Creates a scrape job in Redis
2. **Queue dispatch** — Puts the job on the RabbitMQ queue
3. **Worker pickup** — A worker picks up the job
4. **Browser dispatch** — The worker sends the URL to Playwright (stealth mode) or Browserless
5. **Page rendering** — The browser fetches the page, executes JavaScript, waits for rendering
6. **Content extraction** — Raw HTML is extracted from the page
7. **Markdown conversion** — HTML is sent to `go-html-to-md` for clean markdown output
8. **Result storage** — The result is stored in Redis and returned to the API

### Step 5: Response flows back

The scraping API returns the result → MCP tool handler wraps it → MCP server sends the JSON-RPC response:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "# Example Domain\n\nThis domain is for use in illustrative examples..."
      }
    ]
  }
}
```

### Step 6: AI uses the content

The AI assistant receives the scraped content in its context and uses it to answer the user's question.

---

## The Tool Registry

The MCP server exposes these tools, each mapped to a scraping API endpoint:

### Scraping Tools

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `scorch_scrape` | `POST /v1/scrape` | Scrape a single URL → markdown, HTML, JSON, or screenshot |
| `scorch_crawl` | `POST /v1/crawl` | Start a multi-page crawl job (async) |
| `scorch_check_crawl_status` | `GET /v1/crawl/:id` | Check crawl progress and get results |
| `scorch_map` | `POST /v1/map` | Discover all URLs on a site (sitemap discovery) |
| `scorch_search` | `POST /v1/search` | Web search + scrape results (SearxNG) |
| `scorch_extract` | `POST /v1/extract` | LLM-powered structured data extraction |

### Agent Tools

| Tool | Backend | Description |
|------|---------|-------------|
| `scorch_agent` | Copilot SDK | Start an autonomous research agent job |
| `scorch_agent_status` | In-memory | Check agent job progress |
| `scorch_agent_models` | Config | List available LLM models for agent |

### How Tools Are Registered

In `server/src/index.ts`, each tool is defined with:

```typescript
server.tool(
  "scorch_scrape",           // Tool name (what the AI calls)
  "Scrape a web page...",    // Description (shown in tools/list)
  {                          // Input schema (JSON Schema)
    url: z.string().url(),
    formats: z.array(z.string()).optional(),
    // ...
  },
  async (params) => {        // Handler function
    const result = await fetch(`${API_URL}/v1/scrape`, {
      method: "POST",
      body: JSON.stringify(params),
    });
    return { content: [{ type: "text", text: result.markdown }] };
  }
);
```

When a client sends `tools/list`, the server returns all registered tools with their descriptions and schemas. The AI uses these schemas to know what parameters to pass.

---

## Transport Modes

### HTTP Streamable (Docker Compose default)

```
Client  ──HTTP POST──→  :24787/mcp  ──→  MCP Server
        ←─HTTP SSE──                 ←──  (server-sent events for streaming)
```

- Set by `HTTP_STREAMABLE_SERVER=true` in Docker Compose
- Stateless JSON-RPC 2.0 over HTTP POST
- Session ID returned on `initialize` for subsequent requests
- Supports Server-Sent Events for streaming responses

### stdio (CLI / Claude Desktop)

```
Client  ──stdin──→  MCP Server process
        ←─stdout──
```

- Default when running `node dist/index.js` directly
- Each line is a JSON-RPC message
- Used by Claude Desktop and direct CLI integration

### Which to use?

| Use Case | Transport | How |
|----------|-----------|-----|
| Docker Compose deployment | HTTP Streamable | `docker compose up` (default config) |
| Claude Desktop | stdio | Add to Claude Desktop config |
| VS Code Copilot via nginx | HTTP Streamable | Connect to `https://your-domain/mcp/scorchcrawl/` |
| CLI testing | HTTP | `curl -X POST http://localhost:24787/mcp` |

---

## The Copilot Agent Engine

The `scorch_agent` tool is special — it runs an autonomous AI agent that can:

1. Plan a research strategy
2. Call other ScorchCrawl tools (scrape, search, map) as sub-tools
3. Iterate until it has enough information
4. Return a structured answer

### How it works:

```
User: "Find the pricing of Acme Corp's enterprise plan"
  │
  ▼
scorch_agent starts
  │
  ├── Agent thinks: "I need to find Acme Corp's pricing page"
  ├── Calls scorch_search("Acme Corp pricing")
  ├── Gets search results with URLs
  ├── Calls scorch_scrape("https://acme.com/pricing")
  ├── Reads the pricing page content
  ├── Calls scorch_extract(url, schema: {plan, price})
  ├── Gets structured pricing data
  └── Returns: "Enterprise plan: $499/mo"
```

### Agent job lifecycle:

| State | Description |
|-------|-------------|
| `processing` | Agent is actively researching |
| `completed` | Agent finished, results available |
| `failed` | Agent encountered an error |

Poll `scorch_agent_status` with the job ID to check progress. Jobs are cleaned up after 5 minutes (configurable via `staleJobTimeoutMs`).

---

## Rate Limiting

Three independent layers protect the system:

### 1. Per-request rate limiting

Each user (identified by Copilot token hash) gets a sliding window:
- 20 requests per 60 seconds (configurable)
- Exceeding this returns a "rate limit exceeded" error

### 2. Per-user concurrency

Each user can have at most 3 agent jobs running simultaneously:
- New `scorch_agent` requests are rejected until a slot opens
- Non-agent tools (scrape, map, etc.) are not affected

### 3. Global concurrency

System-wide limit of 10 concurrent agent jobs:
- Protects the system from overload
- All users share this pool

### How users are identified

1. If the request includes `x-copilot-token` or `x-github-token` header → hash of that token
2. If using nginx API key auth → the API key value
3. Otherwise → IP address

---

## Authentication Flow

### No auth (default self-hosted)

```
Client → MCP Server → Scraping API
```

No tokens required. Anyone who can reach port 24787 can use the tools.

### Nginx API key auth (recommended for production)

```
Client → nginx (:443) → [API key check] → MCP Server (:24787)
```

1. Client sends `Authorization: Bearer <key>` or `x-api-key: <key>`
2. nginx checks the key against `/etc/nginx/mcp-api-keys.list`
3. If valid → forwards to MCP server
4. If invalid → returns 401

### Copilot token auth

```
Client → MCP Server → [validates token with GitHub API]
```

When `CLOUD_SERVICE=true`, the server validates Copilot tokens by calling the GitHub API. Used in hosted/cloud deployments.

---

## Service Dependencies

The MCP server depends on these services (all managed by Docker Compose):

```
scorchcrawl-mcp (MCP server, port 24787)
  └── depends on: scorchcrawl-api

scorchcrawl-api (scraping API, port 3002)
  ├── depends on: redis
  ├── depends on: rabbitmq
  ├── depends on: postgres
  ├── depends on: playwright (stealth browser)
  ├── depends on: browserless (Chrome pool)
  └── depends on: go-html-to-md (HTML→Markdown converter)
```

### Startup order

Docker Compose starts services in dependency order with health checks:

1. `redis`, `rabbitmq`, `postgres` (data stores — start first)
2. `playwright`, `browserless`, `go-html-to-md` (processors)
3. `scorchcrawl-api` (scraping engine — waits for data stores)
4. `scorchcrawl-mcp` (MCP server — waits for scraping API)

If the scraping API isn't ready, the MCP server's health check fails and Docker restarts it.

---

## File Structure

```
server/
├── src/
│   ├── index.ts          # MCP server, tool registry, transport setup
│   ├── local-scraper.ts  # Client-side scraping proxy
│   └── types/            # TypeScript type definitions
├── tests/
│   ├── copilot-agent.test.ts    # Agent engine tests
│   ├── rate-limiter.test.ts     # Rate limiter tests
│   └── mcp-protocol.test.ts     # MCP protocol compliance tests
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript config
└── Dockerfile            # Container build
```

---

## Common Patterns

### Scrape → Process → Respond

Most AI interactions follow this pattern:

1. AI calls `scorch_scrape` or `scorch_search` to get raw content
2. The content enters the AI's context
3. AI processes/summarizes/extracts what the user needs
4. AI responds to the user

### Map → Scrape (for large sites)

1. AI calls `scorch_map("https://docs.example.com")` to discover all pages
2. AI identifies the right page from the URL list
3. AI calls `scorch_scrape` on that specific page
4. AI extracts the information

### Agent (for complex research)

1. AI calls `scorch_agent` with a research prompt
2. Agent autonomously scrapes, searches, and iterates
3. AI polls `scorch_agent_status` until complete
4. AI presents the results

---

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `SCORCHCRAWL_API_URL not set` | Missing env var | Set in `.env` |
| `Rate limit exceeded` | Too many requests | Wait and retry |
| `System at maximum capacity` | Global concurrency limit | Wait for jobs to finish |
| `Scrape failed after N attempts` | Target site blocking | Use proxy, try stealth mode |
| `504 Gateway Timeout` | Nginx timeout for slow scrapes | Increase `proxy_read_timeout` |
| `401 Unauthorized` | Invalid API key via nginx | Check `mcp-api-keys.list` |
