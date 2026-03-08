import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  createSandboxClient,
  Workspace,
  CodeContext,
  Execution,
  SandboxClient,
} from "../../lib/sandbox-client";
import {
  insertBrowserSession,
  getBrowserSession,
  listBrowserSessions,
  updateBrowserSessionActivity,
  updateBrowserSessionStatus,
  BrowserSessionRow,
} from "../../lib/browser-sessions";
import { RequestWithAuth } from "./types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttlTotal: z.number().min(30).max(3600).default(300),
  ttlWithoutActivity: z.number().min(10).max(3600).optional(),
  streamWebView: z.boolean().default(false),
});

type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

interface BrowserCreateResponse {
  success: boolean;
  id?: string;
  cdpUrl?: string;
  error?: string;
}

const browserExecuteRequestSchema = z.object({
  id: z.string(),
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "js"]).default("python"),
});

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  result?: string;
  error?: string;
}

const browserDeleteRequestSchema = z.object({
  id: z.string(),
});

type BrowserDeleteRequest = z.infer<typeof browserDeleteRequestSchema>;

interface BrowserDeleteResponse {
  success: boolean;
  error?: string;
}

interface BrowserListResponse {
  success: boolean;
  sessions?: Array<{
    id: string;
    status: string;
    cdpUrl: string;
    streamWebView: boolean;
    createdAt: string;
    lastActivity: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSandboxClient(): SandboxClient {
  return createSandboxClient({
    baseUrl: config.SANDBOX_API_URL!,
    podUrlTemplate: config.SANDBOX_POD_URL_TEMPLATE,
    headlessService: config.SANDBOX_HEADLESS_SERVICE,
  });
}

/**
 * Extract the printable output from a sandbox Execution result.
 */
function executionToString(exec: Execution): string {
  return exec.text ?? "";
}

/**
 * Reconstruct a CodeContext from stored IDs so we can run code against
 * a session that was persisted in Supabase (not held in memory).
 */
function reconstructContext(
  client: SandboxClient,
  row: BrowserSessionRow,
): CodeContext {
  return new CodeContext(client, row.workspace_id, row.context_id);
}

/**
 * Reconstruct a Workspace from stored IDs.
 */
function reconstructWorkspace(
  client: SandboxClient,
  row: BrowserSessionRow,
): Workspace {
  return new Workspace(client, row.workspace_id);
}

/**
 * Destroy the underlying browser resources (CDP, sandbox workspace) for a
 * session row and mark it as destroyed in Supabase.
 */
async function destroySession(row: BrowserSessionRow): Promise<void> {
  const logger = _logger.child({
    sessionId: row.id,
    browserId: row.browser_id,
    module: "browser",
  });

  try {
    const client = getSandboxClient();
    const ctx = reconstructContext(client, row);
    const workspace = reconstructWorkspace(client, row);

    // Best-effort: tell the sandbox to close the browser
    await ctx.runCode("await browser.close()").catch(() => {});

    // Tear down the CDP session on fire-engine
    if (config.FIRE_ENGINE_BETA_URL) {
      await fetch(
        `${config.FIRE_ENGINE_BETA_URL}/cdp-session/${row.browser_id}`,
        { method: "DELETE" },
      ).catch(() => {});
    }

    // Destroy the sandbox workspace
    await workspace.destroy().catch(() => {});

    logger.info("Browser session destroyed");
  } catch (err) {
    logger.warn("Error while destroying browser session", { error: err });
  } finally {
    await updateBrowserSessionStatus(row.id, "destroyed");
  }
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function browserCreateController(
  req: RequestWithAuth<{}, BrowserCreateResponse, BrowserCreateRequest>,
  res: Response<BrowserCreateResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  const sessionId = uuidv7();
  const logger = _logger.child({
    sessionId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserCreateController",
  });

  req.body = browserCreateRequestSchema.parse(req.body);

  const { ttlTotal, ttlWithoutActivity, streamWebView } = req.body;

  if (!config.FIRE_ENGINE_BETA_URL) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (FIRE_ENGINE_BETA_URL is missing).",
    });
  }

  if (!config.SANDBOX_API_URL) {
    return res.status(503).json({
      success: false,
      error: "Browser feature is not configured (SANDBOX_API_URL is missing).",
    });
  }

  logger.info("Creating browser session", {
    ttlTotal,
    ttlWithoutActivity,
    streamWebView,
  });

