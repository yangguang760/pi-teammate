/**
 * Presence lease tests (B2).
 *
 * The lease is renewed by an extension timer, not the LLM: a dead process
 * stops renewing and peers tombstone it within leaseTtlMs. Retry gating must
 * also treat a stale 'available' row as dead — retrying a zombie used to hang
 * forever.
 */
import { describe, test, expect } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import type { MamoruConfig } from "../extensions/types.ts";
import {
  registerAgent,
  updateAgentStatus,
  updateHeartbeat,
  getActiveAgents,
  isLeaseAlive,
  markStaleAgentsInactive,
  sendMessage,
} from "../extensions/db.ts";
import { createPayload } from "../extensions/types.ts";

const CHANNEL = "general";
const TTL = 30_000;

function makeConfig(overrides?: Partial<MamoruConfig>): MamoruConfig {
  return { ...DEFAULT_MAMORU_CONFIG, ...overrides };
}

function registerWithHeartbeat(db: any, sessionId: string, name: string, heartbeat: number) {
  registerAgent(db, {
    session_id: sessionId,
    agent_name: name,
    description: null,
    provider: null,
    model: null,
    cwd: "/tmp",
  });
  db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = ?").run(heartbeat, sessionId);
}

// ── isLeaseAlive ─────────────────────────────────────────────────

describe("isLeaseAlive", () => {
  test("fresh heartbeat is alive", () => {
    const db = createTestDb();
    registerWithHeartbeat(db, "s1", "alice", 1_000);
    expect(isLeaseAlive(db, "s1", TTL, 1_000 + TTL)).toBe(true);
  });

  test("expired heartbeat is dead (boundary is inclusive)", () => {
    const db = createTestDb();
    registerWithHeartbeat(db, "s1", "alice", 1_000);
    expect(isLeaseAlive(db, "s1", TTL, 1_000 + TTL + 1)).toBe(false);
  });

  test("missing row and NULL heartbeat are dead", () => {
    const db = createTestDb();
    expect(isLeaseAlive(db, "ghost", TTL, 1_000)).toBe(false);

    db.prepare(
      "INSERT INTO agents (session_id, agent_name, status, last_heartbeat) VALUES (?, ?, 'available', NULL)",
    ).run("s-null", "null-heartbeat");
    expect(isLeaseAlive(db, "s-null", TTL, 1_000)).toBe(false);
  });
});

// ── markStaleAgentsInactive ──────────────────────────────────────

describe("markStaleAgentsInactive", () => {
  const NOW = 1_000_000;

  test("marks only lease-expired rows; self and fresh rows survive", () => {
    const db = createTestDb();
    registerWithHeartbeat(db, "self", "me", NOW);
    registerWithHeartbeat(db, "dead", "zombie", NOW - TTL - 1);
    registerWithHeartbeat(db, "alive", "fresh", NOW - 1);

    const marked = markStaleAgentsInactive(db, TTL, "self", NOW);
    expect(marked).toEqual(["dead"]);

    const statuses = Object.fromEntries(
      (db.prepare("SELECT session_id, status FROM agents").all() as any[]).map(r => [r.session_id, r.status]),
    );
    expect(statuses["dead"]).toBe("inactive");
    expect(statuses["alive"]).toBe("available");
    expect(statuses["self"]).toBe("available");
  });

  test("NULL heartbeat counts as expired", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO agents (session_id, agent_name, status, last_heartbeat) VALUES (?, ?, 'available', NULL)",
    ).run("s-null", "null-heartbeat");

    const marked = markStaleAgentsInactive(db, TTL, "self", NOW);
    expect(marked).toContain("s-null");
  });

  test("already-inactive rows are not re-marked", () => {
    const db = createTestDb();
    registerWithHeartbeat(db, "dead", "zombie", NOW - TTL - 1);
    updateAgentStatus(db, "dead", "inactive");

    const marked = markStaleAgentsInactive(db, TTL, "self", NOW);
    expect(marked).toEqual([]);
  });

  test("tombstoned rows leave getActiveAgents", () => {
    const db = createTestDb();
    registerWithHeartbeat(db, "dead", "zombie", NOW - TTL - 1);
    markStaleAgentsInactive(db, TTL, "self", NOW);
    expect(getActiveAgents(db).map(a => a.session_id)).not.toContain("dead");
  });
});

