/**
 * Outbound watchdog tests (B2): a worker that dies mid-task must not hold its
 * task until the legacy 20-minute timeout. The watchdog parks the task and
 * requeues it to a live teammate, dead-lettering after maxRequeueAttempts.
 */
import { describe, test, expect } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import type { MamoruConfig } from "../extensions/types.ts";
import { registerAgent, sendMessage, getUnreadMessages, isLeaseAlive } from "../extensions/db.ts";
import { createPayload } from "../extensions/types.ts";

const CHANNEL = "general";

function makeConfig(overrides?: Partial<MamoruConfig>): MamoruConfig {
  return { ...DEFAULT_MAMORU_CONFIG, ...overrides };
}

function joinRemote(db: any, sessionId: string, name: string) {
  registerAgent(db, {
    session_id: sessionId,
    agent_name: name,
    description: null,
    provider: null,
    model: null,
    cwd: "/tmp",
  });
  // registration stamps a fresh heartbeat
}

function createMamoru(overrides?: {
  db?: any;
  sessionId?: string;
  agentName?: string;
  config?: Partial<MamoruConfig>;
}) {
  const db = overrides?.db ?? createTestDb();
  const pi = createMockPi();
  const sessionId = overrides?.sessionId ?? "self";
  const ctx = createMockCtx(sessionId);
  const mamoru = new Mamoru({
    db,
    sessionId,
    agentName: overrides?.agentName ?? "coordinator",
    channel: CHANNEL,
    persona: null,
    pi: pi as any,
    ctx: ctx as any,
    roster: new Roster(),
    config: makeConfig(overrides?.config),
  });
  return { mamoru, db, pi, ctx };
}

function sendTask(db: any, from: string, to: string, content: string): number {
  return sendMessage(db, {
    from_agent: from,
    to_agent: to,
    channel: CHANNEL,
    task_id: null,
    ref_message_id: null,
    payload: JSON.stringify(createPayload("task_req", content, { intent: "build", need_reply: true })),
  });
}

describe("outbound watchdog", () => {
  test("dead worker's task is requeued to a live teammate", () => {
    const { mamoru, db, ctx } = createMamoru();
    mamoru.start();

    joinRemote(db, "bob", "bob");
    joinRemote(db, "carol", "carol");
    mamoru.getRoster().initFromDb(db, "self");

    // Task sent to bob, watchdog metadata attached (as send-message does).
    const taskId = sendTask(db, "self", "bob", "write the report");
    mamoru.registerOutboundTask(taskId, "bob", {
      content: "write the report",
      detail: null,
      intent: "build",
    });

    // bob dies.
    db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = 'bob'")
      .run(Date.now() - 5 * 60_000);

    mamoru.pollOnce();

    // Task requeued to carol as a NEW task_req.
    const carolUnread = getUnreadMessages(db, "carol", CHANNEL).filter(m => m.payload.includes("write the report"));
    expect(carolUnread).toHaveLength(1);
    expect(carolUnread[0]!.payload).toContain("write the report");
    expect(carolUnread[0]!.from_agent).toBe("self");

    // Outbound tracking now points at carol, attempt counter bumped.
    const tasks = [...mamoru.getOutboundTasks().values()];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.workerSessionId).toBe("carol");
    expect(tasks[0]!.requeueAttempts).toBe(1);

    expect(ctx.notifications.some(n => n.message.includes("requeued"))).toBe(true);
  });

  test("no live candidate: task stays parked, then requeues when one joins", () => {
    const { mamoru, db } = createMamoru({ config: { leaseTtlMs: 100 } });
    mamoru.start();

    joinRemote(db, "bob", "bob");
    mamoru.getRoster().initFromDb(db, "self");

    const taskId = sendTask(db, "self", "bob", "solo task");
    mamoru.registerOutboundTask(taskId, "bob", {
      content: "solo task",
      detail: null,
      intent: null,
    });

    // bob dies with nobody else around.
    db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = 'bob'")
      .run(Date.now() - 5 * 60_000);
    mamoru.pollOnce();

    // Parked: nothing tracked, task waits for a live teammate.
    expect((mamoru as any).parkedRequeues.size).toBe(1);
    expect(mamoru.getOutboundTasks().size).toBe(0);

    // carol joins alive — next poll requeues.
    joinRemote(db, "carol", "carol");
    mamoru.getRoster().initFromDb(db, "self");
    mamoru.pollOnce();

    expect(mamoru.getOutboundTasks().size).toBe(1);
    const tasks = [...mamoru.getOutboundTasks().values()];
    expect(tasks[0]!.workerSessionId).toBe("carol");
    expect(tasks[0]!.content).toBe("solo task");
  });

  test("dead-letters after maxRequeueAttempts with no candidates", () => {
    const { mamoru, db, ctx } = createMamoru({ config: { leaseTtlMs: 100, maxRequeueAttempts: 3 } });
    mamoru.start();

    // Inject a parked requeue that already burned 3 attempts, no candidates.
    (mamoru as any).parkedRequeues.set(42, {
      taskId: 42,
      deadWorkerSessionId: "bob",
      content: "hopeless task",
      detail: null,
      intent: null,
      attempts: 3,
      parkedAt: Date.now(),
    });

    mamoru.pollOnce();

    expect((mamoru as any).parkedRequeues.size).toBe(0);
    expect(ctx.notifications.some(n => n.message.includes("dead-lettered"))).toBe(true);
  });

  test("dead-letters when parked too long without any candidate", () => {
    const { mamoru, db, ctx } = createMamoru({ config: { leaseTtlMs: 100 } });
    mamoru.start();

    (mamoru as any).parkedRequeues.set(7, {
      taskId: 7,
      deadWorkerSessionId: "bob",
      content: "waiting task",
      detail: null,
      intent: null,
      attempts: 0,
      parkedAt: Date.now() - 100 * 5, // 5x TTL ago
    });

    mamoru.pollOnce();

    expect((mamoru as any).parkedRequeues.size).toBe(0);
    expect(ctx.notifications.some(n => n.message.includes("dead-lettered"))).toBe(true);
  });

  test("tasks without watchdog metadata are untouched (legacy path)", () => {
    const { mamoru, db, ctx } = createMamoru({ config: { leaseTtlMs: 100 } });
    mamoru.start();

    // Legacy registration: no content → no watchdog.
    const taskId = sendTask(db, "self", "bob", "legacy task");
    mamoru.registerOutboundTask(taskId, "bob");

    db.prepare("UPDATE agents SET last_heartbeat = ? WHERE session_id = 'bob'")
      .run(Date.now() - 5 * 60_000);
    mamoru.pollOnce();

    expect(mamoru.getOutboundTasks().has(taskId)).toBe(true);
    expect(ctx.notifications.filter(n => n.message.includes("watchdog"))).toHaveLength(0);
    void isLeaseAlive;
  });
});