  // 1. Acquire a CDP session from fire-engine
  const cdpRes = await fetch(`${config.FIRE_ENGINE_BETA_URL}/cdp-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: "us",
      mobileProxy: false,
      useProxy: true,
    }),
  });

  if (!cdpRes.ok) {
    const text = await cdpRes.text();
    logger.error("Failed to create CDP session", {
      status: cdpRes.status,
      text,
    });
    return res.status(502).json({
      success: false,
      error: "Failed to create browser CDP session.",
    });
  }

  const { browserId: feBrowserId, cdpPath } = (await cdpRes.json()) as {
    browserId: string;
    cdpPath: string;
  };

  // 2. Create a sandbox workspace and context
  const client = getSandboxClient();
  const workspace = await client.createWorkspace({ ttlSeconds: ttlTotal });
  const ctx = await workspace.createContext();

  // 3. Bridge CDP into the sandbox
  await ctx.enableBrowser(cdpPath);

  // 4. Initialize Playwright inside the sandbox
  const initExec = await ctx.runCode(`
from playwright.async_api import async_playwright

__pw__ = await async_playwright().start()
browser = await __pw__.chromium.connect_over_cdp("ws://127.0.0.1:9222")
context = await browser.new_context()
page = await context.new_page()
`);

  if (initExec.error) {
    // Cleanup on failure
    await workspace.destroy().catch(() => {});
    if (config.FIRE_ENGINE_BETA_URL) {
      await fetch(`${config.FIRE_ENGINE_BETA_URL}/cdp-session/${feBrowserId}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    return res.status(502).json({
      success: false,
      error: `Failed to initialize browser: ${initExec.error.name}: ${initExec.error.value}`,
    });
  }

  // Build the user-facing CDP URL
  const cdpUrl = `${config.CDP_PROXY_URL}${cdpPath}`;

  // 5. Persist session in Supabase
  try {
    await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      browser_id: feBrowserId,
      workspace_id: workspace.id,
      context_id: ctx.id,
      cdp_url: cdpUrl,
      cdp_path: cdpPath,
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttlTotal,
      ttl_without_activity: ttlWithoutActivity ?? null,
    });
  } catch (err) {
    // If we can't persist, tear everything down
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await workspace.destroy().catch(() => {});
    if (config.FIRE_ENGINE_BETA_URL) {
      await fetch(`${config.FIRE_ENGINE_BETA_URL}/cdp-session/${feBrowserId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    return res.status(500).json({
      success: false,
      error: "Failed to persist browser session.",
    });
  }

  logger.info("Browser session created", {
    sessionId,
    browserId: feBrowserId,
    cdpUrl,
  });

  return res.status(200).json({
    success: true,
    id: sessionId,
    cdpUrl,
  });
}

export async function browserExecuteController(
  req: RequestWithAuth<{}, BrowserExecuteResponse, BrowserExecuteRequest>,
  res: Response<BrowserExecuteResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  req.body = browserExecuteRequestSchema.parse(req.body);

  const { id, code, language } = req.body;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserExecuteController",
  });

  // Look up session from Supabase
  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  if (session.status === "destroyed") {
    return res.status(410).json({
      success: false,
      error: "Browser session has been destroyed.",
    });
  }

  // Update activity timestamp (fire-and-forget)
  updateBrowserSessionActivity(id).catch(() => {});

  logger.info("Executing code in browser session", { language });

  // Reconstruct the code context from stored IDs
  const client = getSandboxClient();
  const ctx = reconstructContext(client, session);

  const exec = await ctx.runCode(code);

  const output = executionToString(exec);

  logger.debug("Execution result", {
    text: exec.text,
    hasError: !!exec.error,
    outputLength: output.length,
  });

  if (exec.error) {
    return res.status(200).json({
      success: true,
      result: output,
      error: `${exec.error.name}: ${exec.error.value}`,
    });
  }

  return res.status(200).json({
    success: true,
    result: output,
  });
}

export async function browserDeleteController(
  req: RequestWithAuth<{}, BrowserDeleteResponse, BrowserDeleteRequest>,
  res: Response<BrowserDeleteResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  req.body = browserDeleteRequestSchema.parse(req.body);

  const { id } = req.body;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserDeleteController",
  });

  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger.info("Deleting browser session");

  await destroySession(session);

  return res.status(200).json({
    success: true,
  });
}

export async function browserListController(
  req: RequestWithAuth<{}, BrowserListResponse>,
  res: Response<BrowserListResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  const logger = _logger.child({
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserListController",
  });

  logger.info("Listing browser sessions");

  const statusFilter = (req.query as Record<string, string>).status as
    | "active"
    | "destroyed"
    | undefined;

  const rows = await listBrowserSessions(req.auth.team_id, {
    status: statusFilter,
  });

  return res.status(200).json({
    success: true,
    sessions: rows.map(r => ({
      id: r.id,
      status: r.status,
      cdpUrl: r.cdp_url,
      streamWebView: r.stream_web_view,
      createdAt: r.created_at,
      lastActivity: r.updated_at,
    })),
  });
}
