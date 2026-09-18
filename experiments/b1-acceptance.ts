/**
 * B1 acceptance test — the black-hole fix, on the REAL stack.
 *
 * Uses the real better-sqlite3 database and the real Mamoru class (no bun
 * shim) to prove: crash → teammate reopens a NEW session with the same agent
 * name → every message sent during downtime is delivered.
 *
 * Run: npx tsx experiments/b1-acceptance.ts
 */
import { rmSync, existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { initSchema } from "../extensions/schema.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { createPayload, DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { getDbPath, getChannelDir } from "../extensions/paths.ts";
import { sendMessage, getAgentByName } from "../extensions/db.ts";

/** Minimal mock — same shape as tests/helpers/mock-pi.ts, but node-safe. */
function makeMockPi() {
  const sentUserMessages: Array<{ content: string; options?: any }> = [];
  return {
    sentUserMessages,
    sendUserMessage(content: string, options?: any) { sentUserMessages.push({ content, options }); },
    registerTool() {},
    registerCommand() {},
    setModel: async () => true,
    setThinkingLevel() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerFlag() {},
    getFlag: () => undefined,
    events: { emit() {}, on() {} },
  };
}

function makeMockCtx(sessionId: string) {
  return {
    cwd: "/tmp/b1-acceptance",
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => true,
    abort() {},
    ui: { notify() {}, setStatus() {} },
  };
}

const CHANNEL = "b1accept";

function fail(msg: string): never {
  console.error(`\n❌ ACCEPTANCE FAILED: ${msg}`);
  process.exit(1);
}

// ── Clean channel ─────────────────────────────────────────────
const channelDir = getChannelDir(CHANNEL);
if (existsSync(channelDir)) rmSync(channelDir, { recursive: true, force: true });
mkdirSync(channelDir, { recursive: true });

const db = new Database(getDbPath(CHANNEL));
initSchema(db);

function payload(event: any, content: string) {
  return JSON.stringify(createPayload(event, content));
}

// ── Phase 1: alice alive (session p1-alice) ───────────────────
const pi1 = makeMockPi();
const m1 = new Mamoru({
  db,
  sessionId: "p1-alice",
  agentName: "alice",
  channel: CHANNEL,
  persona: null,
  pi: pi1 as any,
  ctx: makeMockCtx("p1-alice") as any,
  roster: new Roster(),
  config: { ...DEFAULT_MAMORU_CONFIG },
});
m1.start();

// ── bob joins and works with alice ────────────────────────────
const piBob = makeMockPi();
const bob = new Mamoru({
  db,
  sessionId: "p1-bob",
  agentName: "bob",
  channel: CHANNEL,
  persona: null,
  pi: piBob as any,
  ctx: makeMockCtx("p1-bob") as any,
  roster: new Roster(),
  config: { ...DEFAULT_MAMORU_CONFIG },
});
bob.start();
bob.pollOnce(); // consume join broadcasts

const aliceRow = getAgentByName(db, "alice");
if (!aliceRow) fail("alice not registered");

// pre-crash message: delivered normally
sendMessage(db, {
  from_agent: "p1-bob", to_agent: aliceRow!.session_id, channel: CHANNEL,
  task_id: null, ref_message_id: null, payload: payload("task_req", "PRE-CRASH task"),
});
m1.pollOnce();
if (!pi1.sentUserMessages.some((m) => String(m.content).includes("PRE-CRASH"))) {
  fail("pre-crash message not delivered");
}
console.log("✓ phase 1: pre-crash delivery works");

// ── Phase 2: alice CRASHES (kill timer, never stop()) ─────────
for (const key of ["pollTimer", "leaseTimer"] as const) {
  const t = (m1 as any)[key];
  if (t !== null && t !== undefined) clearInterval(t);
}
console.log("✓ phase 2: alice process killed (no stop(), zombie row stays)");

// ── Phase 3: downtime — bob sends messages into the void ──────
sendMessage(db, {
  from_agent: "p1-bob", to_agent: aliceRow!.session_id, channel: CHANNEL,
  task_id: null, ref_message_id: null, payload: payload("task_req", "DOWNTIME-DIRECTED task"),
});
sendMessage(db, {
  from_agent: "p1-bob", to_agent: null, channel: CHANNEL,
  task_id: null, ref_message_id: null, payload: payload("broadcast", "DOWNTIME-BROADCAST hello all"),
});
console.log("✓ phase 3: 2 downtime messages sent (1 directed, 1 broadcast)");

// ── Phase 4: alice reborn in a BRAND-NEW session ──────────────
const pi2 = makeMockPi();
const m2 = new Mamoru({
  db,
  sessionId: "p2-alice", // ← the new session id that used to cause the black hole
  agentName: "alice",
  channel: CHANNEL,
  persona: null,
  pi: pi2 as any,
  ctx: makeMockCtx("p2-alice") as any,
  roster: new Roster(),
  config: { ...DEFAULT_MAMORU_CONFIG },
});
m2.start();

if (m2.getPreviousSessionIds().join() !== "p1-alice") {
  fail(`takeover did not claim p1-alice (got: ${m2.getPreviousSessionIds()})`);
}
console.log("✓ phase 4: new session took over identity 'alice' from p1-alice");

m2.pollOnce();

const injected = pi2.sentUserMessages.map((m) => String(m.content)).join("\n");
if (!injected.includes("DOWNTIME-DIRECTED")) fail("directed downtime message lost");
if (!injected.includes("DOWNTIME-BROADCAST")) fail("broadcast downtime message lost");
if (injected.includes("PRE-CRASH")) fail("already-consumed message replayed");
if (injected.includes("alice has joined")) fail("own old broadcast replayed to self");
console.log("✓ phase 5: both downtime messages delivered, zero duplication");

// ── Phase 6: zombie row gone ──────────────────────────────────
const now = getAgentByName(db, "alice");
if (!now || now.session_id !== "p2-alice") fail("zombie row not removed");
if (db.prepare("SELECT * FROM agents WHERE session_id = 'p1-alice'").get()) {
  fail("old session row still present");
}
console.log("✓ phase 6: zombie row removed, identity bound to p2-alice");

m2.stop();
bob.stop();
db.close();

console.log("\n✅ B1 ACCEPTANCE PASSED — black hole eliminated");
