#!/usr/bin/env node

/**
 * scorchcrawl-mcp CLI
 *
 * A thin wrapper that connects to a ScorchCrawl server and exposes its MCP
 * tools over stdio transport. This lets MCP clients (VS Code, Copilot CLI,
 * etc.) use a remote ScorchCrawl server as if it were a local MCP server.
 *
 * Usage:
 *   SCORCHCRAWL_URL=http://localhost:24787 scorchcrawl-mcp
 *
 * Or with a remote server + API key:
 *   SCORCHCRAWL_URL=https://your-server.com/mcp-api/scorchcrawl/YOUR_KEY scorchcrawl-mcp
 *
 * Environment variables:
 *   SCORCHCRAWL_URL          - Base URL of the ScorchCrawl MCP server (required)
 *   GITHUB_TOKEN             - GitHub PAT for Copilot SDK agent (optional, sent as x-copilot-token)
 *   SCORCHCRAWL_LOCAL_PROXY  - Set to "true" to route scraping through your local IP
 */

import { config } from 'dotenv';
config({ quiet: true });

const SCORCHCRAWL_URL = process.env.SCORCHCRAWL_URL || 'http://localhost:24787';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LOCAL_PROXY = process.env.SCORCHCRAWL_LOCAL_PROXY === 'true';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: string | number;
}

/**
 * Forward a JSON-RPC request to the remote ScorchCrawl server.
 */
async function forwardToServer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const url = `${SCORCHCRAWL_URL.replace(/\/$/, '')}/mcp`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  if (GITHUB_TOKEN) {
    headers['x-copilot-token'] = GITHUB_TOKEN;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    const text = await response.text();

    // Handle SSE responses (event: message\ndata: {...})
    if (text.startsWith('event:') || text.startsWith('data:')) {
      const dataLine = text.split('\n').find(l => l.startsWith('data:'));
      if (dataLine) {
        return JSON.parse(dataLine.slice(5).trim());
      }
    }

    // Handle direct JSON responses
    if (text.trim().startsWith('{')) {
      return JSON.parse(text);
    }

    return {
      jsonrpc: '2.0',
      error: { code: -32603, message: `Unexpected response: ${text.substring(0, 200)}` },
      id: request.id,
    };
  } catch (err: any) {
    return {
      jsonrpc: '2.0',
      error: { code: -32603, message: `Connection failed: ${err.message}` },
      id: request.id,
    };
  }
}

/**
 * Read JSON-RPC messages from stdin and forward to the server.
 */
async function main(): Promise<void> {
  const serverUrl = SCORCHCRAWL_URL;

  if (!serverUrl || serverUrl === 'http://localhost:24787') {
    process.stderr.write(
      `[scorchcrawl-mcp] Connecting to ${serverUrl}\n` +
      `[scorchcrawl-mcp] Set SCORCHCRAWL_URL to change the server address\n`
    );
  } else {
    process.stderr.write(`[scorchcrawl-mcp] Connecting to ${serverUrl}\n`);
  }

  if (LOCAL_PROXY) {
    process.stderr.write('[scorchcrawl-mcp] Local proxy mode: ON (scraping through your IP)\n');
  }

  // Read from stdin line by line
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request: JsonRpcRequest = JSON.parse(trimmed);
        const response = await forwardToServer(request);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (err: any) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0',
          error: { code: -32700, message: `Parse error: ${err.message}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[scorchcrawl-mcp] Fatal error: ${err.message}\n`);
  process.exit(1);
});
