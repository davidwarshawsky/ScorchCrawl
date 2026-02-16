/**
 * @file mcp-protocol.test.ts
 * Integration tests for MCP protocol compliance.
 *
 * These verify the HTTP Streamable transport surface and /health endpoint
 * against the MCP specification requirements.
 *
 * They require the server to be built and running with HTTP_STREAMABLE_SERVER=true.
 * Set MCP_TEST_URL=http://localhost:24787 (or wherever the server is).
 */

import { describe, it, expect } from 'vitest';

const MCP_URL = process.env.MCP_TEST_URL || 'http://localhost:24787';

/**
 * Helper: send a JSON-RPC 2.0 request to the MCP Streamable HTTP endpoint.
 *
 * The MCP Streamable HTTP transport:
 *  - Requires `Accept: application/json, text/event-stream`
 *  - Returns SSE-formatted responses with `data:` lines containing JSON
 */
async function mcpRequest(method: string, params: Record<string, unknown> = {}, id: number = 1) {
  const response = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  });
  return response;
}

/**
 * Parse the first JSON-RPC result from an SSE response body.
 *
 * SSE format:
 *   event: message
 *   id: <uuid>
 *   data: {"result":...,"jsonrpc":"2.0","id":1}
 */
async function parseSSE(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No data: line in SSE response:\n${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

// ---------------------------------------------------------------------------
// Health Endpoint
// ---------------------------------------------------------------------------

describe('Health endpoint', () => {
  it('GET /health returns 200 with ok body', async () => {
    const res = await fetch(`${MCP_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.trim()).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// MCP Protocol: initialize
// ---------------------------------------------------------------------------

describe('MCP initialize', () => {
  it('responds to initialize with capabilities', async () => {
    const res = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    expect(res.status).toBe(200);
    const body = await parseSSE(res);
    expect(body).toHaveProperty('result');
    expect(body.result).toHaveProperty('protocolVersion');
    expect(body.result).toHaveProperty('capabilities');
    expect(body.result).toHaveProperty('serverInfo');
    expect(body.result.serverInfo.name).toBe('scorchcrawl');
  });

  it('rejects requests without Accept header', async () => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(406);
  });
});

// ---------------------------------------------------------------------------
// MCP Protocol: tools/list
// ---------------------------------------------------------------------------

describe('MCP tools/list', () => {
  it('lists all registered tools', async () => {
    // First initialize
    await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const res = await mcpRequest('tools/list', {}, 2);
    expect(res.status).toBe(200);
    const body = await parseSSE(res);
    expect(body).toHaveProperty('result');
    expect(body.result).toHaveProperty('tools');
    expect(Array.isArray(body.result.tools)).toBe(true);

    const toolNames = body.result.tools.map((t: any) => t.name);
    // Core tools that must always be present
    expect(toolNames).toContain('scorch_scrape');
    expect(toolNames).toContain('scorch_map');
    expect(toolNames).toContain('scorch_search');
    expect(toolNames).toContain('scorch_crawl');
    expect(toolNames).toContain('scorch_extract');
    expect(toolNames).toContain('scorch_agent');
    expect(toolNames).toContain('scorch_agent_status');
    expect(toolNames).toContain('scorch_agent_models');
    expect(toolNames).toContain('scorch_agent_rate_limit_status');
    expect(toolNames).toContain('scorch_check_crawl_status');
  });

  it('each tool has name, description, and inputSchema', async () => {
    await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    const res = await mcpRequest('tools/list', {}, 3);
    const body = await parseSSE(res);
    for (const tool of body.result.tools) {
      expect(tool).toHaveProperty('name');
      expect(typeof tool.name).toBe('string');
      expect(tool).toHaveProperty('description');
      expect(typeof tool.description).toBe('string');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
    }
  });
});

// ---------------------------------------------------------------------------
// MCP Protocol: error handling
// ---------------------------------------------------------------------------

describe('MCP error handling', () => {
  it('returns JSON-RPC error for unknown method', async () => {
    const res = await mcpRequest('nonexistent/method', {}, 99);
    // The transport may return 200 with a JSON-RPC error, or a non-200 status
    const text = await res.text();

    if (res.status === 200) {
      // Standard JSON-RPC: error in body
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        const body = JSON.parse(dataLine.slice('data: '.length));
        expect(body).toHaveProperty('error');
        expect(body.error).toHaveProperty('code');
        expect(body.error).toHaveProperty('message');
      }
    } else {
      // Some transports return 4xx for unknown methods — still valid
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
