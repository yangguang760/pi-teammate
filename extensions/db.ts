/**
 * Database helper functions for pi-teammate.
 * All functions take `db: Database` as first argument (dependency injection).
 */
import type Database from "better-sqlite3";
import type { AgentRow, AgentStatus, MessageRow } from "./types.ts";
import { MAX_CONTENT_WORDS, countWords } from "./types.ts";

// ── Agent Functions ─────────────────────────────────────────────

export function registerAgent(
  db: Database.Database,
  agent: Omit<AgentRow, "status" | "last_heartbeat"> & { status?: AgentStatus },
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents (session_id, agent_name, description, provider, model, cwd, status, last_heartbeat)
    VALUES (@session_id, @agent_name, @description, @provider, @model, @cwd, @status, @last_heartbeat)
  `);
  stmt.run({
    session_id: agent.session_id,
    agent_name: agent.agent_name,
    description: agent.description ?? null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    cwd: agent.cwd ?? null,
    status: agent.status ?? "available",
    last_heartbeat: Date.now(),
  });
}

export function updateAgentStatus(
  db: Database.Database,
  sessionId: string,
  status: AgentStatus,
): void {
  db.prepare("UPDATE agents SET status = ? WHERE session_id = ?").run(status, sessionId);
}

export function updateHeartbeat(db: Database.Database, sessionId: string): void {
  db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = ?").run(Date.now(), sessionId);
}

// ── Presence Lease ───────────────────────────────────────────
//
// Historically last_heartbeat was only written when a ping was handled, so a
// live session that received no pings looked exactly like a dead one. A lease
// is renewed by an extension-level timer (no LLM involved): a session whose
// process dies stops renewing within leaseTtlMs.

/** Whether the session's presence lease is still fresh. */
export function isLeaseAlive(
  db: Database.Database,
  sessionId: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  const row = db.prepare(
    "SELECT last_heartbeat FROM agents WHERE session_id = ?",
  ).get(sessionId) as { last_heartbeat: number | null } | undefined;
  if (!row || row.last_heartbeat === null) return false;
  return now - row.last_heartbeat <= ttlMs;
}

/**
 * Mark every agent whose presence lease expired as 'inactive' (except
 * `excludeSessionId`). Status-only tombstoning keeps the row for display
 * (getAgentDisplayName) and future takeover, while removing it from
 * getActiveAgents/roster. Returns the session ids marked.
 */
export function markStaleAgentsInactive(
  db: Database.Database,
  ttlMs: number,
  excludeSessionId: string,
  now: number = Date.now(),
): string[] {
  const stale = db.prepare(`
    SELECT session_id FROM agents
    WHERE session_id != ?
      AND status != 'inactive'
      AND (last_heartbeat IS NULL OR ? - last_heartbeat > ?)
  `).all(excludeSessionId, now, ttlMs) as { session_id: string }[];

  if (stale.length === 0) return [];

  const mark = db.prepare(
    "UPDATE agents SET status = 'inactive' WHERE session_id = ?",
  );
  const marked: string[] = [];
  for (const row of stale) {
    mark.run(row.session_id);
    marked.push(row.session_id);
  }
  return marked;
}

export function getActiveAgents(db: Database.Database): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE status != 'inactive'").all() as AgentRow[];
}

export function getAgentBySession(db: Database.Database, sessionId: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE session_id = ?").get(sessionId) as AgentRow) ?? null;
}

export function getAgentByName(db: Database.Database, name: string): AgentRow | null {
  return (db.prepare("SELECT * FROM agents WHERE agent_name = ?").get(name) as AgentRow) ?? null;
}

export function getInactiveAgentsByName(
  db: Database.Database,
  name: string,
  excludeSessionId?: string,
): AgentRow[] {
  if (excludeSessionId) {
    return db.prepare(`
      SELECT * FROM agents
      WHERE agent_name = ?
        AND status = 'inactive'
        AND session_id != ?
      ORDER BY COALESCE(last_heartbeat, 0) ASC, session_id ASC
    `).all(name, excludeSessionId) as AgentRow[];
  }

  return db.prepare(`
    SELECT * FROM agents
    WHERE agent_name = ?
      AND status = 'inactive'
    ORDER BY COALESCE(last_heartbeat, 0) ASC, session_id ASC
  `).all(name) as AgentRow[];
}

export function deleteAgent(db: Database.Database, sessionId: string): void {
  const foreignKeysEnabled = !!db.pragma("foreign_keys", { simple: true });
  if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");

  try {
    db.prepare("DELETE FROM agent_cursors WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);
  } finally {
    if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
  }
}

// ── Message Functions ───────────────────────────────────────────

export function sendMessage(
  db: Database.Database,
  msg: {
    from_agent: string;
    to_agent: string | null;
    channel: string;
    task_id: number | null;
    ref_message_id: number | null;
    payload: string;
    maxContentWords?: number;
  },
): number {
  // Validate payload JSON has content field within word limit
  let parsed: any;
  try {
    parsed = JSON.parse(msg.payload);
  } catch {
    throw new Error("payload must be valid JSON");
  }
  if (typeof parsed.content !== "string") {
    throw new Error("payload must have a content field");
  }
  const limit = msg.maxContentWords ?? MAX_CONTENT_WORDS;
  if (countWords(parsed.content) > limit) {
    throw new Error(`payload.content must be ≤ ${limit} words (got ${countWords(parsed.content)}). Put details in the 'detail' field.`);
  }

  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, channel, task_id, ref_message_id, payload, created_at)
    VALUES (@from_agent, @to_agent, @channel, @task_id, @ref_message_id, @payload, @created_at)
  `).run({
    from_agent: msg.from_agent,
    to_agent: msg.to_agent,
    channel: msg.channel,
    task_id: msg.task_id,
    ref_message_id: msg.ref_message_id,
    payload: msg.payload,
    created_at: Date.now(),
  });

  return Number(result.lastInsertRowid);
}