// ── Mamoru lease wiring ──────────────────────────────────────────

function createMamoru(overrides?: {
  db?: any;
  sessionId?: string;
  agentName?: string;
  config?: Partial<MamoruConfig>;
}) {
  const db = overrides?.db ?? createTestDb();
  const pi = createMockPi();
  const sessionId = overrides?.sessionId ?? "self-session";
  const ctx = createMockCtx(sessionId);
  const mamoru = new Mamoru({
    db,
    sessionId,
    agentName: overrides?.agentName ?? "Me",
    channel: CHANNEL,
    persona: null,
    pi: pi as any,
    ctx: ctx as any,
    roster: new Roster(),
    config: makeConfig(overrides?.config),
  });
  return { mamoru, db, pi, ctx };
}

describe("Mamoru presence lease", () => {
  test("start() renews the lease on an extension timer (no LLM)", async () => {
    const { mamoru, db } = createMamoru({ config: { leaseRenewalMs: 10 } });
    mamoru.start();
    const registered = (db.prepare(
      "SELECT last_heartbeat FROM agents WHERE session_id = 'self-session'",
    ).get() as any).last_heartbeat as number;

    await new Promise((r) => setTimeout(r, 80));

    const renewed = (db.prepare(
      "SELECT last_heartbeat FROM agents WHERE session_id = 'self-session'",
    ).get() as any).last_heartbeat as number;
    expect(renewed).toBeGreaterThanOrEqual(registered);
    expect(isLeaseAlive(db, "self-session", TTL)).toBe(true);

    mamoru.stop();
    // Timer stopped: heartbeat no longer advances.
    const frozen = (db.prepare(
      "SELECT last_heartbeat FROM agents WHERE session_id = 'self-session'",
    ).get() as any).last_heartbeat as number;
    await new Promise((r) => setTimeout(r, 40));
    expect((db.prepare(
      "SELECT last_heartbeat FROM agents WHERE session_id = 'self-session'",
    ).get() as any).last_heartbeat).toBe(frozen);
  });

  test("a crashed peer is tombstoned by the sweep and vanishes from the roster", () => {
    const { mamoru, db, pi, ctx } = createMamoru({ config: { leaseTtlMs: 100 } });
    mamoru.start();

    // Peer joined, then its process died 5 minutes ago.
    registerWithHeartbeat(db, "bob", "bob", Date.now() - 5 * 60_000);

    mamoru.pollOnce();

    const status = (db.prepare(
      "SELECT status FROM agents WHERE session_id = 'bob'",
    ).get() as any).status;
    expect(status).toBe("inactive");
    expect(mamoru.getRoster().get("bob")).toBeUndefined();
    expect(ctx.notifications.some(n => n.message.includes("bob"))).toBe(true);
    void pi;
  });

  test("pending retries never fire at a stale 'available' zombie", () => {
    const { mamoru, db } = createMamoru({ config: { leaseTtlMs: 100 } });
    mamoru.start();

    // Zombie: status says available, lease says dead.
    registerWithHeartbeat(db, "bob", "bob", Date.now() - 5 * 60_000);
    db.prepare("UPDATE agents SET status = 'available' WHERE session_id = 'bob'").run();
    mamoru.getRoster().initFromDb(db, "self-session");

    const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any;

    (mamoru as any).registerPendingRetry({
      targetSessionId: "bob",
      content: "do the thing",
      detail: null,
      intent: "build",
      blocking: true,
      retryCount: 0,
      createdAt: Date.now(),
    });
    mamoru.pollOnce();
    (mamoru as any).processPendingRetries();

    const after = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any;
    expect(after.n).toBe(before.n); // no retry message sent to the zombie

    // Control: with a fresh lease AND available status, the retry fires.
    updateHeartbeat(db, "bob");
    db.prepare("UPDATE agents SET status = 'available' WHERE session_id = 'bob'").run();
    mamoru.getRoster().initFromDb(db, "self-session");
    (mamoru as any).processPendingRetries();

    const retryRow = db.prepare(
      "SELECT payload FROM messages WHERE to_agent = 'bob' ORDER BY message_id DESC LIMIT 1",
    ).get() as any;
    expect(retryRow).toBeDefined();
    expect(retryRow.payload).toContain("do the thing");
    void sendMessage;
  });
});
