/**
 * Local Scraper — fetches pages through the LOCAL machine's IP and converts to markdown.
 * Used when SCORCHCRAWL_LOCAL_PROXY=true is set, so scraping traffic exits through
 * the user's residential IP instead of the server's datacenter IP.
 *
 * Falls back to the remote ScorchCrawl API for features that need server-side
 * processing (search, crawl, extract, agent, JSON schema extraction).
 *
 * SPA Detection:
 *   When the fetched HTML looks like a Single Page Application shell
 *   (minimal text, loading indicators, heavy JS bundles), the scraper returns
 *   a `SPA_SKELETON_DETECTED` error so the caller can retry via the engine's
 *   Playwright-backed scraper which executes JavaScript.
 */

import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

// Lazy-init singleton
let _turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });

    // Strip script/style/nav/footer tags
    _turndown.remove(['script', 'style', 'noscript', 'iframe']);
  }
  return _turndown;
}

export interface LocalScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    links?: string[];
    metadata: {
      title: string;
      description?: string;
      language?: string;
      sourceURL: string;
      url: string;
      statusCode: number;
      contentType?: string;
      proxyUsed: string;
    };
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// SPA / JS-rendered page detection
// ---------------------------------------------------------------------------

/**
 * Common phrases found in SPA shell HTML before JS hydrates the page.
 * Matched case-insensitively against the visible body text.
 */
const SPA_LOADING_PATTERNS = [
  'loading...',
  'loading…',
  'please wait',
  'just a moment',
  'checking your browser',
  'one moment please',
  'redirecting',
  'enable javascript',
  'javascript is required',
  'javascript must be enabled',
  'this app requires javascript',
  'you need to enable javascript',
  'noscript',
];

/**
 * CSS selectors whose sole presence (with no other meaningful content)
 * strongly indicates a JS-only SPA shell.
 */
const SPA_ROOT_SELECTORS = [
  '#root',          // React (CRA, Vite)
  '#app',           // Vue
  '#__next',        // Next.js
  '#__nuxt',        // Nuxt
  '#svelte',        // SvelteKit
  'app-root',       // Angular
  '#___gatsby',     // Gatsby
  '#main-app',      // misc
];

/** Minimum characters of visible text for a page to be considered "real" content. */
const MIN_MEANINGFUL_TEXT_LENGTH = 200;

/** Ratio: if (script bytes / total HTML bytes) exceeds this, it's likely a SPA shell. */
const SCRIPT_HEAVY_RATIO = 0.65;

/**
 * Inspect raw HTML + extracted text to decide if the page is a SPA shell
 * that hasn't been hydrated (no JS execution happened).
 *
 * Returns a short reason string if SPA-like, or `null` if the page looks real.
 */
export function detectSPASkeleton(
  rawHtml: string,
  _bodyText: string,
  $: cheerio.CheerioAPI,
): string | null {
  // Get visible text only (strip script, style, noscript content)
  const $clone = cheerio.load($.html());
  $clone('script, style, noscript').remove();
  const visibleText = $clone('body').text() || '';
  const trimmedText = visibleText.replace(/\s+/g, ' ').trim();
  const lowerText = trimmedText.toLowerCase();

  // 1. Very little visible text — likely a shell that JS would populate
  if (trimmedText.length < MIN_MEANINGFUL_TEXT_LENGTH) {
    // Check for SPA root containers
    for (const sel of SPA_ROOT_SELECTORS) {
      const el = $(sel);
      if (el.length > 0) {
        const innerText = el.text().replace(/\s+/g, ' ').trim();
        if (innerText.length < MIN_MEANINGFUL_TEXT_LENGTH) {
          return `SPA root container "${sel}" with minimal content (${innerText.length} chars)`;
        }
      }
    }

    // Check for loading phrases in the sparse text
    for (const pattern of SPA_LOADING_PATTERNS) {
      if (lowerText.includes(pattern)) {
        return `Loading indicator detected: "${pattern}"`;
      }
    }

    // Even without a known root, < 50 chars of body text is almost certainly a shell
    if (trimmedText.length < 50) {
      return `Near-empty body text (${trimmedText.length} chars)`;
    }
  }

  // 2. Loading phrases in an otherwise short page (< 500 chars)
  if (trimmedText.length < 500) {
    for (const pattern of SPA_LOADING_PATTERNS) {
      if (lowerText.includes(pattern)) {
        return `Short page with loading indicator: "${pattern}"`;
      }
    }
  }

  // 3. Script-heavy pages: mostly <script> tags, very little content
  const scriptContent = $('script')
    .toArray()
    .reduce((sum, el) => sum + ($(el).html()?.length || 0), 0);
  const htmlLength = rawHtml.length;
  if (
    htmlLength > 1000 &&
    scriptContent / htmlLength > SCRIPT_HEAVY_RATIO &&
    trimmedText.length < MIN_MEANINGFUL_TEXT_LENGTH
  ) {
    return `Script-heavy page (${Math.round((scriptContent / htmlLength) * 100)}% scripts, ${trimmedText.length} chars text)`;
  }

  return null;
}

/**
 * Fetches a URL locally (through the user's IP) and converts to markdown.
 */
