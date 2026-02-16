# Testing Guide

## Overview

ScorchCrawl uses [Vitest](https://vitest.dev/) for testing with three tiers:

| Tier | What it tests | How to run |
|------|--------------|------------|
| **Unit** | Rate limiter, config parsing, error hooks | `npm test` |
| **Integration** | MCP protocol compliance, tool listing | `npm run test:integration` |
| **Docker** | Full stack health check | CI only (GitHub Actions) |

## Quick Start

```bash
cd server
npm install        # installs vitest as dev dependency
npm test           # run unit tests
npm run test:watch # watch mode during development
```

## Unit Tests

Located in `server/tests/`:

- **`rate-limiter.test.ts`** — Tests all rate limiting components:
  - `ConcurrencyTracker`: global and per-user concurrency gates
  - `SlidingWindowRateLimiter`: request rate windowing and GC
  - `QuotaMonitor`: proactive quota rejection
  - `RateLimitGuard`: unified facade integration
  - `buildErrorHook`: Copilot SDK error classification
  - `findStaleJobs`: stale job identification

- **`copilot-agent.test.ts`** — Tests agent configuration:
  - Model list parsing from `COPILOT_AGENT_MODELS` env var
  - Default model selection logic
  - Edge cases (empty strings, whitespace, missing env vars)

## Integration Tests

**`mcp-protocol.test.ts`** — Tests MCP protocol compliance against a running server:

- Health endpoint responds correctly
- `initialize` returns server capabilities
- `tools/list` returns all 10 expected tools
- Each tool has `name`, `description`, and `inputSchema`
- Unknown methods return proper JSON-RPC errors

### Running Integration Tests

```bash
# Option 1: Against a locally running server
cd server
npm run build
HTTP_STREAMABLE_SERVER=true PORT=24787 node dist/index.js &
MCP_TEST_URL=http://localhost:24787 npm run test:integration

# Option 2: Against Docker Compose stack
docker compose up -d
MCP_TEST_URL=http://localhost:24787 npm run test:integration
```

## CI/CD

GitHub Actions runs automatically on push/PR to `main`:

1. **Unit tests** — Always runs
2. **TypeScript check** — `tsc --noEmit`
3. **Docker build** — Builds image and checks `/health`
4. **Integration tests** — Only on `main` branch merges

## Adding New Tests

1. Create a file in `server/tests/` matching `*.test.ts`
2. Import from `vitest`: `import { describe, it, expect } from 'vitest'`
3. Unit tests run by default; integration tests use the separate config

```typescript
import { describe, it, expect } from 'vitest';

describe('MyFeature', () => {
  it('does the thing', () => {
    expect(1 + 1).toBe(2);
  });
});
```
