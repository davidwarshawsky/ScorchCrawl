/**
 * Tests for response-utils.ts — Error Mapping, Content Truncation, AI Summarization
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mapError,
  truncateAtBoundary,
  truncateContent,
  safeExecute,
  processResponse,
  processResponseSync,
  wordCount,
  summarizeIfNeeded,
  summaryCache,
  summarizationTimestamps,
  type MappedError,
} from '../src/response-utils.js';

// ---------------------------------------------------------------------------
// Feature 1: Error Mapping
// ---------------------------------------------------------------------------

describe('mapError', () => {
  describe('ACCESS_DENIED', () => {
    it('classifies HTTP 403 errors', () => {
      const result = mapError(new Error('Request failed with status code 403'));
      expect(result.code).toBe('ACCESS_DENIED');
      expect(result.message).toContain('blocks automated access');
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.originalError).toBeDefined();
    });

    it('classifies Cloudflare challenge errors', () => {
      const result = mapError('Cloudflare challenge detected');
      expect(result.code).toBe('ACCESS_DENIED');
    });

    it('classifies forbidden responses', () => {
      const result = mapError({ message: 'Forbidden access' });
      expect(result.code).toBe('ACCESS_DENIED');
    });
  });

  describe('NOT_FOUND', () => {
    it('classifies HTTP 404 errors', () => {
      const result = mapError(new Error('Request failed with status code 404'));
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toContain('does not exist');
      expect(result.suggestions).toContainEqual(expect.stringContaining('scorch_map'));
    });

    it('classifies "page not found" messages', () => {
      const result = mapError('Page not found');
      expect(result.code).toBe('NOT_FOUND');
    });
  });

  describe('RATE_LIMITED', () => {
    it('classifies HTTP 429 errors', () => {
      const result = mapError(new Error('Request failed with status code 429'));
      expect(result.code).toBe('RATE_LIMITED');
      expect(result.suggestions).toContainEqual(expect.stringContaining('Wait'));
    });

    it('classifies rate limit messages', () => {
      const result = mapError('Too many requests');
      expect(result.code).toBe('RATE_LIMITED');
    });
  });

  describe('SERVER_ERROR', () => {
    it('classifies HTTP 500 errors', () => {
      const result = mapError(new Error('Request failed with status code 500'));
      expect(result.code).toBe('SERVER_ERROR');
      expect(result.suggestions).toContainEqual(expect.stringContaining('Retry'));
    });

    it('classifies HTTP 503 errors', () => {
      const result = mapError(new Error('Request failed with status code 503'));
      expect(result.code).toBe('SERVER_ERROR');
    });
  });

  describe('TIMEOUT', () => {
    it('classifies timeout errors', () => {
      const result = mapError(new Error('Timeout after 30000ms'));
      expect(result.code).toBe('TIMEOUT');
      expect(result.message).toContain('too long to load');
    });

    it('classifies AbortError', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      const result = mapError(err);
      expect(result.code).toBe('TIMEOUT');
    });
  });

  describe('CONNECTION_FAILED', () => {
    it('classifies ECONNREFUSED to remote sites', () => {
      const result = mapError(new Error('connect ECONNREFUSED 93.184.216.34:443'));
      expect(result.code).toBe('CONNECTION_FAILED');
      expect(result.message).toContain('Cannot reach');
    });

    it('classifies DNS errors', () => {
      const result = mapError(new Error('getaddrinfo ENOTFOUND nonexist.example.com'));
      expect(result.code).toBe('CONNECTION_FAILED');
    });
  });

  describe('ENGINE_UNAVAILABLE', () => {
    it('classifies ECONNREFUSED to localhost', () => {
      const result = mapError(new Error('connect ECONNREFUSED 127.0.0.1:3002'));
      expect(result.code).toBe('ENGINE_UNAVAILABLE');
      expect(result.message).toContain('engine is not running');
      expect(result.suggestions).toContainEqual(expect.stringContaining('docker'));
    });
  });

  describe('TLS_ERROR', () => {
    it('classifies SSL certificate errors', () => {
      const result = mapError(new Error('unable to verify the first certificate'));
      expect(result.code).toBe('TLS_ERROR');
      expect(result.suggestions).toContainEqual(expect.stringContaining('skipTlsVerification'));
    });
  });

  describe('EMPTY_CONTENT', () => {
    it('classifies empty content responses', () => {
      const result = mapError('No content returned');
      expect(result.code).toBe('EMPTY_CONTENT');
    });
  });

  describe('SPA_DETECTED', () => {
    it('classifies SPA skeleton detection', () => {
      const result = mapError('SPA_SKELETON_DETECTED');
      expect(result.code).toBe('SPA_DETECTED');
    });
  });

  describe('UNKNOWN_ERROR', () => {
    it('falls back for unrecognized errors', () => {
      const result = mapError(new Error('Something completely unexpected'));
      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('handles non-Error values', () => {
      const result = mapError(42);
      expect(result.code).toBe('UNKNOWN_ERROR');
    });

    it('handles undefined', () => {
      const result = mapError(undefined);
      expect(result.code).toBe('UNKNOWN_ERROR');
    });
  });

  it('never includes originalError in message or suggestions', () => {
    const result = mapError(new Error('connect ECONNREFUSED 127.0.0.1:3002'));
    expect(result.message).not.toContain('ECONNREFUSED');
    for (const s of result.suggestions) {
      expect(s).not.toContain('ECONNREFUSED');
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Content Truncation
// ---------------------------------------------------------------------------

describe('truncateAtBoundary', () => {
  it('returns content unchanged if under limit', () => {
    const { text, wasTruncated } = truncateAtBoundary('Hello world', 100);
    expect(text).toBe('Hello world');
    expect(wasTruncated).toBe(false);
  });

  it('truncates at paragraph boundary', () => {
    // Need enough content that the paragraph break falls in the last 30% of the window
    const content = 'A'.repeat(60) + '\n\n' + 'B'.repeat(60) + '\n\n' + 'C'.repeat(60);
    const { text, wasTruncated } = truncateAtBoundary(content, 150);
    expect(wasTruncated).toBe(true);
    // Should cut at a paragraph boundary, not mid-word
    expect(text).toContain('\n\n');
    expect(text.length).toBeLessThan(content.length);
  });

  it('truncates at heading boundary', () => {
    const content = '# Section 1\n\nContent 1\n\n# Section 2\n\nContent 2 which is very long and exceeds the limit considerably in practice';
    const { text, wasTruncated } = truncateAtBoundary(content, 50);
    expect(wasTruncated).toBe(true);
    // Should cut before or at a heading
  });

  it('truncates at sentence boundary when no paragraph break', () => {
    // Build content with sentences, where a sentence break lands in the last 30% of window
    const content = 'A'.repeat(50) + '. ' + 'B'.repeat(50) + '. ' + 'C'.repeat(50) + '.';
    const { text, wasTruncated } = truncateAtBoundary(content, 120);
    expect(wasTruncated).toBe(true);
    // Should end near a sentence boundary
    expect(text.length).toBeLessThan(content.length);
  });

  it('does hard cut as last resort', () => {
    // A single very long word with no break points
    const content = 'a'.repeat(200);
    const { text, wasTruncated } = truncateAtBoundary(content, 100);
    expect(wasTruncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100);
  });
});

describe('truncateContent', () => {
  it('passes through small responses unchanged', () => {
    const data = { success: true, data: { markdown: 'Hello world' } };
    const { result, wasTruncated } = truncateContent(data);
    expect(wasTruncated).toBe(false);
    expect(result).toEqual(data);
  });

  it('truncates large markdown fields', () => {
    const longMarkdown = 'Word '.repeat(10000); // ~50,000 chars
    const data = {
      success: true,
      data: {
        markdown: longMarkdown,
        metadata: { title: 'Test Page', sourceURL: 'https://example.com' },
      },
    };
    const { result, wasTruncated, originalLength } = truncateContent(data);
    expect(wasTruncated).toBe(true);
    expect(originalLength).toBeGreaterThan(25000);

    const r = result as any;
    expect(r.data.markdown.length).toBeLessThan(longMarkdown.length);
    expect(r.data.markdown).toContain('Content truncated');
    expect(r.data.metadata._truncated).toBe(true);
    expect(r.data.metadata._originalLength).toBe(originalLength);
  });

  it('never truncates metadata or links', () => {
    const longMarkdown = 'Word '.repeat(10000);
    const data = {
      success: true,
      data: {
        markdown: longMarkdown,
        links: Array.from({ length: 500 }, (_, i) => `https://example.com/page${i}`),
        metadata: { title: 'Test', sourceURL: 'https://example.com' },
      },
    };
    const { result } = truncateContent(data);
    const r = result as any;
    // Links array should be preserved
    expect(r.data.links.length).toBe(500);
    expect(r.data.metadata.title).toBe('Test');
  });
});

describe('processResponseSync', () => {
  it('returns JSON string', () => {
    const result = processResponseSync({ hello: 'world' });
    expect(JSON.parse(result)).toEqual({ hello: 'world' });
  });
});

// ---------------------------------------------------------------------------
// Feature 3: AI Summarization
// ---------------------------------------------------------------------------

describe('wordCount', () => {
  it('counts words correctly', () => {
    expect(wordCount('Hello world')).toBe(2);
    expect(wordCount('  spaced   out  ')).toBe(2);
    expect(wordCount('')).toBe(0);
    expect(wordCount('one')).toBe(1);
  });
});

describe('summarizeIfNeeded', () => {
  beforeEach(() => {
    summaryCache.clear();
    summarizationTimestamps.length = 0;
  });

  it('returns content unchanged if under word threshold', async () => {
    const markdown = 'Short content that does not need summarization.';
    const result = await summarizeIfNeeded(markdown, 'https://example.com');
    expect(result.summarized).toBe(false);
    expect(result.markdown).toBe(markdown);
  });

  it('returns content unchanged when no getCopilotClientFn provided', async () => {
    const markdown = 'word '.repeat(6000); // way over threshold
    const result = await summarizeIfNeeded(markdown, 'https://example.com');
    expect(result.summarized).toBe(false);
  });

  it('returns cached summary on cache hit', async () => {
    const markdown = 'word '.repeat(6000);
    const url = 'https://example.com/test';

    // Manually populate cache
    const { createHash } = await import('node:crypto');
    const fingerprint = url + markdown.slice(0, 1000);
    const key = createHash('sha256').update(fingerprint).digest('hex');
    summaryCache.set(key, {
      summary: 'Cached summary content',
      timestamp: Date.now(),
      wordCount: 3,
    });

    const result = await summarizeIfNeeded(
      markdown,
      url,
      async () => ({}), // dummy client
    );
    expect(result.summarized).toBe(true);
    expect(result.markdown).toBe('Cached summary content');
    expect(result.meta?._cachedResult).toBe(true);
  });

  it('falls back gracefully when Copilot client call fails', async () => {
    const markdown = 'word '.repeat(6000);
    const mockGetClient = async () => ({
      createSession: async () => {
        throw new Error('Copilot API unavailable');
      },
    });

    const result = await summarizeIfNeeded(
      markdown,
      'https://example.com',
      mockGetClient,
    );
    expect(result.summarized).toBe(false);
    expect(result.meta?._summarizationFailed).toBe(true);
  });

  it('falls back when null client returned', async () => {
    const markdown = 'word '.repeat(6000);
    const result = await summarizeIfNeeded(
      markdown,
      'https://example.com',
      async () => null,
    );
    expect(result.summarized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined Pipeline: safeExecute
// ---------------------------------------------------------------------------

describe('safeExecute', () => {
  it('returns result on success', async () => {
    const result = await safeExecute(
      async () => '{"success": true}',
      { tool: 'test' },
    );
    expect(result).toBe('{"success": true}');
  });

  it('returns mapped error on failure', async () => {
    const result = await safeExecute(
      async () => {
        throw new Error('Request failed with status code 403');
      },
      { tool: 'scorch_scrape', url: 'https://example.com' },
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('ACCESS_DENIED');
    expect(parsed.suggestions).toBeDefined();
    expect(parsed.suggestions.length).toBeGreaterThan(0);
  });

  it('returns mapped error for timeout', async () => {
    const result = await safeExecute(
      async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
      { tool: 'scorch_scrape' },
    );
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe('TIMEOUT');
  });

  it('returns mapped error for connection failures', async () => {
    const result = await safeExecute(
      async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3002');
      },
      { tool: 'scorch_scrape' },
    );
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe('ENGINE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// processResponse
// ---------------------------------------------------------------------------

describe('processResponse', () => {
  it('returns JSON string for normal data', async () => {
    const result = await processResponse({ success: true, data: { markdown: 'Hello' } });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
  });

  it('truncates oversized content', async () => {
    const longMarkdown = 'Word '.repeat(10000);
    const data = { success: true, data: { markdown: longMarkdown } };
    const result = await processResponse(data);
    expect(result.length).toBeLessThan(JSON.stringify(data, null, 2).length);
    expect(result).toContain('Content truncated');
  });

  it('skips summarization when flag is set', async () => {
    const data = { success: true, data: { markdown: 'word '.repeat(6000) } };
    const mockGetClient = vi.fn();
    const result = await processResponse(data, {
      skipSummarization: true,
      getCopilotClientFn: mockGetClient,
    });
    expect(mockGetClient).not.toHaveBeenCalled();
  });
});