export async function localScrape(
  url: string,
  options: {
    formats?: (string | { type: string })[];
    onlyMainContent?: boolean;
    includeTags?: string[];
    excludeTags?: string[];
    waitFor?: number;
    timeout?: number;
    skipTlsVerification?: boolean;
    headers?: Record<string, string>;
  } = {}
): Promise<LocalScrapeResult> {
  const timeout = options.timeout || 30000;

  // Determine requested formats
  const formats = (options.formats || ['markdown']).map((f) =>
    typeof f === 'string' ? f : f.type
  );
  const wantMarkdown = formats.includes('markdown');
  const wantHtml = formats.includes('html');
  const wantRawHtml = formats.includes('rawHtml');
  const wantLinks = formats.includes('links');

  // Needs JSON/screenshot/branding? Can't do locally — return null to fall back
  const needsServerSide = formats.some(
    (f) =>
      f === 'json' || f === 'screenshot' || f === 'branding' || f === 'summary'
  );
  if (needsServerSide) {
    return { success: false, error: 'FORMAT_NEEDS_SERVER' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        ...(options.headers || {}),
      },
      redirect: 'follow',
    };

    // Node 18+ native TLS rejection control
    if (options.skipTlsVerification) {
      (fetchOptions as any).dispatcher = undefined; // handled below
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    if (options.skipTlsVerification) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }

    const rawHtml = await response.text();
    const statusCode = response.status;
    const contentType =
      response.headers.get('content-type') || 'text/html';

    // Parse with Cheerio
    const $ = cheerio.load(rawHtml);

    // Extract metadata
    const title =
      $('title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';
    const language = $('html').attr('lang') || '';

    // Remove unwanted elements if onlyMainContent
    if (options.onlyMainContent) {
      $(
        'nav, header, footer, aside, .sidebar, .menu, .navigation, .breadcrumb, .cookie-banner, .ad, .advertisement, [role="navigation"], [role="banner"], [role="complementary"]'
      ).remove();
    }

    // Apply excludeTags
    if (options.excludeTags?.length) {
      $(options.excludeTags.join(', ')).remove();
    }

    // Get the target HTML content
    let targetHtml: string;
    if (options.includeTags?.length) {
      targetHtml = options.includeTags
        .map((sel) => $(sel).html() || '')
        .filter(Boolean)
        .join('\n');
    } else if (options.onlyMainContent) {
      // Try to find main content area
      const mainSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.main-content',
        '.content',
        '#content',
        '#main',
      ];
      let mainHtml = '';
      for (const sel of mainSelectors) {
        const el = $(sel).first();
        if (el.length && (el.html()?.length || 0) > 100) {
          mainHtml = el.html() || '';
          break;
        }
      }
      targetHtml = mainHtml || $('body').html() || rawHtml;
    } else {
      targetHtml = $('body').html() || rawHtml;
    }

    // Build response
    const data: LocalScrapeResult['data'] = {
      metadata: {
        title,
        description: description || undefined,
        language: language || undefined,
        sourceURL: url,
        url: response.url || url,
        statusCode,
        contentType,
        proxyUsed: 'local',
      },
    };

    if (wantMarkdown) {
      data.markdown = getTurndown().turndown(targetHtml);
    }
    if (wantHtml) {
      data.html = targetHtml;
    }
    if (wantRawHtml) {
      data.rawHtml = rawHtml;
    }
    if (wantLinks) {
      const links: string[] = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            links.push(new URL(href, url).href);
          } catch {
            links.push(href);
          }
        }
      });
      data.links = [...new Set(links)];
    }

    // --- SPA detection: check if the fetched content is a JS-only shell ---
    const bodyText = $('body').text() || '';
    const spaReason = detectSPASkeleton(rawHtml, bodyText, $);
    if (spaReason) {
      return { success: false, error: 'SPA_SKELETON_DETECTED', data };
    }

    return { success: true, data };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: `Timeout after ${timeout}ms` };
    }
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Check if local proxy mode is enabled.
 * Controlled by:
 *   - SCORCHCRAWL_LOCAL_PROXY=true env var
 *   - ?localProxy=true query param in SCORCHCRAWL_API_URL
 */
export function isLocalProxyEnabled(): boolean {
  // Check env var
  if (
    process.env.SCORCHCRAWL_LOCAL_PROXY?.toLowerCase() === 'true' ||
    process.env.SCORCHCRAWL_LOCAL_PROXY === '1'
  ) {
    return true;
  }

  // Check URL query param
  const apiUrl = process.env.SCORCHCRAWL_API_URL;
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      if (
        parsed.searchParams.get('localProxy') === 'true' ||
        parsed.searchParams.get('localProxy') === '1'
      ) {
        return true;
      }
    } catch {
      // ignore invalid URL
    }
  }

  return false;
}

/**
 * Returns SCORCHCRAWL_API_URL without the localProxy query param
 * (so the scraping SDK doesn't pass it to the API).
 */
export function getCleanApiUrl(): string | undefined {
  const apiUrl = process.env.SCORCHCRAWL_API_URL;
  if (!apiUrl) return undefined;

  try {
    const parsed = new URL(apiUrl);
    parsed.searchParams.delete('localProxy');
    const cleaned = parsed.toString();
    // Remove trailing ? if no other params
    return cleaned.replace(/\?$/, '');
  } catch {
    return apiUrl;
  }
}
