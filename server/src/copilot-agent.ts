/**
 * Copilot SDK Agent Engine
 *
 * Replaces the proprietary cloud-only agent with a Copilot SDK-powered
 * agent that uses scorchcrawl tools (scrape, search, map, extract) as custom tools.
 *
 * Model selection is controlled via COPILOT_AGENT_MODELS environment variable.
 */

import { CopilotClient, type Tool as CopilotTool } from '@github/copilot-sdk';
import type ScorchClient from './lib/scorch-client/index.js';
import { v4 as uuidv4 } from 'uuid';
import {
  RateLimitGuard,
  buildRateLimitConfig,
  buildErrorHook,
  findStaleJobs,
  type RateLimitResult,
} from './rate-limiter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Allowed model identifiers (from env COPILOT_AGENT_MODELS) */
  allowedModels: string[];
  /** Default model to use when none specified */
  defaultModel: string;
  /** Optional BYOK provider config */
  provider?: {
    type: 'openai' | 'azure' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
  };
}

export interface AgentJobRequest {
  prompt: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  /** Override which model the agent uses (must be in allowedModels) */
  model?: string;
}

export interface AgentJob {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  prompt: string;
  createdAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  progress?: string;
  /** Internal: user key for concurrency tracking (not exposed in API) */
  _userKey?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse COPILOT_AGENT_MODELS env var into an array of model names */
export function parseAllowedModels(): string[] {
  const envModels = process.env.COPILOT_AGENT_MODELS;
  if (!envModels) {
    // Defaults from user requirements
    return ['gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'grok-code-fast-1'];
  }
  return envModels
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Get default model (first in list or from env) */
export function getDefaultModel(): string {
  const defaultFromEnv = process.env.COPILOT_AGENT_DEFAULT_MODEL;
  if (defaultFromEnv) return defaultFromEnv.trim();
  const allowed = parseAllowedModels();
  return allowed[0] || 'gpt-4.1';
}

/** Build the agent configuration from environment */
export function buildAgentConfig(): AgentConfig {
  const config: AgentConfig = {
    allowedModels: parseAllowedModels(),
    defaultModel: getDefaultModel(),
  };

  // Optional BYOK provider
  if (process.env.COPILOT_AGENT_PROVIDER_TYPE && process.env.COPILOT_AGENT_PROVIDER_BASE_URL) {
    config.provider = {
      type: process.env.COPILOT_AGENT_PROVIDER_TYPE as 'openai' | 'azure' | 'anthropic',
      baseUrl: process.env.COPILOT_AGENT_PROVIDER_BASE_URL,
      apiKey: process.env.COPILOT_AGENT_PROVIDER_API_KEY,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// ScorchCrawl Tools for Copilot SDK Agent
// ---------------------------------------------------------------------------

/**
 * Build the custom tools that the Copilot SDK agent will have access to.
 * These wrap the scraping engine client methods so the agent can scrape, search,
 * map, crawl, and extract data from the web.
 */
function buildScrapingTools(client: ScorchClient, origin: string): CopilotTool[] {
  return [
    {
      name: 'web_scrape',
      description:
        'Scrape content from a single URL. Returns markdown content by default. ' +
        'Use formats parameter to request JSON extraction with a schema, or other formats like html, screenshot, links.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to scrape' },
          formats: {
            type: 'array',
            description: 'Output formats: "markdown", "html", "links", or JSON extraction object',
            items: { type: 'string' },
          },
          onlyMainContent: {
            type: 'boolean',
            description: 'Extract only the main content, excluding nav/footer/etc',
          },
          waitFor: {
            type: 'number',
            description: 'Wait time in ms for JS-rendered pages (default 0)',
          },
        },
        required: ['url'],
      },
      handler: async (args: unknown) => {
        try {
          const a = args as Record<string, unknown>;
          const { url, ...opts } = a;
          const res = await client.scrape(String(url), {
            ...opts,
            origin,
          } as any);
          return {
            textResultForLlm: JSON.stringify(res, null, 2),
            resultType: 'success' as const,
          };
        } catch (err: any) {
          return {
            textResultForLlm: `Scrape failed: ${err.message || err}`,
            resultType: 'failure' as const,
            error: String(err.message || err),
          };
        }
      },
    } as CopilotTool,
    {
      name: 'web_search',
      description:
        'Search the web for information. Returns search results with titles, URLs, and snippets. ' +
        'Supports search operators like site:, inurl:, intitle:, and quoted phrases.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default 5)',
          },
        },
        required: ['query'],
      },
      handler: async (args: unknown) => {
        try {
          const a = args as Record<string, unknown>;
          const { query, ...opts } = a;
          const res = await client.search(String(query), {
            ...opts,
            origin,
          } as any);
          return {
            textResultForLlm: JSON.stringify(res, null, 2),
            resultType: 'success' as const,
          };
        } catch (err: any) {
          return {
            textResultForLlm: `Search failed: ${err.message || err}`,
            resultType: 'failure' as const,
            error: String(err.message || err),
          };
        }
      },
    } as CopilotTool,
    {
      name: 'web_map',
      description:
        'Map a website to discover all indexed URLs. Use the search parameter to find specific pages. ' +
        'Useful when you need to find the right page before scraping.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The website URL to map' },
          search: {
            type: 'string',
            description: 'Optional search query to filter URLs',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of URLs to return',
          },
        },
        required: ['url'],
      },
      handler: async (args: unknown) => {
        try {
          const a = args as Record<string, unknown>;
          const { url, ...opts } = a;
          const res = await client.map(String(url), {
            ...opts,
            origin,
          } as any);
          return {
            textResultForLlm: JSON.stringify(res, null, 2),
            resultType: 'success' as const,
          };
        } catch (err: any) {
          return {
            textResultForLlm: `Map failed: ${err.message || err}`,
            resultType: 'failure' as const,
            error: String(err.message || err),
          };
        }
      },
    } as CopilotTool,
    {
      name: 'web_extract',
      description:
        'Extract structured information from web pages using LLM capabilities. ' +
        'Provide URLs, a prompt describing what to extract, and an optional JSON schema for the output format.',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs to extract information from',
          },
          prompt: {
            type: 'string',
            description: 'Description of what information to extract',
          },
          schema: {
            type: 'object',
            description: 'JSON schema for structured output',
          },
        },
        required: ['urls'],
      },
      handler: async (args: unknown) => {
        try {
          const a = args as Record<string, unknown>;
          const res = await (client as any).extract({
            urls: a.urls,
            prompt: a.prompt,
            schema: a.schema,
            origin,
          });
          return {
            textResultForLlm: JSON.stringify(res, null, 2),
            resultType: 'success' as const,
          };
        } catch (err: any) {
          return {
            textResultForLlm: `Extract failed: ${err.message || err}`,
            resultType: 'failure' as const,
            error: String(err.message || err),
          };
        }
      },
    } as CopilotTool,
  ];
}

