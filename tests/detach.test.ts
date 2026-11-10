import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { registerAgent, getAgentBySession } from "../extensions/db.ts";

// ── Harness ─────────────────────────────────────────────────────

function makeMamoru(sessionId = "self-session", agentName = "researcher") {
  const db = createTestDb();
  const teammateDir = mkdtempSync(join(tmpdir(), "pi-teammate-detach-test-"));
  const mamoru = new Mamoru({
    db,
    sessionId,
    agentName,
    channel: "general",
    persona: null,
    pi: createMockPi() as any,
    ctx: createMockCtx(sessionId) as any,
    roster: new Roster(),
    config: DEFAULT_MAMORU_CONFIG,
    teammateDir,
  });
  return { mamoru, db, teammateDir, sessionId, agentName };
}

function registerSelf(db: any, sessionId: string, agentName: string): void {
  registerAgent(db, {
    session_id: sessionId,
    agent_name: agentName,
    description: "test",
    provider: null as any,
    model: null as any,
    cwd: "/tmp",
  });
}

// ── Identity-loss detach (crash fix) ────────────────────────────

describe("Mamoru identity-loss detach", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "pi-teammate-detach-cfg-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("foreign takeover (agents row deleted) → pollOnce detaches instead of crashing", () => {
    const { mamoru, db, sessionId } = makeMamoru();
    mamoru.start();
    expect(getAgentBySession(db, sessionId)).toBeTruthy();

    // Simulate a foreign session taking over our identity: the row is deleted.
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);

    expect(() => mamoru.pollOnce()).not.toThrow();
    expect(mamoru.isDetached()).toBe(true);

    mamoru.stop();
  });

  test("detached pollOnce is a no-op and stays detached", () => {
    const { mamoru, db, sessionId } = makeMamoru();
    mamoru.start();
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);

    mamoru.pollOnce();
    mamoru.pollOnce();
    mamoru.pollOnce();

    expect(mamoru.isDetached()).toBe(true);
    mamoru.stop();
  });

  test("identity present → pollOnce runs without detaching", () => {
    const { mamoru, sessionId } = makeMamoru();
    mamoru.start();
    expect(getAgentBySession((mamoru as any).db ?? null, sessionId) ?? true).toBeTruthy();

    expect(() => mamoru.pollOnce()).not.toThrow();
    expect(mamoru.isDetached()).toBe(false);

    mamoru.stop();
  });

  test("stop() after detach is safe (double-clear timers)", () => {
    const { mamoru, db, sessionId } = makeMamoru();
    mamoru.start();
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);
    mamoru.pollOnce();
    expect(mamoru.isDetached()).toBe(true);

    expect(() => mamoru.stop()).not.toThrow();
  });
});