export function sendTaskReq(
  db: Database.Database,
  msg: {
    from_agent: string;
    to_agent: string | null;
    channel: string;
    payload: string;
    maxContentWords?: number;
  },
): number {
  // Insert with task_id = NULL first
  const messageId = sendMessage(db, {
    from_agent: msg.from_agent,
    to_agent: msg.to_agent,
    channel: msg.channel,
    task_id: null,
    ref_message_id: null,
    payload: msg.payload,
    maxContentWords: msg.maxContentWords,
  });

  // Then update task_id = message_id (self-referencing)
  db.prepare("UPDATE messages SET task_id = ? WHERE message_id = ?").run(messageId, messageId);

  return messageId;
}

// ── Cursor Functions ────────────────────────────────────────────

export function initCursor(db: Database.Database, sessionId: string, channel: string): void {
  // Skip to current max message_id so we don't replay old messages from before this session.
  // If the cursor already exists (e.g., reconnect with same session_id), keep the existing position.
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(message_id), 0) AS max_id FROM messages WHERE channel = ?"
  ).get(channel) as { max_id: number };

  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(sessionId, channel, maxRow.max_id);
}

export function advanceCursor(
  db: Database.Database,
  sessionId: string,
  channel: string,
  lastReadId: number,
): void {
  db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, channel) DO UPDATE SET last_read_id = excluded.last_read_id
  `).run(sessionId, channel, lastReadId);
}

export function getUnreadMessages(
  db: Database.Database,
  sessionId: string,
  channel: string,
  excludeFrom: string[] = [],
): MessageRow[] {
  // Get the cursor position
  const cursor = db.prepare(
    "SELECT last_read_id FROM agent_cursors WHERE session_id = ? AND channel = ?",
  ).get(sessionId, channel) as { last_read_id: number } | undefined;

  const lastReadId = cursor?.last_read_id ?? 0;

  // Sessions this identity previously inhabited (see takeoverIdentity).
  // Broadcasts we sent from those sessions must not replay to ourselves.
  const excludes = excludeFrom.filter(Boolean);
  const excludeClause = excludes.length > 0
    ? `AND from_agent NOT IN (${excludes.map(() => "?").join(", ")})`
    : "";

  return db.prepare(`
    SELECT * FROM messages
    WHERE channel = ?
      AND message_id > ?
      AND from_agent != ?
      ${excludeClause}
      AND (to_agent IS NULL OR to_agent = ?)
    ORDER BY message_id ASC
  `).all(channel, lastReadId, sessionId, ...excludes, sessionId) as MessageRow[];
}

// ── Identity Takeover ─────────────────────────────────────────

export interface TakeoverResult {
  /** Old session row this registration reclaimed, if any. */
  previousSessionId: string | null;
}

/**
 * Reclaim the identity `agentName` for a (new) session.
 *
 * Historically a teammate's delivery identity was bound to its session_id:
 * when the process died and the user opened a NEW session, the old agents row
 * stayed behind as a zombie and initCursor skipped to MAX(message_id),
 * permanently skipping every message sent while the teammate was down —
 * the "black hole".
 *
 * This function re-binds the identity to the incoming session:
 *   1. redirect messages addressed to the old session to the new one,
 *   2. copy the old cursor position so unread messages (including everything
 *      sent during downtime) replay, instead of being skipped,
 *   3. delete the old (zombie) row.
 *
 * Must be called AFTER registerAgent (so the new session's agents row exists
 * for the cursor foreign key) and BEFORE initCursor (whose ON CONFLICT DO
 * NOTHING then keeps the inherited position).
 *
 * Takeover is unconditional in this version: a precise liveness guard
 * ("refuse to take over a session that is still alive") arrives with
 * presence leases.
 */
export function takeoverIdentity(
  db: Database.Database,
  agentName: string,
  newSessionId: string,
): TakeoverResult {
  const old = getAgentByName(db, agentName);
  if (!old || old.session_id === newSessionId) {
    return { previousSessionId: null };
  }

  const previousSessionId = old.session_id;

  // 1. Re-address messages that were sent to the old session.
  //    (Safe under foreign keys: messages.to_agent is not a foreign key.)
  db.prepare("UPDATE messages SET to_agent = ? WHERE to_agent = ?")
    .run(newSessionId, previousSessionId);

  // 2. Inherit cursor positions (per channel). If this exact session already
  //    has a cursor (reconnect), keep the newer one. The new session's agents
  //    row must already exist (registerAgent ran first) for the FK to hold.
  const cursors = db.prepare(
    "SELECT channel, last_read_id FROM agent_cursors WHERE session_id = ?",
  ).all(previousSessionId) as { channel: string; last_read_id: number }[];

  const insertCursor = db.prepare(`
    INSERT INTO agent_cursors (session_id, channel, last_read_id)
    VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  for (const c of cursors) {
    insertCursor.run(newSessionId, c.channel, c.last_read_id);
  }

  // 3. Remove the zombie row (also drops its now-duplicated cursor rows).
  deleteAgent(db, previousSessionId);

  return { previousSessionId };
}

export function getMessagesByTaskId(db: Database.Database, taskId: number): MessageRow[] {
  return db.prepare(
    "SELECT * FROM messages WHERE task_id = ? ORDER BY message_id ASC",
  ).all(taskId) as MessageRow[];
}