// ---------------------------------------------------------------------------
// Agent Engine
// ---------------------------------------------------------------------------

/** In-memory store for agent jobs */
const agentJobs = new Map<string, AgentJob>();

// ---------------------------------------------------------------------------
// Rate Limiting & Concurrency Guard (singleton)
// ---------------------------------------------------------------------------
const rateLimitGuard = new RateLimitGuard(buildRateLimitConfig());

/** Periodic stale-job reaper */
setInterval(() => {
  const staleIds = findStaleJobs(agentJobs.values(), rateLimitGuard.config.staleJobTimeoutMs);
  for (const id of staleIds) {
    const job = agentJobs.get(id);
    if (job) {
      job.status = 'failed';
      job.error = `Job timed out after ${rateLimitGuard.config.staleJobTimeoutMs / 1000}s without completing.`;
      job.completedAt = Date.now();
      // Release concurrency slot (use empty-string key for unknown user)
      rateLimitGuard.release(job._userKey || '');
      console.warn(`[RateLimit] Reaped stale job ${id}`);
    }
  }
}, rateLimitGuard.config.gcIntervalMs);

/**
 * Cache of CopilotClient instances keyed by GitHub token.
 * The empty-string key holds the server-wide (env-based) client.
 * Entries are evicted after MAX_CLIENT_AGE_MS of inactivity.
 */
const clientCache = new Map<string, { client: CopilotClient; lastUsed: number }>();
const MAX_CLIENT_AGE_MS = 30 * 60 * 1000; // 30 min

/** Periodically purge stale clients */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clientCache) {
    if (now - entry.lastUsed > MAX_CLIENT_AGE_MS) {
      try { entry.client.stop(); } catch { /* ignore */ }
      clientCache.delete(key);
    }
  }
}, 5 * 60 * 1000); // every 5 min

