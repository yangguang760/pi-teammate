/**
 * Crash-fix acceptance — foreign takeover must not kill the host process.
 *
 * Reproduces the reported bug on the REAL stack (better-sqlite3 enforces FKs;
 * the bun test shim does not):
 *   1. mamoru s1 "researcher" polls a channel
 *   2. a foreign session takes over the identity → agents row s1 deleted
 *   3. OLD behavior: pollOnce → advanceCursor → FK violation → uncaught timer
 *      exception → whole pi process dies (exit 1)
 *   4. NEW behavior: pollOnce detects the lost identity and detaches —
 *      process survives
 *
 * Run: npx tsx experiments/detach-acceptance.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../extensions/schema.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { createPayload, DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { getChannelDir } from "../extensions/paths.ts";
import { sendMessage, advanceCursor, registerAgent, getAgentBySession } from "../extensions/db.ts";

function makeMockPi() {
  return {
    sendUserMessage() {},
    registerTool() {}, registerCommand() {},
    setModel: async () => true, setThinkingLevel() {},
    getActiveTools: () => [], setActiveTools() {}, registerFlag() {},
    getFlag: () => undefined,
    events: { emit() {}, on() {} },
  };
}
function makeMockCtx(sessionId: string) {
  return {
    cwd: "/tmp/detach-acceptance",
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => true, abort() {},
    ui: { notify() {}, setStatus() {} },
  };
}

const CHANNEL = "detachaccept";
function fail(msg: string): never {
  console.error(`\n❌ ACCEPTANCE FAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  const channelDir = getChannelDir(CHANNEL);
  rmSync(channelDir, { recursive: true, force: true });
  mkdirSync(channelDir, { recursive: true });
  const db = new Database(join(channelDir, "team.db"));
  initSchema(db);
  const teammateDir = join(channelDir, "tm-s1");
  mkdirSync(teammateDir, { recursive: true });

  // Foreign peer must exist so the directed send passes from_agent FK.
  registerAgent(db, {
    session_id: "foreign", agent_name: "manager", description: "coordinator",
    provider: null as any, model: null as any, cwd: "/tmp",
  });

  const mamoru = new Mamoru({
    db, sessionId: "s1", agentName: "researcher", channel: CHANNEL,
    persona: { name: "researcher", description: "Researcher" },
    pi: makeMockPi() as any, ctx: makeMockCtx("s1") as any,
    roster: new Roster(), config: DEFAULT_MAMORU_CONFIG, teammateDir,
  });
  mamoru.start();
  if (!getAgentBySession(db, "s1")) fail("s1 row not registered by start()");

  // Pending directed message so pollOnce has real work (incl. cursor advance).
  sendMessage(db, {
    from_agent: "foreign", to_agent: "s1", channel: CHANNEL,
    task_id: null, ref_message_id: null,
    payload: JSON.stringify(createPayload("task_req", "do work", { intent: "task", need_reply: true })),
  });

  // Foreign takeover deletes our identity rows (takeoverIdentity semantics:
  // copy cursor to the new session, then remove the old session's rows with
  // FK suspended — historical messages keep their from_agent strings by design).
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM agent_cursors WHERE session_id = ?").run("s1");
  db.prepare("DELETE FROM agents WHERE session_id = ?").run("s1");
  db.pragma("foreign_keys = ON");

  // Prove the crash mechanism exists on the real stack: a raw cursor write
  // with the dangling session_id MUST throw FK.
  let fkThrew = false;
  try {
    advanceCursor(db, "s1", CHANNEL, 1);
  } catch (err: any) {
    fkThrew = String(err?.code ?? "").includes("SQLITE_CONSTRAINT") || /FOREIGN KEY/.test(String(err?.message));
  }
  if (!fkThrew) fail("advanceCursor did NOT throw on dangling session — cannot reproduce the bug (FK not enforced?)");
  console.log("✓ crash mechanism reproduced: raw advanceCursor throws FK on dangling session");

  // THE FIX: pollOnce must survive the same state — detach, not crash.
  try {
    mamoru.pollOnce();
  } catch (err: any) {
    fail(`pollOnce threw after foreign takeover: ${err?.message}`);
  }
  if (!mamoru.isDetached()) fail("pollOnce survived but did not detach");
  console.log("✓ pollOnce with dangling identity: no throw, mamoru detached");

  // Repeated ticks stay safe.
  mamoru.pollOnce();
  mamoru.pollOnce();
  if (!mamoru.isDetached()) fail("detached state lost on repeated ticks");
  console.log("✓ repeated ticks after detach: stable, process alive");

  mamoru.stop();
  db.close();
  console.log("\n✅ DETACH ACCEPTANCE PASSED — background poll no longer kills the host on foreign takeover");
}

main().catch((err) => fail(err?.stack ?? String(err)));
