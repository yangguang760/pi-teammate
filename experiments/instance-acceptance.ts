/**
 * Multi-instance acceptance — one role, N sessions, on the REAL stack.
 *
 * Proves:
 *  1. researcher and researcher-2 coexist in one channel (no takeover fight)
 *  2. directed messages reach only the addressed instance
 *  3. both instances carry the ROLE permission identity (active_agent =
 *     "researcher") while their channel identities differ
 *  4. crash-rejoin of researcher-2 takes over deterministically and replays
 *     downtime messages
 *
 * Run: npx tsx experiments/instance-acceptance.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../extensions/schema.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { createPayload, DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { getChannelDir } from "../extensions/paths.ts";
import { sendMessage, getAgentByName, getUnreadMessages, advanceCursor } from "../extensions/db.ts";

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
    cwd: "/tmp/instance-acceptance",
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => true, abort() {},
    ui: { notify() {}, setStatus() {} },
  };
}

const CHANNEL = "instaccept";
const RESEARCHER = { name: "researcher", description: "Researcher role" };

function fail(msg: string): never {
  console.error(`\n❌ ACCEPTANCE FAILED: ${msg}`);
  process.exit(1);
}

function spawnInstance(sessionId: string, agentName: string, channelDir: string) {
  const db = new Database(join(channelDir, "team.db"));
  const teammateDir = join(channelDir, "tm-" + sessionId);
  mkdirSync(teammateDir, { recursive: true });
  const mamoru = new Mamoru({
    db, sessionId, agentName, channel: CHANNEL,
    persona: RESEARCHER, pi: makeMockPi() as any, ctx: makeMockCtx(sessionId) as any,
    roster: new Roster(), config: DEFAULT_MAMORU_CONFIG, teammateDir,
  });
  mamoru.start();
  return { db, mamoru, teammateDir };
}

async function main() {
  const channelDir = getChannelDir(CHANNEL);
  rmSync(channelDir, { recursive: true, force: true });
  mkdirSync(channelDir, { recursive: true });
  const boot = new Database(join(channelDir, "team.db"));
  initSchema(boot);
  boot.close();

  // 1) two instances of the same role coexist
  const i1 = spawnInstance("s1", "researcher", channelDir);
  const i2 = spawnInstance("s2", "researcher-2", channelDir);

  const row1 = getAgentByName(i1.db, "researcher");
  const row2 = getAgentByName(i2.db, "researcher-2");
  if (!row1 || row1.session_id !== "s1") fail("researcher row missing/misowned");
  if (!row2 || row2.session_id !== "s2") fail("researcher-2 row missing/misowned");
  console.log("✓ 1. researcher + researcher-2 coexist as distinct agents");

  // 2) directed message reaches only the addressed instance
  sendMessage(i1.db, {
    from_agent: "s1", to_agent: "s2", channel: CHANNEL,
    task_id: null, ref_message_id: null,
    payload: JSON.stringify(createPayload("task_req", "analyze dataset A", { intent: "run analysis", detail: "/tmp/a.md", need_reply: true })),
  });
  const unread2 = getUnreadMessages(i2.db, "s2", CHANNEL, []);
  if (!unread2.some((m: any) => m.from_agent === "s1" && m.payload.includes("analyze dataset A"))) {
    const all = i2.db.prepare("SELECT message_id, from_agent, to_agent, channel, substr(payload,1,60) AS p FROM messages").all();
    console.error("DEBUG messages:", JSON.stringify(all, null, 1));
    console.error("DEBUG unread2:", JSON.stringify(unread2));
    fail("researcher-2 did not receive the directed task_req");
  }
  const unread1 = getUnreadMessages(i1.db, "s1", CHANNEL, []);
  if (unread1.some((m: any) => m.payload.includes("analyze dataset A")))
    fail("researcher received a message addressed to researcher-2");
  advanceCursor(i2.db, "s2", CHANNEL, unread2[unread2.length - 1]!.id);
  console.log("✓ 2. directed message routed only to researcher-2");

  // 3) permission identity is the ROLE for both instances
  const tag1 = i1.mamoru.buildSystemPromptAdditions("base")?.systemPrompt ?? "";
  const tag2 = i2.mamoru.buildSystemPromptAdditions("base")?.systemPrompt ?? "";
  if (!tag1.includes('<active_agent name="researcher">')) fail("instance 1 tag is not the role name");
  if (!tag2.includes('<active_agent name="researcher">')) fail("instance 2 tag is not the role name");
  if (!tag2.includes('Your channel identity is "researcher-2"')) fail("instance 2 card lacks channel identity");
  console.log('✓ 3. both instances key walls on "researcher"; instance 2 card says researcher-2');

  // 4) crash-rejoin of researcher-2: downtime message replays, takeover is deterministic
  i2.mamoru.stop();
  i2.db.close();
  sendMessage(i1.db, {
    from_agent: "s1", to_agent: "s2", channel: CHANNEL,
    task_id: null, ref_message_id: null,
    payload: JSON.stringify(createPayload("task_req", "analyze dataset B", { intent: "rerun", detail: "/tmp/b.md", need_reply: true })),
  });
  const i2b = spawnInstance("s2b", "researcher-2", channelDir);
  const unreadRejoin = getUnreadMessages(i2b.db, "s2b", CHANNEL, []);
  if (!unreadRejoin.some((m: any) => m.payload.includes("analyze dataset B")))
    fail("rejoined researcher-2 did not replay the downtime task_req");
  const row2b = getAgentByName(i2b.db, "researcher-2");
  if (!row2b || row2b.session_id !== "s2b") fail("takeover did not rebind researcher-2 to the new session");
  console.log("✓ 4. researcher-2 rejoined: takeover rebound s2→s2b, downtime task_req replayed");

  i1.mamoru.stop(); i1.db.close();
  i2b.mamoru.stop(); i2b.db.close();
  console.log("\n✅ INSTANCE ACCEPTANCE PASSED — one role, N sessions, shared walls, deterministic takeover");
}

main().catch((err) => fail(err?.stack ?? String(err)));