/**
 * Get or create a CopilotClient for the given token.
 * If `userToken` is provided it takes priority; otherwise
 * the server-wide GITHUB_TOKEN env var is used.
 */
async function getCopilotClient(userToken?: string): Promise<CopilotClient> {
  const cacheKey = userToken || '';
  const existing = clientCache.get(cacheKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  const clientOpts: Record<string, unknown> = {};

  // Allow configuring Copilot CLI path
  if (process.env.COPILOT_CLI_PATH) {
    clientOpts.cliPath = process.env.COPILOT_CLI_PATH;
  }
  // Allow connecting to external CLI server
  if (process.env.COPILOT_CLI_URL) {
    clientOpts.cliUrl = process.env.COPILOT_CLI_URL;
  }

  // Per-user token takes priority, then env var
  const token = userToken || process.env.GITHUB_TOKEN;
  if (token) {
    clientOpts.githubToken = token;
  }

  const client = new CopilotClient(clientOpts as any);
  clientCache.set(cacheKey, { client, lastUsed: Date.now() });
  return client;
}

/**
 * Start a new agent job. Returns immediately with a job ID.
 * The agent runs asynchronously in the background.
 *
 * Rate limiting is enforced before the job is accepted:
 *   1. Per-user and global concurrency limits
 *   2. Sliding-window request rate
 *   3. Proactive Copilot quota check
 */
export async function startAgent(
  request: AgentJobRequest,
  scrapingClient: ScorchClient,
  origin: string,
  config: AgentConfig,
  copilotToken?: string
): Promise<{ id: string; status: string; rateLimited?: boolean; retryAfterSeconds?: number; error?: string }> {
  const jobId = uuidv4();
  const userKey = copilotToken || '__server__';

  // --- Rate limit gate ---
  const gate = rateLimitGuard.check(userKey);
  if (!gate.allowed) {
    return {
      id: jobId,
      status: 'rate_limited',
      rateLimited: true,
      retryAfterSeconds: gate.retryAfterSeconds,
      error: gate.reason,
    };
  }

  // Validate model
  const requestedModel = request.model || config.defaultModel;
  if (!config.allowedModels.includes(requestedModel)) {
    return {
      id: jobId,
      status: 'failed',
      error: `Model "${requestedModel}" is not in the allowed list: ${config.allowedModels.join(', ')}`,
    };
  }

  // --- Acquire concurrency slot & record request ---
  rateLimitGuard.acquire(userKey);

  // Create the job entry
  const job: AgentJob = {
    id: jobId,
    status: 'processing',
    prompt: request.prompt,
    createdAt: Date.now(),
    _userKey: userKey,
  };
  agentJobs.set(jobId, job);

  // Kick off the agent asynchronously
  runAgentJob(job, request, scrapingClient, origin, config, requestedModel, copilotToken).catch(
    (err) => {
      job.status = 'failed';
      job.error = String(err.message || err);
      job.completedAt = Date.now();
    }
  ).finally(() => {
    // Always release the concurrency slot when the job finishes
    rateLimitGuard.release(userKey);
  });

  return { id: jobId, status: 'processing' };
}

/**
 * Get the status of an agent job.
 */
export function getAgentStatus(jobId: string): AgentJob | null {
  return agentJobs.get(jobId) || null;
}

/**
 * Run an agent job using the Copilot SDK.
 */
async function runAgentJob(
  job: AgentJob,
  request: AgentJobRequest,
  scrapingClient: ScorchClient,
  origin: string,
  config: AgentConfig,
  model: string,
  copilotToken?: string
): Promise<void> {
  try {
    job.progress = 'Initializing Copilot SDK agent...';

    const client = await getCopilotClient(copilotToken);
    const tools = buildScrapingTools(scrapingClient, origin);

    // Build session config
    const sessionConfig: Record<string, unknown> = {
      model,
      tools,
      // Disable all built-in tools - we only want our scorchcrawl tools
      availableTools: tools.map((t) => t.name),
      systemMessage: {
        mode: 'replace',
        content: buildSystemPrompt(request),
      },
    };

    // Add BYOK provider if configured
    if (config.provider) {
      sessionConfig.provider = {
        type: config.provider.type,
        baseUrl: config.provider.baseUrl,
        ...(config.provider.apiKey && { apiKey: config.provider.apiKey }),
      };
    }

    job.progress = `Creating agent session with model: ${model}`;
    const session = await client.createSession(sessionConfig as any);

    // Register error hook for intelligent retry/abort decisions
    try {
      const errorHook = buildErrorHook(job.id);
      if (typeof (session as any).registerHooks === 'function') {
        (session as any).registerHooks({ onErrorOccurred: errorHook });
      }
    } catch {
      // Hooks may not be supported in all SDK versions — non-fatal
    }

    // Listen for quota snapshots from assistant.usage events
    try {
      const userKey = copilotToken || '__server__';
      (session as any).on?.('assistant.usage', (event: any) => {
        const snapshots = event?.data?.quotaSnapshots || event?.quotaSnapshots;
        if (snapshots) {
          // Take the first available quota category (usually 'chat')
          const snap = snapshots.chat || Object.values(snapshots)[0] as any;
          if (snap) {
            rateLimitGuard.quota.update(userKey, {
              remainingPercent: snap.remainingPercentage ?? snap.percent_remaining ?? 100,
              usedRequests: snap.usedRequests ?? snap.remaining ?? 0,
              entitlementRequests: snap.entitlementRequests ?? snap.entitlement ?? -1,
              isUnlimited: snap.isUnlimitedEntitlement ?? snap.unlimited ?? false,
              resetDate: snap.resetDate ?? undefined,
            });
          }
        }
      });
    } catch {
      // Event subscription may not be supported — non-fatal
    }

    try {
      job.progress = 'Agent is researching...';

      // Build the user prompt
      let userPrompt = request.prompt;
      if (request.urls && request.urls.length > 0) {
        userPrompt += `\n\nFocus on these URLs:\n${request.urls.map((u) => `- ${u}`).join('\n')}`;
      }
      if (request.schema) {
        userPrompt += `\n\nReturn the results in this JSON schema format:\n${JSON.stringify(request.schema, null, 2)}`;
      }

      // Send the prompt and wait for completion
      const response = await session.sendAndWait({ prompt: userPrompt });

      job.status = 'completed';
      job.completedAt = Date.now();
      job.result = {
        success: true,
        data: response?.data?.content || 'No response generated',
        model,
      };
    } finally {
      // Clean up the session
      try {
        await session.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (err: any) {
    job.status = 'failed';
    job.error = `Agent error: ${err.message || err}`;
    job.completedAt = Date.now();
  }
}

/**
 * Build the system prompt for the agent session.
 */
function buildSystemPrompt(request: AgentJobRequest): string {
  return `You are an autonomous web research agent. Your job is to browse the internet, search for information, navigate through pages, and extract structured data based on the user's query.

You have access to the following web tools:
- **web_search**: Search the web for information. Start with this for broad queries.
- **web_scrape**: Scrape content from a specific URL. Use this to get page content.
- **web_map**: Map a website to discover all its URLs. Use this to find specific pages on a site.
- **web_extract**: Extract structured data from URLs using LLM. Use this for structured extraction.

## Research Strategy

1. **Start with search** to find relevant URLs if no specific URLs are provided.
2. **Map websites** to discover relevant pages when you need to explore a site's structure.
3. **Scrape specific pages** to get their content.
4. **Extract structured data** when you need specific fields from pages.

## Guidelines

- Be thorough: check multiple sources when possible.
- Be efficient: don't scrape pages that aren't relevant.
- If a page fails to load or returns empty content, try an alternative approach.
- Always provide your final answer with all the information you gathered.
- If the user provided a JSON schema, format your final response to match that schema.
- Cite your sources with URLs when providing information.

## Important

- You MUST use the provided tools to gather information. Do not make up or hallucinate data.
- If you cannot find the requested information after reasonable effort, say so clearly.
- Provide complete, well-structured responses.`;
}

/**
 * Gracefully shut down the Copilot client.
 */
export async function shutdownAgent(): Promise<void> {
  rateLimitGuard.shutdown();
  for (const [, entry] of clientCache) {
    try {
      await entry.client.stop();
    } catch {
      // Ignore shutdown errors
    }
  }
  clientCache.clear();
}

/**
 * Get current rate limiting stats (for observability / health checks).
 */
export function getRateLimitStats(): Record<string, unknown> {
  return rateLimitGuard.stats();
}
