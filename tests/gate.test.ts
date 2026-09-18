/**
 * Milestone gate + JSONL audit tests (B3).
 *
 * gate: "milestone" on a task_req makes the REQUESTER pause all inbound
 * reception once that task's task_done arrives — a transport-level human
 * checkpoint (pi-team's turn-budget pause, but per-task and opt-in).
 * /team-resume lifts it. Held messages stay unread in the DB, so a crash
 * while gated still replays them after rejoin (B1 takeover).
 */
import { describe, test, expect } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG, createPayload } from "../extensions/types.ts";
import { registerAgent, sendMessage, getUnreadMessages, takeoverIdentity, initCursor } from "../extensions/db.ts";
import { getChannelDir } from "../extensions/paths.ts";

const CHANNEL = "general";

function join(db: any, sessionId: string, name: string, cwd = "/tmp") {
  takeoverIdentity(db, name, sessionId);
  registerAgent(db, {
    session_id: sessionId,
    agent_name: name,
    description: null, provider: null, model: null, cwd,
  });
  initCursor(db, sessionId, CHANNEL);
}

function createMamoru(db: any, sessionId: string, agentName: string) {
  const pi = createMockPi();
  const ctx = createMockCtx(sessionId);
  const mamoru = new Mamoru({
    db, sessionId, agentName, channel: CHANNEL,
    persona: null, pi: pi as any, ctx: ctx as any,
    roster: new Roster(), config: { ...DEFAULT_MAMORU_CONFIG },
  });
  return { mamoru, pi, ctx };
}

function taskDone(db: any, from: string, taskId: number, content: string) {
  sendMessage(db, {
    from_agent: from, to_agent: "self", channel: CHANNEL,
    task_id: taskId, ref_message_id: null,
    payload: JSON.stringify(createPayload("task_done", content)),
  });
}

