/**
 * Response Processing Utilities
 *
 * Three layers of intelligent response handling for MCP tool results:
 *   1. Error Mapping — classifies errors and returns actionable guidance
 *   2. Content Truncation — smart paragraph-boundary truncation with notices
 *   3. AI Summarization — Copilot SDK-powered content compression (optional)
 *
 * No competitor MCP scraper implements any of these. This is a ScorchCrawl
 * differentiator.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration (from environment)
// ---------------------------------------------------------------------------

const MAX_CONTENT_CHARS = parseInt(
  process.env.SCORCHCRAWL_MAX_CONTENT_CHARS || '25000',
  10,
);

const SUMMARIZE_AFTER_WORDS = parseInt(
  process.env.SCORCHCRAWL_SUMMARIZE_AFTER_WORDS || '5000',
  10,
);

const SUMMARIZE_MODEL =
  process.env.SCORCHCRAWL_SUMMARIZE_MODEL || 'gpt-4o';

const SUMMARIZE_CACHE_SIZE = parseInt(
  process.env.SCORCHCRAWL_SUMMARIZE_CACHE_SIZE || '100',
  10,
);

const SUMMARIZE_MAX_PER_MINUTE = parseInt(
  process.env.SCORCHCRAWL_SUMMARIZE_MAX_PER_MINUTE || '10',
  10,
);

// ---------------------------------------------------------------------------
// Feature 1: Error Mapping
// ---------------------------------------------------------------------------

export interface MappedError {
  /** Short error code for programmatic use */
  code: string;
  /** Human/LLM-readable explanation of what happened */
  message: string;
  /** Specific next steps the LLM should try */
  suggestions: string[];
  /** Original error for debug logging (not sent to LLM) */
  originalError?: string;
}

/**
 * Classify a raw error (from fetch, SDK, or engine) into a structured
 * MappedError with actionable guidance for the LLM.
 */
