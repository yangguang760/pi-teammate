/**
 * B2 acceptance test — presence lease + outbound watchdog on the REAL stack.
 *
 * Proves: a worker that dies mid-task does NOT hold its task until the legacy
 * timeout. The coordinator's watchdog parks the task and requeues it to a
 * live teammate within one poll cycle.
 *
 * Run: npx tsx experiments/b2-acceptance.ts
 */
import { rmSync, existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { initSchema } from "../extensions/schema.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { createPayload, DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { getDbPath, getChannelDir } from "../extensions/paths.ts";
import { sendMessage, sendTaskReq, getAgentByName } from "../extensions/db.ts";

function makeMockPi() {
  const sentUserMessages: Array<{ content: string; options?: any }> = [];
  return {
    sentUserMessages,
    sendUserMessage(content: string, options?: any) { sentUserMessages.push({ content, options }); },
    registerTool() {}, registerCommand() {},
    setModel: async () => true, setThinkingLevel() {},
    getActiveTools: () => [], setActiveTools() {}, registerFlag() {},
    getFlag: () => undefined,
    events: { emit() {}, on() {} },
  };
}
function makeMockCtx(sessionId: string) {
  return {
    cwd: "/tmp/b2-acceptance",
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => true, abort() {},
    ui: {
      notifications: [] as string[],
      notify(msg: string) { this.notifications.push(msg); },
      setStatus() {},
    },
  };
}

const CHANNEL = "b2accept";
function fail(msg: string): never {
  console.error(`\n❌ ACCEPTANCE FAILED: ${msg}`);
  process.exit(1);
}

const channelDir = getChannelDir(CHANNEL);
if (existsSync(channelDir)) rmSync(channelDir, { recursive: true, force: true });
mkdirSync(channelDir, { recursive: true });

const db = new Database(getDbPath(CHANNEL));
initSchema(db);

// ── Three teammates join ──────────────────────────────────
async function main() {
function join(sessionId: string, name: string, configOverrides?: Partial<typeof DEFAULT_MAMORU_CONFIG>) {
  const pi = makeMockPi();
  const ctx = makeMockCtx(sessionId) as any;
  const m = new Mamoru({
    db, sessionId, agentName: name, channel: CHANNEL,
    persona: null, pi: pi as any, ctx, roster: new Roster(),
    config: { ...DEFAULT_MAMORU_CONFIG, ...configOverrides },
  });
  m.start();
  return { m, pi, ctx };
}

const coord = join("p1-coord", "coordinator", { leaseTtlMs: 3000 });
const alice = join("p1-alice", "alice");
const bob = join("p1-bob", "bob");
for (const x of [coord, alice, bob]) x.m.pollOnce(); // consume join broadcasts

// ── Phase 1: coordinator dispatches a task to alice ───────────
const aliceRow = getAgentByName(db, "alice");
if (!aliceRow) fail("alice not registered");
const aliceSessionId = aliceRow!.session_id;

const messageId = sendTaskReq(db, {
  from_agent: "p1-coord",
  to_agent: aliceSessionId,
  channel: CHANNEL,
  payload: JSON.stringify(createPayload("task_req", "REFACTOR module X", { intent: "build", need_reply: true })),
  maxContentWords: 40,
});
coord.m.registerOutboundTask(messageId, aliceSessionId, {
  content: "REFACTOR module X",
  detail: null,
  intent: "build",
});
console.log(`✓ phase 1: task #${messageId} dispatched to alice (${aliceSessionId})`);

// alice acks by working: her poll picks it up, MAMORU auto-acks
alice.m.pollOnce();
if (!alice.pi.sentUserMessages.some((m) => String(m.content).includes("REFACTOR"))) {
  fail("alice never received the task");
}
console.log("✓ phase 2: alice received task and is working");

// ── Phase 3: alice's process DIES mid-task (no stop()) ────────
for (const key of ["pollTimer", "leaseTimer"] as const) {
  const t = (alice.m as any)[key];
  if (t !== null) clearInterval(t);
}
console.log("✓ phase 3: alice killed mid-task (lease stops renewing)");

// Wait out the coordinator's 3s lease TTL — this is the honest timing: the
// watchdog fires when the lease expires, not on kill.
await new Promise((r) => setTimeout(r, 3500));

// ── Phase 4: coordinator notices and requeues to bob ──────────
coord.m.pollOnce();

const notifications = (coord.ctx.ui as any).notifications as string[];
if (!notifications.some(n => n.includes("watchdog") && n.includes("requeued"))) {
  fail(`watchdog did not requeue: ${JSON.stringify(notifications)}`);
}

const tasks = [...coord.m.getOutboundTasks().values()];
if (tasks.length !== 1 || tasks[0]!.workerSessionId !== "p1-bob") {
  fail(`outbound tracking not moved to bob: ${JSON.stringify(tasks)}`);
}
if (tasks[0]!.requeueAttempts !== 1) fail(`attempts=${tasks[0]!.requeueAttempts}, want 1`);

const bobRow = getAgentByName(db, "bob");
const bobUnread = (bob.m as any).roster ? null : null; // roster check below via DB
const requeued = db.prepare(
  "SELECT payload, to_agent FROM messages WHERE payload LIKE '%REFACTOR module X%' AND to_agent = ?",
).all("p1-bob");
if (requeued.length < 1) fail("bob never received the requeued task");
console.log("✓ phase 4: watchdog requeued task to bob within one poll cycle");

// ── Phase 5: dead alice's identity is tombstoned; rejoin still works ──
const aliceNow = getAgentByName(db, "alice");
if (!aliceNow || aliceNow.status !== "inactive") fail("dead alice not tombstoned as inactive");
console.log("✓ phase 5: dead alice tombstoned (row kept for display/takeover)");

// bob picks up the requeued task
bob.m.pollOnce();
if (!bob.pi.sentUserMessages.some((m) => String(m.content).includes("REFACTOR"))) {
  fail("bob never received the requeued task");
}
console.log("✓ phase 6: bob received and started the requeued task");

for (const x of [coord, bob]) x.m.stop();
db.close();

console.log("\n✅ B2 ACCEPTANCE PASSED — dead workers no longer hold tasks hostage");
}

main().catch((e) => { console.error(e); process.exit(1); });
