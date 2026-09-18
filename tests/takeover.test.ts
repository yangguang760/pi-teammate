/**
 * Identity takeover tests (black-hole fix).
 *
 * Regression scenario: a teammate process dies, messages arrive while it is
 * down, the user opens a NEW session with the same agent name. Before the fix,
 * the new session's cursor skipped to MAX(message_id) and every downtime
 * message was permanently lost. After the fix, takeoverIdentity re-binds the
 * identity: cursor inherited, messages re-addressed, zombie row removed.
 */
import { describe, test, expect } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG, createPayload } from "../extensions/types.ts";
import {
  registerAgent,
  getAgentByName,
  getAgentBySession,
  sendMessage,
  initCursor,
  advanceCursor,
  getUnreadMessages,
  takeoverIdentity,
} from "../extensions/db.ts";

const CHANNEL = "general";

function payload(event: string, content: string) {
  return JSON.stringify(createPayload(event as any, content));
}

/** Register a live remote agent (so FK-style naming looks realistic). */
function registerRemote(db: any, sessionId: string, name: string) {
  registerAgent(db, {
    session_id: sessionId,
    agent_name: name,
    description: null,
    provider: null,
    model: null,
    cwd: "/tmp",
  });
  initCursor(db, sessionId, CHANNEL);
}

/**
 * Simulate the full (re)join sequence of a teammate for identity `name`
 * from session `sessionId`, exactly as Mamoru.start() does it.
 */
function join(db: any, sessionId: string, name: string) {
  registerAgent(db, {
    session_id: sessionId,
    agent_name: name,
    description: null,
    provider: null,
    model: null,
    cwd: "/tmp",
  });
  const takeover = takeoverIdentity(db, name, sessionId);
  initCursor(db, sessionId, CHANNEL);
  return takeover;
}