export function mapError(err: unknown): MappedError {
  const raw = normalizeErrorString(err);
  const lower = raw.toLowerCase();

  // --- HTTP status-based patterns ---
  if (matches(lower, ['403', 'forbidden', 'cloudflare', 'cf-ray', 'challenge', 'access denied'])) {
    return {
      code: 'ACCESS_DENIED',
      message: 'This site blocks automated access.',
      suggestions: [
        'Try scorch_search to find cached/indexed content instead',
        'Add waitFor: 5000 to let challenge pages resolve',
        'Try with proxy: "stealth" for enhanced bot evasion',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['404', 'not found', 'page not found', 'does not exist'])) {
    return {
      code: 'NOT_FOUND',
      message: 'Page does not exist at this URL.',
      suggestions: [
        'Use scorch_map to discover correct URLs on the site',
        'Check if the URL has a typo or outdated path',
        'Try scorch_search to find the current location of this content',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['429', 'rate limit', 'too many requests', 'throttl'])) {
    return {
      code: 'RATE_LIMITED',
      message: 'Rate limited by the target site.',
      suggestions: [
        'Wait 30 seconds and retry',
        'Try a different URL on the same site',
        'Use scorch_search to find the content from a different source',
      ],
      originalError: raw,
    };
  }

  if (matchesStatusRange(lower, 500, 599)) {
    return {
      code: 'SERVER_ERROR',
      message: 'The target site returned a server error.',
      suggestions: [
        'Retry once — the site may be experiencing temporary issues',
        'Try again in a few minutes if it persists',
      ],
      originalError: raw,
    };
  }

  // --- Network/connection errors ---
  if (matches(lower, ['timeout', 'aborterror', 'aborted', 'timed out', 'etimedout'])) {
    return {
      code: 'TIMEOUT',
      message: 'Page took too long to load.',
      suggestions: [
        'Add onlyMainContent: true to reduce processing time',
        'Increase waitFor to give JS more time to render',
        'Try with a simpler format like markdown instead of screenshot',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['econnrefused', 'enotfound', 'dns', 'getaddrinfo', 'connect failed'])) {
    // Distinguish between engine-down and remote-site-down
    if (matches(lower, ['localhost', '127.0.0.1', '0.0.0.0', '3002', 'engine', 'api'])) {
      return {
        code: 'ENGINE_UNAVAILABLE',
        message: 'Scraping engine is not running.',
        suggestions: [
          'Check that Docker services are up: docker compose up -d',
          'Verify SCORCHCRAWL_API_URL is correct in your config',
        ],
        originalError: raw,
      };
    }
    return {
      code: 'CONNECTION_FAILED',
      message: 'Cannot reach this URL.',
      suggestions: [
        'Check if the URL is correct and accessible',
        'The site may be down — try again later',
        'Try scorch_search to find alternative sources',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['ssl', 'tls', 'certificate', 'cert', 'self-signed', 'unable to verify'])) {
    return {
      code: 'TLS_ERROR',
      message: 'SSL certificate issue with this site.',
      suggestions: [
        'Try with skipTlsVerification: true',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['empty', 'no content', 'no markdown', 'no extractable'])) {
    return {
      code: 'EMPTY_CONTENT',
      message: 'Page returned no extractable content.',
      suggestions: [
        'Use scorch_map with a search param to find the right page',
        'Add waitFor: 5000 for JavaScript-rendered pages',
        'Try with formats: ["html"] to see the raw page structure',
      ],
      originalError: raw,
    };
  }

  if (matches(lower, ['spa_skeleton_detected', 'spa detected', 'javascript is required'])) {
    return {
      code: 'SPA_DETECTED',
      message: 'Page requires JavaScript rendering (SPA detected).',
      suggestions: [
        'Add waitFor: 5000 to allow JavaScript to render',
        'The engine will automatically retry with Playwright',
      ],
      originalError: raw,
    };
  }

  // --- Catch-all ---
  return {
    code: 'UNKNOWN_ERROR',
    message: `Scraping failed: ${truncateString(raw, 200)}`,
    suggestions: [
      'Try a different URL or format',
      'Use scorch_search as an alternative data source',
    ],
    originalError: raw,
  };
}

/** Normalize any error-like value to a string */
function normalizeErrorString(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (err instanceof Error) {
    // Include status code from Axios/fetch errors
    const axiosStatus = (err as any)?.response?.status;
    const status = (err as any)?.status || (err as any)?.statusCode || axiosStatus;
    const prefix = status ? `HTTP ${status}: ` : '';
    return `${prefix}${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    const s = JSON.stringify(err);
    return s || 'Unknown error';
  } catch {
    return String(err);
  }
}

/** Check if a lowered string contains any of the patterns */
function matches(lower: string, patterns: string[]): boolean {
  return patterns.some((p) => lower.includes(p));
}

/** Check if an error string refers to an HTTP status in a range */
function matchesStatusRange(lower: string, from: number, to: number): boolean {
  const statusMatch = lower.match(/(?:status\s*(?:code\s*)?|http\s*)(\d{3})/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    return code >= from && code <= to;
  }
  // Also check for bare 5xx patterns
  for (let s = from; s <= to; s++) {
    if (lower.includes(String(s))) return true;
  }
  return false;
}

/** Safely truncate a string for display */
function truncateString(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// Feature 2: Content Truncation
// ---------------------------------------------------------------------------

/**
 * Content fields that may need truncation.
 * Metadata, links, and structured data are NEVER truncated.
 */
const CONTENT_FIELDS = ['markdown', 'html', 'rawHtml'] as const;

/**
 * For crawl results: max fraction of total limit a single page can use.
 */
const SINGLE_PAGE_MAX_FRACTION = 0.3;

/**
 * Truncate a markdown/html string at the nearest paragraph or heading
 * boundary before the character limit.
 */
export function truncateAtBoundary(content: string, maxChars: number): { text: string; wasTruncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, wasTruncated: false };
  }

  // Search backward from maxChars for a good break point
  const searchWindow = content.slice(0, maxChars);

  // Priority 1: Last heading boundary (# at start of line)
  const headingMatch = searchWindow.lastIndexOf('\n#');
  // Priority 2: Last double newline (paragraph boundary)
  const paraMatch = searchWindow.lastIndexOf('\n\n');
  // Priority 3: Last single newline
  const lineMatch = searchWindow.lastIndexOf('\n');
  // Priority 4: Last sentence end
  const sentenceMatch = Math.max(
    searchWindow.lastIndexOf('. '),
    searchWindow.lastIndexOf('.\n'),
  );

  // Pick the best break point (prefer heading > paragraph > line > sentence)
  let breakPoint = -1;
  // Only use if it's in the last 30% of the window (don't cut too aggressively)
  const minBreak = Math.floor(maxChars * 0.7);

  if (headingMatch > minBreak) breakPoint = headingMatch;
  else if (paraMatch > minBreak) breakPoint = paraMatch;
  else if (lineMatch > minBreak) breakPoint = lineMatch;
  else if (sentenceMatch > minBreak) breakPoint = sentenceMatch + 1; // include the period
  else breakPoint = maxChars; // hard cut as last resort

  const truncated = content.slice(0, breakPoint).trimEnd();

  return { text: truncated, wasTruncated: true };
}

/**
 * Process a single scrape/crawl data object, truncating content fields
 * while preserving metadata and structured data.
 *
 * Returns the processed data and truncation metadata.
 */
export function truncateContent(
  data: unknown,
): { result: unknown; wasTruncated: boolean; originalLength: number } {
  if (MAX_CONTENT_CHARS <= 0) {
    const serialized = JSON.stringify(data, null, 2);
    return { result: data, wasTruncated: false, originalLength: serialized.length };
  }

  const serialized = JSON.stringify(data, null, 2);
  if (serialized.length <= MAX_CONTENT_CHARS) {
    return { result: data, wasTruncated: false, originalLength: serialized.length };
  }

  // Deep clone to avoid mutating the original
  const cloned = JSON.parse(serialized);

  let wasTruncated = false;

  // Handle single scrape result (has data.markdown, data.html, etc.)
  if (cloned && typeof cloned === 'object') {
    const target = cloned.data || cloned;

    for (const field of CONTENT_FIELDS) {
      if (typeof target[field] === 'string' && target[field].length > 0) {
        // Budget for this field: total limit minus overhead from other fields
        const otherFieldsSize = serialized.length - target[field].length;
        const fieldBudget = Math.max(
          MAX_CONTENT_CHARS - otherFieldsSize,
          Math.floor(MAX_CONTENT_CHARS * 0.5), // at least 50% of limit
        );

        if (target[field].length > fieldBudget) {
          const { text } = truncateAtBoundary(target[field], fieldBudget);
          const originalLen = target[field].length;
          target[field] = text + buildTruncationNotice(text.length, originalLen);
          wasTruncated = true;
        }
      }
    }

    // Handle crawl results (array of pages)
    if (Array.isArray(target)) {
      const result = truncateCrawlArray(target);
      return { result: cloned, wasTruncated: result.wasTruncated, originalLength: serialized.length };
    }

    // Add truncation metadata
    if (wasTruncated) {
      const meta = target.metadata || target;
      meta._truncated = true;
      meta._originalLength = serialized.length;
    }
  }

  return { result: cloned, wasTruncated, originalLength: serialized.length };
}

/**
 * Truncate a crawl result array: limit per-page content and total page count.
 */
function truncateCrawlArray(
  pages: any[],
): { wasTruncated: boolean } {
  if (pages.length === 0) return { wasTruncated: false };

  const perPageLimit = Math.floor(MAX_CONTENT_CHARS * SINGLE_PAGE_MAX_FRACTION);
  let wasTruncated = false;
  let totalSize = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page || typeof page !== 'object') continue;

    const target = page.data || page;

    for (const field of CONTENT_FIELDS) {
      if (typeof target[field] === 'string' && target[field].length > perPageLimit) {
        const { text } = truncateAtBoundary(target[field], perPageLimit);
        target[field] = text + buildTruncationNotice(text.length, target[field].length);
        wasTruncated = true;
      }
    }

    totalSize += JSON.stringify(page).length;

    // If total exceeds limit, truncate the array
    if (totalSize > MAX_CONTENT_CHARS && i < pages.length - 1) {
      const originalCount = pages.length;
      pages.length = i + 1;
      pages.push({
        _notice: `Showing ${i + 1} of ${originalCount} crawled pages. Use scorch_check_crawl_status with pagination to see more.`,
      });
      wasTruncated = true;
      break;
    }
  }

  return { wasTruncated };
}

/** Build a truncation notice for appending to content */
function buildTruncationNotice(shownChars: number, originalChars: number): string {
  return `\n\n---\n[Content truncated. Showing ~${Math.round(shownChars / 1000)}k of ~${Math.round(originalChars / 1000)}k characters.\nTo get specific information, try:\n- Use JSON format with a schema to extract only the data you need\n- Add onlyMainContent: true to exclude navigation/footers\n- Use scorch_map to find a more specific page URL]`;
}

// ---------------------------------------------------------------------------
// Feature 3: AI Summarization
// ---------------------------------------------------------------------------

/**
 * LRU cache for summarization results.
 * Key: sha256(url + first 1000 chars of markdown)
 * Value: { summary, timestamp }
 */
const summaryCache = new Map<string, { summary: string; timestamp: number; wordCount: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Sliding window for summarization rate limiting */
const summarizationTimestamps: number[] = [];

/** Word count helper */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Generate a cache key for summarization */
function summaryKey(url: string, markdown: string): string {
  const fingerprint = url + markdown.slice(0, 1000);
  return createHash('sha256').update(fingerprint).digest('hex');
}

/** Check if we can make another summarization call (rate limit) */
function canSummarize(): boolean {
  if (SUMMARIZE_MAX_PER_MINUTE <= 0) return false;
  const now = Date.now();
  const windowStart = now - 60_000;

  // Purge old entries
  while (summarizationTimestamps.length > 0 && summarizationTimestamps[0] < windowStart) {
    summarizationTimestamps.shift();
  }

  return summarizationTimestamps.length < SUMMARIZE_MAX_PER_MINUTE;
}

/** Record a summarization call for rate limiting */
function recordSummarization(): void {
  summarizationTimestamps.push(Date.now());
}

/** Evict oldest entries if cache exceeds max size */
function evictCache(): void {
  if (summaryCache.size <= SUMMARIZE_CACHE_SIZE) return;

  // Find and delete the oldest entries
  const entries = [...summaryCache.entries()].sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  );
  const toDelete = entries.slice(0, entries.length - SUMMARIZE_CACHE_SIZE);
  for (const [key] of toDelete) {
    summaryCache.delete(key);
  }
}

/**
 * Summarize markdown content using the Copilot SDK if available.
 * Falls back to truncation on failure or when no LLM is available.
 *
 * @param markdown - The full markdown content to potentially summarize
 * @param url - Source URL (used for cache key)
 * @param getCopilotClientFn - Function to get a CopilotClient instance
 * @param copilotToken - Optional per-user Copilot token
 * @returns Processed markdown with summarization metadata
 */
export async function summarizeIfNeeded(
  markdown: string,
  url: string,
  getCopilotClientFn?: (token?: string) => Promise<any>,
  copilotToken?: string,
): Promise<{
  markdown: string;
  summarized: boolean;
  meta?: Record<string, unknown>;
}> {
  // Check if summarization is disabled
  if (SUMMARIZE_AFTER_WORDS <= 0) {
    return { markdown, summarized: false };
  }

  const words = wordCount(markdown);
  if (words <= SUMMARIZE_AFTER_WORDS) {
    return { markdown, summarized: false };
  }

  // Check cache
  const key = summaryKey(url, markdown);
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return {
      markdown: cached.summary,
      summarized: true,
      meta: {
        _summarized: true,
        _originalWordCount: words,
        _summaryWordCount: cached.wordCount,
        _summarizedBy: SUMMARIZE_MODEL,
        _cachedResult: true,
      },
    };
  }

  // Check if Copilot client is available
  if (!getCopilotClientFn) {
    return { markdown, summarized: false };
  }

  // Check rate limit
  if (!canSummarize()) {
    return { markdown, summarized: false };
  }

  try {
    const client = await getCopilotClientFn(copilotToken);
    if (!client) {
      return { markdown, summarized: false };
    }

    const targetWords = Math.min(SUMMARIZE_AFTER_WORDS, Math.floor(words * 0.3));

    const sessionConfig: Record<string, unknown> = {
      model: SUMMARIZE_MODEL,
      systemMessage: {
        mode: 'replace',
        content: buildSummarizationPrompt(words, targetWords),
      },
    };

    const session = await client.createSession(sessionConfig);
    recordSummarization();

    try {
      const response = await session.sendAndWait({ prompt: markdown });

      // Extract content from response — handle multiple possible shapes
      let summary: string = '';
      if (response && typeof response === 'object') {
        const r = response as Record<string, unknown>;
        // Shape 1: { data: { content: "..." } } (most common)
        if (r.data && typeof r.data === 'object') {
          const d = r.data as Record<string, unknown>;
          if (typeof d.content === 'string') summary = d.content;
          else if (typeof d.text === 'string') summary = d.text;
        }
        // Shape 2: { content: "..." }
        if (!summary && typeof r.content === 'string') summary = r.content;
        // Shape 3: { text: "..." }
        if (!summary && typeof r.text === 'string') summary = r.text;
        // Shape 4: { message: { content: "..." } }
        if (!summary && r.message && typeof r.message === 'object') {
          const m = r.message as Record<string, unknown>;
          if (typeof m.content === 'string') summary = m.content;
        }
      } else if (typeof response === 'string') {
        summary = response;
      }

      if (!summary || summary.length < 50) {
        // Summarization returned garbage — fall back
        console.error(`[Summarization] Response too short or empty (${summary.length} chars), response keys: ${response ? Object.keys(response as object).join(', ') : 'null'}`);
        return { markdown, summarized: false };
      }

      const summaryWords = wordCount(summary);

      // Cache the result
      summaryCache.set(key, {
        summary,
        timestamp: Date.now(),
        wordCount: summaryWords,
      });
      evictCache();

      return {
        markdown: summary,
        summarized: true,
        meta: {
          _summarized: true,
          _originalWordCount: words,
          _summaryWordCount: summaryWords,
          _summarizedBy: SUMMARIZE_MODEL,
        },
      };
    } finally {
      try { await session.destroy(); } catch { /* ignore cleanup */ }
    }
  } catch (err) {
    // Summarization failed — fall back silently but log for debugging
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : '';
    console.error(`[Summarization] Failed for ${url}: ${errMsg}`);
    if (errStack) console.error(`[Summarization] Stack: ${errStack}`);
    return {
      markdown,
      summarized: false,
      meta: { _summarizationFailed: true, _summarizationError: errMsg },
    };
  }
}

/** Build the system prompt for content summarization */
function buildSummarizationPrompt(originalWords: number, targetWords: number): string {
  return `You are a content summarizer for a web scraping tool. 
Summarize the following web page content, preserving:
- ALL factual data (numbers, dates, names, prices, specifications)
- Key arguments, conclusions, and findings
- Structural organization (use headings, lists)
- Any code snippets or technical details

Do NOT:
- Add opinions or analysis
- Omit specific data points (numbers, names, URLs)
- Change the meaning or emphasis of the content
- Add any preamble like "Here is a summary" — just output the summary directly

Original content word count: ${originalWords}
Target summary: ~${targetWords} words`;
}

// ---------------------------------------------------------------------------
// Combined Processing Pipeline
// ---------------------------------------------------------------------------

/**
 * Safe wrapper for tool execution. Catches errors and returns
 * mapped, LLM-friendly error responses.
 */
export async function safeExecute(
  fn: () => Promise<string>,
  context: { tool: string; url?: string },
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapError(err);
    console.error(`[${context.tool}] ${mapped.code}`, {
      url: context.url,
      original: mapped.originalError,
    });
    return JSON.stringify(
      {
        success: false,
        error: mapped.message,
        code: mapped.code,
        suggestions: mapped.suggestions,
      },
      null,
      2,
    );
  }
}

/**
 * Process a successful response: truncate content if needed and
 * optionally summarize via Copilot SDK.
 *
 * Replaces the old `asText()` function.
 */
export async function processResponse(
  data: unknown,
  options?: {
    url?: string;
    getCopilotClientFn?: (token?: string) => Promise<any>;
    copilotToken?: string;
    /** Skip summarization (e.g. for JSON extraction, search results) */
    skipSummarization?: boolean;
  },
): Promise<string> {
  // Step 1: Try AI summarization on markdown content
  if (!options?.skipSummarization && options?.getCopilotClientFn) {
    const md = extractMarkdown(data);
    if (md && wordCount(md) > SUMMARIZE_AFTER_WORDS && SUMMARIZE_AFTER_WORDS > 0) {
      const result = await summarizeIfNeeded(
        md,
        options.url || '',
        options.getCopilotClientFn,
        options.copilotToken,
      );
      if (result.summarized) {
        // Replace the markdown in the data with the summary
        const updated = injectMarkdown(data, result.markdown, result.meta || {});
        return JSON.stringify(updated, null, 2);
      }
    }
  }

  // Step 2: Content truncation
  const { result, wasTruncated } = truncateContent(data);
  return JSON.stringify(result, null, 2);
}

/**
 * Simple `asText` replacement for backward compatibility.
 * Applies truncation but not summarization.
 */
export function processResponseSync(data: unknown): string {
  const { result } = truncateContent(data);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Helpers for extracting/injecting markdown from nested response objects
// ---------------------------------------------------------------------------

/** Extract markdown content from a scrape response, wherever it may be nested */
function extractMarkdown(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // Direct: data.markdown
  if (typeof obj.markdown === 'string') return obj.markdown;

  // Nested: data.data.markdown
  if (obj.data && typeof obj.data === 'object') {
    const inner = obj.data as Record<string, unknown>;
    if (typeof inner.markdown === 'string') return inner.markdown;
  }

  return null;
}

/** Replace the markdown field in a response and merge metadata */
function injectMarkdown(
  data: unknown,
  newMarkdown: string,
  meta: Record<string, unknown>,
): unknown {
  const serialized = JSON.stringify(data);
  const cloned = JSON.parse(serialized);

  if (typeof cloned.markdown === 'string') {
    cloned.markdown = newMarkdown;
    Object.assign(cloned.metadata || cloned, meta);
    return cloned;
  }

  if (cloned.data && typeof cloned.data === 'object') {
    if (typeof cloned.data.markdown === 'string') {
      cloned.data.markdown = newMarkdown;
      Object.assign(cloned.data.metadata || cloned.data, meta);
      return cloned;
    }
  }

  return cloned;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
export { MAX_CONTENT_CHARS, SUMMARIZE_AFTER_WORDS, SUMMARIZE_MODEL };
export { summaryCache, summarizationTimestamps };