describe("milestone gate", () => {
  test("milestone task_done engages the gate after forwarding the result", () => {
    const db = createTestDb();
    join(db, "self", "coordinator");
    join(db, "bob", "bob");
    const { mamoru, pi } = createMamoru(db, "self", "coordinator");
    mamoru.start();

    // Dispatch a milestone task (as send-message does with gate param).
    const messageId = sendMessage(db, {
      from_agent: "self", to_agent: "bob", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_req", "deliver milestone", {
        intent: "build", need_reply: true, gate: "milestone",
      })),
    });
    mamoru.registerOutboundTask(messageId, "bob", {
      content: "deliver milestone", detail: null, intent: "build", gate: "milestone",
    });

    // bob finishes.
    taskDone(db, "bob", messageId, "milestone delivered");
    mamoru.pollOnce();

    // Result reached the requester's LLM, then the gate engaged.
    expect(pi.sentUserMessages.some(m => String(m.content).includes("milestone delivered"))).toBe(true);
    expect(mamoru.isGated()).toBe(true);
    expect(mamoru.getOutboundTasks().has(messageId)).toBe(false);
  });

  test("plain task_done does not gate", () => {
    const db = createTestDb();
    join(db, "self", "coordinator");
    join(db, "bob", "bob");
    const { mamoru } = createMamoru(db, "self", "coordinator");
    mamoru.start();

    const messageId = sendMessage(db, {
      from_agent: "self", to_agent: "bob", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_req", "normal task", { need_reply: true })),
    });
    mamoru.registerOutboundTask(messageId, "bob", {
      content: "normal task", detail: null, intent: null,
    });

    taskDone(db, "bob", messageId, "done");
    mamoru.pollOnce();

    expect(mamoru.isGated()).toBe(false);
  });

  test("while gated, inbound messages are HELD unread (not injected, not consumed)", () => {
    const db = createTestDb();
    join(db, "self", "coordinator");
    join(db, "bob", "bob");
    join(db, "carol", "carol");
    const { mamoru, pi } = createMamoru(db, "self", "coordinator");
    mamoru.start();

    mamoru.engageGate(null, "test");

    // carol sends a new task while the gate is engaged.
    sendMessage(db, {
      from_agent: "carol", to_agent: "self", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_req", "urgent while gated")),
    });

    mamoru.pollOnce();
    mamoru.pollOnce();

    // Nothing injected.
    expect(pi.sentUserMessages.some(m => String(m.content).includes("urgent while gated"))).toBe(false);
    // Message still unread in the DB (cursor untouched).
    const unread = getUnreadMessages(db, "self", CHANNEL).filter(m => m.payload.includes("urgent"));
    expect(unread).toHaveLength(1);
  });

  test("resume() releases the held message", () => {
    const db = createTestDb();
    join(db, "self", "coordinator");
    join(db, "carol", "carol");
    const { mamoru, pi } = createMamoru(db, "self", "coordinator");
    mamoru.start();

    mamoru.engageGate(null, "test");
    sendMessage(db, {
      from_agent: "carol", to_agent: "self", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_req", "held no longer")),
    });
    mamoru.pollOnce(); // gated: held
    expect(mamoru.isGated()).toBe(true);

    mamoru.resume();
    mamoru.pollOnce();

    expect(pi.sentUserMessages.some(m => String(m.content).includes("held no longer"))).toBe(true);
    expect(getUnreadMessages(db, "self", CHANNEL).filter(m => m.payload.includes("held"))).toHaveLength(0);
  });

  test("requeue preserves the milestone gate", () => {
    const db = createTestDb();
    join(db, "self", "coordinator");
    join(db, "bob", "bob");
    join(db, "carol", "carol");
    const { mamoru } = createMamoru(db, "self", "coordinator", );
    mamoru.start();

    const messageId = sendMessage(db, {
      from_agent: "self", to_agent: "bob", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_req", "milestone on the move", {
        need_reply: true, gate: "milestone",
      })),
    });
    mamoru.registerOutboundTask(messageId, "bob", {
      content: "milestone on the move", detail: null, intent: null, gate: "milestone",
    });

    // bob dies; carol takes over.
    db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = 'bob'")
      .run(Date.now() - 5 * 60_000);
    mamoru.pollOnce();

    const tasks = [...mamoru.getOutboundTasks().values()];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.workerSessionId).toBe("carol");
    expect(tasks[0]!.gate).toBe("milestone");

    // carol's eventual task_done engages the gate.
    taskDone(db, "carol", tasks[0]!.taskId, "requeued milestone done");
    mamoru.pollOnce();
    expect(mamoru.isGated()).toBe(true);
  });
});

describe("hive JSONL audit", () => {
  test("events append to per-identity audit file, including gate lifecycle", () => {
    const { rmSync, readFileSync, existsSync } = require("node:fs");
    const { join: joinPath } = require("node:path");
    const chan = `hive-audit-${Date.now()}`;
    const db = createTestDb();
    join(db, "self", "audited");

    const pi = createMockPi();
    const ctx = createMockCtx("self");
    const m = new Mamoru({
      db, sessionId: "self", agentName: "audited", channel: chan,
      persona: null, pi: pi as any, ctx: ctx as any,
      roster: new Roster(), config: { ...DEFAULT_MAMORU_CONFIG },
    });
    m.start();
    m.engageGate(null, "test");
    m.resume();

    const hiveFile = joinPath(getChannelDir(chan), "hive", "events-audited.jsonl");
    try {
      expect(existsSync(hiveFile)).toBe(true);
      const lines = readFileSync(hiveFile, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
      const events = lines.map((l: any) => l.event);
      expect(events).toContain("broadcast"); // join announcement
      expect(events).toContain("gated");
      expect(events).toContain("resumed");
      expect(lines.every((l: any) => l.agentName === "audited" && l.sessionId === "self")).toBe(true);
    } finally {
      rmSync(getChannelDir(chan), { recursive: true, force: true });
    }
  });
});