describe("takeoverIdentity", () => {
  test("first join is a no-op", () => {
    const db = createTestDb();
    const result = join(db, "s1", "alice");
    expect(result.previousSessionId).toBeNull();
    // Genuine first join: cursor skipped to MAX — no history replay.
    expect(getUnreadMessages(db, "s1", CHANNEL)).toHaveLength(0);
  });

  test("same-session reconnect is a no-op and keeps cursor", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    advanceCursor(db, "s1", CHANNEL, 5);

    const result = join(db, "s1", "alice");
    expect(result.previousSessionId).toBeNull();

    const cursor = db.prepare(
      "SELECT last_read_id FROM agent_cursors WHERE session_id = 's1' AND channel = ?",
    ).get(CHANNEL);
    expect(cursor.last_read_id).toBe(5);
  });

  test("rejoin after crash replays directed downtime messages", () => {
    const db = createTestDb();
    join(db, "s1", "alice"); // original session
    registerRemote(db, "bob", "bob");

    // alice goes down. bob sends her a directed task.
    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("task_req", "please review"),
    });

    // alice comes back in a NEW session.
    const result = join(db, "s2", "alice");
    expect(result.previousSessionId).toBe("s1");

    const unread = getUnreadMessages(db, "s2", CHANNEL);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.from_agent).toBe("bob");
  });

  test("rejoin after crash replays broadcast downtime messages", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    sendMessage(db, {
      from_agent: "bob",
      to_agent: null,
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("broadcast", "hi everyone"),
    });

    join(db, "s2", "alice");
    const unread = getUnreadMessages(db, "s2", CHANNEL);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.to_agent).toBeNull();
  });

  test("downtime messages are re-addressed to the new session", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("task_req", "ping"),
    });

    join(db, "s2", "alice");
    const row = db.prepare(
      "SELECT to_agent FROM messages ORDER BY message_id DESC LIMIT 1",
    ).get();
    expect(row.to_agent).toBe("s2");
  });

  test("already-read messages are not replayed on rejoin", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("broadcast", "old news"),
    });
    // alice read everything before going down.
    advanceCursor(db, "s1", CHANNEL, 99);

    join(db, "s2", "alice");
    expect(getUnreadMessages(db, "s2", CHANNEL)).toHaveLength(0);
  });

  test("own broadcasts from the old session are excluded from replay", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    // alice's own join broadcast + a status broadcast, then she goes down.
    sendMessage(db, {
      from_agent: "s1",
      to_agent: null,
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("broadcast", "alice has joined the channel"),
    });

    join(db, "s2", "alice");

    // Without exclusion alice would hear her own old broadcasts.
    const withExclude = getUnreadMessages(db, "s2", CHANNEL, ["s1"]);
    expect(withExclude).toHaveLength(0);
    // Sanity: without the exclusion they DO appear (documents behavior).
    const withoutExclude = getUnreadMessages(db, "s2", CHANNEL);
    expect(withoutExclude).toHaveLength(1);
  });

  test("takeover removes the zombie row", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    join(db, "s2", "alice");

    expect(getAgentBySession(db, "s1")).toBeNull();
    const current = getAgentByName(db, "alice");
    expect(current).not.toBeNull();
    expect(current!.session_id).toBe("s2");
  });

  test("rejoin after clean leave replays too (row marked inactive, not deleted)", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("task_req", "while you were away"),
    });

    // clean leave marks the row inactive but keeps it.
    db.prepare("UPDATE agents SET status = 'inactive' WHERE session_id = 's1'").run();

    join(db, "s2", "alice");
    expect(getUnreadMessages(db, "s2", CHANNEL)).toHaveLength(1);
  });

  test("takeover does not clobber a newer cursor on reconnect collision", () => {
    const db = createTestDb();
    join(db, "s1", "alice");
    registerRemote(db, "bob", "bob");

    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("broadcast", "one"),
    });

    join(db, "s2", "alice");
    // s2 read everything.
    advanceCursor(db, "s2", CHANNEL, 999);

    // A THIRD session somehow rejoins while s2's row is live — takeover is
    // unconditional; the copied cursor must be s2's (newest), not s1's.
    join(db, "s3", "alice");
    expect(getUnreadMessages(db, "s3", CHANNEL)).toHaveLength(0);
  });
});

describe("Mamoru rejoin integration", () => {
  test("new session same name polls downtime messages", () => {
    const db = createTestDb();
    // Original life of the teammate.
    {
      const pi = createMockPi();
      const ctx = createMockCtx("s1");
      const m = new Mamoru({
        db, sessionId: "s1", agentName: "alice", channel: CHANNEL,
        persona: null, pi, ctx, roster: new Roster(), config: DEFAULT_MAMORU_CONFIG,
      });
      m.start();
      m.stop();
    }

    registerRemote(db, "bob", "bob");
    sendMessage(db, {
      from_agent: "bob",
      to_agent: "s1",
      channel: CHANNEL,
      task_id: null,
      ref_message_id: null,
      payload: payload("task_req", "while you were dead"),
    });

    // Reborn teammate in a brand-new session.
    const pi = createMockPi();
    const ctx = createMockCtx("s2");
    const roster = new Roster();
    const m2 = new Mamoru({
      db, sessionId: "s2", agentName: "alice", channel: CHANNEL,
      persona: null, pi, ctx, roster, config: DEFAULT_MAMORU_CONFIG,
    });
    m2.start();

    expect(m2.getPreviousSessionIds()).toEqual(["s1"]);

    m2.pollOnce();

    // The downtime task_req reached the LLM of the new session.
    const injected = pi.sentUserMessages.map((m) => String(m.content));
    expect(injected.some((c) => c.includes("while you were dead"))).toBe(true);

    // And the cursor advanced past it — second poll injects nothing new.
    const countAfterFirstPoll = pi.sentUserMessages.length;
    m2.pollOnce();
    expect(pi.sentUserMessages.length).toBe(countAfterFirstPoll);

    m2.stop();
  });
});
