import { supabase_service } from "../services/supabase";
import { logger as _logger } from "./logger";

const logger = _logger.child({ module: "browser-sessions" });

type BrowserSessionStatus = "active" | "destroyed" | "error";

export interface BrowserSessionRow {
  id: string;
  team_id: string;
  browser_id: string;
  workspace_id: string;
  context_id: string;
  cdp_url: string;
  cdp_path: string;
  stream_web_view: boolean;
  status: BrowserSessionStatus;
  ttl_total: number;
  ttl_without_activity: number | null;
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

const TABLE = "browser_sessions";

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function insertBrowserSession(
  row: Omit<BrowserSessionRow, "created_at" | "updated_at">,
): Promise<BrowserSessionRow> {
  const now = new Date().toISOString();
  const full: BrowserSessionRow = {
    ...row,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase_service
    .from(TABLE)
    .insert(full)
    .select()
    .single();

  if (error) {
    logger.error("Failed to insert browser session", { error, id: row.id });
    throw new Error(`Failed to insert browser session: ${error.message}`);
  }

  return data as BrowserSessionRow;
}

export async function getBrowserSession(
  id: string,
): Promise<BrowserSessionRow | null> {
  const { data, error } = await supabase_service
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    // PGRST116 = no rows found
    if (error.code === "PGRST116") return null;
    logger.error("Failed to get browser session", { error, id });
    throw new Error(`Failed to get browser session: ${error.message}`);
  }

  return data as BrowserSessionRow;
}

export async function listBrowserSessions(
  teamId: string,
  opts?: { status?: BrowserSessionStatus },
): Promise<BrowserSessionRow[]> {
  let query = supabase_service
    .from(TABLE)
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });

  if (opts?.status) {
    query = query.eq("status", opts.status);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to list browser sessions", { error, teamId });
    throw new Error(`Failed to list browser sessions: ${error.message}`);
  }

  return (data ?? []) as BrowserSessionRow[];
}

export async function updateBrowserSessionActivity(id: string): Promise<void> {
  const { error } = await supabase_service
    .from(TABLE)
    .update({ last_activity: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update browser session activity", { error, id });
  }
}

export async function updateBrowserSessionStatus(
  id: string,
  status: BrowserSessionStatus,
): Promise<void> {
  const { error } = await supabase_service
    .from(TABLE)
    .update({ status })
    .eq("id", id);

  if (error) {
    logger.warn("Failed to update browser session status", { error, id });
  }
}
