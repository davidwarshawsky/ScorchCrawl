# ScorchCrawl — Core Scraping Engine

Lightweight, privacy-conscious web crawling and scraping engine that produces LLM-ready output (markdown, structured JSON, screenshots, HTML). This repository contains the core engine and shared libraries used by the MCP server/proxy.

This project follows the split used by similar tooling (core engine + MCP proxy). If you need the MCP proxy/server, see the companion repository `scorchcrawl-mcp`.

Highlights
- Focused crawler and extractor primitives for reliable, repeatable HTML -> markdown/json conversion
- Playwright integration for resilient rendering and stealth navigation
- Structured extractors (tables, metadata, screenshots) suitable for RAG/LLM use-cases
- Designed to be hosted independently from the MCP proxy for flexible deployments

Quick start (local, Docker)

> **Note:** an `scorchcrawl` image is published to Docker Hub.  See the Docker section below for pull commands.

1. Clone this repo and copy example env:

```bash
git clone https://github.com/davidwarshawsky/scorchcrawl.git
cd scorchcrawl
cp .env.example .env
```

2. Either **build locally** or **pull the hosted image** and run the full stack (local mode):

```bash
# build from source (requires pnpm/node, see docs)
docker compose build

# or use the published image from Docker Hub:
docker pull ananymoususer/scorchcrawl:latest
# (replace `ananymoususer` with your namespace if you republish)

# then start services
docker compose up -d
```

The core scraping API is normally available at `http://localhost:24786`.  If you pulled the image there is no build step required — just ensure your `.env` is configured.


When to run the core engine separately
- Large-scale crawling or centralized scraping deployments
- If you want a hosted scraping API that multiple MCP proxies can call
- For resource isolation (run browser pool and queue workers on dedicated machines)

Companion: `scorchcrawl-mcp`
- The MCP proxy / local server that exposes Model Context Protocol endpoints lives in [`scorchcrawl-mcp`](https://github.com/davidwarshawsky/scorchcrawl-mcp). Use it when you want per-user GP/stdio integration or a local proxy on client devices.

Docs & config
- See `docs/` inside this repo for configuration, testing, and architecture notes.

License
- AGPL-3.0 — see `LICENSE` for details.

Contact
- Repo: https://github.com/davidwarshawsky/scorchcrawl


The MCP server layer (`server/`), client package (`client/`), and Docker orchestration are original work by ScorchCrawl Contributors, also licensed under AGPL-3.0.

**Trademark Notice:** "Firecrawl" is a trademark of Mendable/Sideguide Technologies Inc. "ScorchCrawl" is NOT affiliated with, endorsed by, or sponsored by Firecrawl or Mendable/Sideguide Technologies Inc.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. THE AUTHORS AND COPYRIGHT HOLDERS DISCLAIM ALL LIABILITY FOR ANY DAMAGES ARISING FROM THE USE OF THIS SOFTWARE. USERS ASSUME ALL RISK AND RESPONSIBILITY FOR COMPLIANCE WITH APPLICABLE LAWS AND REGULATIONS. THIS SOFTWARE MUST NOT BE USED FOR ANY ILLEGAL ACTIVITY, UNAUTHORIZED ACCESS, OR IN VIOLATION OF ANY WEBSITE'S TERMS OF SERVICE.
