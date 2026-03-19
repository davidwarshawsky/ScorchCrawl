# Setup and Install Guide

This guide covers the practical ways to install and run the ScorchCrawl engine:

- pull and run the published Docker images
- build the stack locally from source
- deploy the engine on an EC2 instance

This repository is the core scraping engine only. If you need the MCP proxy/server, use the companion repository `scorchcrawl-mcp`.

## Choose a Path

Use one of these paths depending on your environment:

- Fastest: Docker Hub images with `docker-compose.hub.yaml`
- Most flexible: local source build with `docker-compose.yaml`
- Server deployment: Docker Hub images on EC2

## Prerequisites

For the Docker-based paths:

- Docker
- Docker Compose plugin
- Git

For the source-build path:

- Docker
- Docker Compose plugin
- Git
- enough RAM and disk for image builds

## Option 1: Pull and Run the Published Images

This is the simplest way to start the engine.

### 1. Clone the repository

```bash
git clone https://github.com/davidwarshawsky/scorchcrawl.git
cd scorchcrawl
```

### 2. Create your environment file

```bash
cp .env.example .env
```

For engine-only deployment, set at least these values in `.env`:

```dotenv
SCORCHCRAWL_HOST=127.0.0.1
SCORCHCRAWL_PORT=24786

POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-this
POSTGRES_DB=postgres

NUM_WORKERS_PER_QUEUE=5
MAX_CONCURRENT_JOBS=3
CRAWL_CONCURRENT_REQUESTS=3
BROWSER_POOL_SIZE=3
SCRAPE_MAX_ATTEMPTS=3
SCRAPE_MAX_PDF_PREFETCHES=1
SCRAPE_MAX_DOCUMENT_PREFETCHES=1
SCRAPE_MAX_FEATURE_TOGGLES=2
BLOCK_MEDIA=true

LOGGING_LEVEL=info
```

Notes:

- `SCORCHCRAWL_HOST=127.0.0.1` keeps the API local-only.
- Change it to `0.0.0.0` only if you want remote access.
- `GITHUB_TOKEN` is not required for the engine-only Docker stack.
- `OPENAI_API_KEY` is optional unless you need LLM-backed features.

### 3. Pull the prebuilt images

```bash
docker compose -f docker-compose.hub.yaml pull
```

This pulls the published images used by the prebuilt stack, including:

- `ananymoususer/scorchcrawl:latest`
- `ananymoususer/scorchcrawl-playwright:latest`
- `ananymoususer/scorchcrawl-postgres:latest`

### 4. Start the stack

```bash
docker compose -f docker-compose.hub.yaml up -d
```

### 5. Verify it started

```bash
docker compose -f docker-compose.hub.yaml ps
docker compose -f docker-compose.hub.yaml logs --tail=100 scorchcrawl-api
```

The engine API should be available at:

```text
http://127.0.0.1:24786
```

## Option 2: Build from Source

Use this path if you want to build the engine image locally instead of pulling it.

### 1. Clone and configure

```bash
git clone https://github.com/davidwarshawsky/scorchcrawl.git
cd scorchcrawl
cp .env.example .env
```

### 2. Build the images

```bash
docker compose build
```

### 3. Start the stack

```bash
docker compose up -d
```

### 4. Verify it started

```bash
docker compose ps
docker compose logs --tail=100 scorchcrawl-api
```

## Option 3: Deploy on EC2

For EC2, the best starting point is the published image stack.

### 1. Install Docker and Git

Ubuntu/Debian example:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

### 2. Clone and configure

```bash
git clone https://github.com/davidwarshawsky/scorchcrawl.git
cd scorchcrawl
cp .env.example .env
```

Recommended EC2-specific baseline:

```dotenv
SCORCHCRAWL_HOST=0.0.0.0
SCORCHCRAWL_PORT=24786

POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-this
POSTGRES_DB=postgres

NUM_WORKERS_PER_QUEUE=5
MAX_CONCURRENT_JOBS=3
CRAWL_CONCURRENT_REQUESTS=3
BROWSER_POOL_SIZE=3
SCRAPE_MAX_ATTEMPTS=3
SCRAPE_MAX_PDF_PREFETCHES=1
SCRAPE_MAX_DOCUMENT_PREFETCHES=1
SCRAPE_MAX_FEATURE_TOGGLES=2
BLOCK_MEDIA=true

LOGGING_LEVEL=info
```

### 3. Pull and start

```bash
docker compose -f docker-compose.hub.yaml pull
docker compose -f docker-compose.hub.yaml up -d
```

### 4. Open the port in the EC2 security group

Allow inbound TCP on `24786` from:

- your IP address, or
- your VPC or load balancer, if you are placing it behind a reverse proxy

### 5. Verify from the instance

```bash
docker compose -f docker-compose.hub.yaml ps
curl http://127.0.0.1:24786
```

If the security group allows it, the engine will be reachable at:

```text
http://YOUR_EC2_PUBLIC_IP:24786
```

## Updating the Stack

To refresh an existing deployment to the newest published images:

```bash
docker compose -f docker-compose.hub.yaml pull
docker compose -f docker-compose.hub.yaml up -d
```

## Stopping the Stack

Prebuilt-image stack:

```bash
docker compose -f docker-compose.hub.yaml down
```

Source-build stack:

```bash
docker compose down
```

## Troubleshooting

### Services did not start

```bash
docker compose -f docker-compose.hub.yaml ps
docker compose -f docker-compose.hub.yaml logs --tail=200
```

### API is not reachable remotely

Check all of these:

- `.env` has `SCORCHCRAWL_HOST=0.0.0.0`
- the EC2 security group allows TCP `24786`
- the container is actually running

### Host is low on RAM

The default deployment profile is already tuned down for moderate hosts:

- `NUM_WORKERS_PER_QUEUE=5`
- `MAX_CONCURRENT_JOBS=3`
- `CRAWL_CONCURRENT_REQUESTS=3`
- `BROWSER_POOL_SIZE=3`
- `BLOCK_MEDIA=true`

If the box still struggles, reduce concurrency further before increasing it.

## Related Docs

- `README.md`
- `docs/configuration.md`
- `docs/architecture.md`
- `docs/reverse-proxy.md`
- `docs/testing.md`