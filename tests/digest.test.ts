/**
 * M3-lite digest tests: informational broadcasts (broadcast/info_only with
 * need_reply=false) no longer interrupt the LLM one-by-one — they buffer and
 * merge into a single digest injected at the next turn boundary.
 */
import { describe, test, expect } from "bun:test";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG, createPayload } from "../extensions/types.ts";
import { registerAgent, initCursor, sendMessage } from "../extensions/db.ts";

const CHANNEL = "general";

function setup(sessionId = "self-session", agentName = "coordinator") {
  const db = createTestDb();
  const pi = createMockPi();
  const ctx = createMockCtx(sessionId);
  const mamoru = new Mamoru({
    db, sessionId, agentName, channel: CHANNEL,
    persona: null, pi: pi as any, ctx: ctx as any,
    roster: new Roster(), config: { ...DEFAULT_MAMORU_CONFIG },
  });
  return { mamoru, db, pi, ctx };
}

function joinRemote(db: any, sessionId: string, name: string) {
  registerAgent(db, {
    session_id: sessionId, agent_name: name,
    description: null, provider: null, model: null, cwd: "/tmp",
  });
  initCursor(db, sessionId, CHANNEL);
}

function sendFrom(db: any, from: string, event: any, content: string, needReply = false, to: string | null = null) {
  return sendMessage(db, {
    from_agent: from, to_agent: to, channel: CHANNEL,
    task_id: null, ref_message_id: null,
    payload: JSON.stringify(createPayload(event, content, { need_reply: needReply })),
  });
}

describe("M3-lite digest", () => {
  test("informational broadcast is buffered, not injected", () => {
    const { mamoru, db, pi } = setup();
    mamoru.start();
    joinRemote(db, "bob", "bob");
    mamoru.pollOnce(); // consume join broadcast

    sendFrom(db, "bob", "broadcast", "mockups updated");
    mamoru.pollOnce();

    expect(pi.sentUserMessages.some((m) => String(m.content).includes("mockups updated"))).toBe(false);
    expect(mamoru.buildDigestBlock()).toContain("mockups updated");
    mamoru.stop();
  });

  test("digest block clears after read", () => {
    const { mamoru, db } = setup();
    mamoru.start();
    joinRemote(db, "bob", "bob");

    sendFrom(db, "bob", "info_only", "fyi only");
    mamoru.pollOnce();
    const block = mamoru.buildDigestBlock();
    expect(block).toContain("(info_only) bob: fyi only");
    expect(mamoru.buildDigestBlock()).toBeNull();
    mamoru.stop();
  });

  test("assertive broadcast (need_reply=true) still injects immediately", () => {
    const { mamoru, db, pi } = setup();
    mamoru.start();
    joinRemote(db, "bob", "bob");
    mamoru.pollOnce();

    sendFrom(db, "bob", "broadcast", "ALL HANDS NOW", true);
    mamoru.pollOnce();

    expect(pi.sentUserMessages.some((m) => String(m.content).includes("ALL HANDS NOW"))).toBe(true);
    expect(mamoru.buildDigestBlock()).toBeNull();
    mamoru.stop();
  });

  test("agent_join broadcasts update roster without entering the digest", () => {
    const { mamoru, db } = setup();
    mamoru.start();

    joinRemote(db, "carol", "carol"); // writes rows only
    // Simulate the join announcement MAMORU would deliver:
    sendMessage(db, {
      from_agent: "carol", to_agent: null, channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("broadcast", "carol has joined the channel", { intent: "agent_join" })),
    });
    mamoru.pollOnce();

    expect(mamoru.buildDigestBlock()).toBeNull();
    expect(mamoru.getRoster().get("carol")).toBeDefined();
    mamoru.stop();
  });

  test("digest caps display at 20 lines and notes the overflow", () => {
    const { mamoru, db } = setup();
    mamoru.start();
    joinRemote(db, "bob", "bob");
    mamoru.pollOnce();

    for (let i = 1; i <= 60; i++) {
      sendFrom(db, "bob", "broadcast", `noise ${i}`);
    }
    mamoru.pollOnce();

    const block = mamoru.buildDigestBlock()!;
    expect(block).toContain("[DIGEST] 50 informational messages");
    expect(block).toContain("noise 60");
    expect(block).not.toContain("noise 1\n");
    expect(block).toContain("older (see /team-history)");
    mamoru.stop();
  });

  test("task traffic (task_done) is never digested — it is real work", () => {
    const { mamoru, db, pi } = setup();
    mamoru.start();
    joinRemote(db, "bob", "bob");
    mamoru.pollOnce();

    sendMessage(db, {
      from_agent: "bob", to_agent: "self-session", channel: CHANNEL,
      task_id: null, ref_message_id: null,
      payload: JSON.stringify(createPayload("task_done", "work completed")),
    });
    mamoru.pollOnce();

    expect(pi.sentUserMessages.some((m) => String(m.content).includes("work completed"))).toBe(true);
    expect(mamoru.buildDigestBlock()).toBeNull();
    mamoru.stop();
  });
});
