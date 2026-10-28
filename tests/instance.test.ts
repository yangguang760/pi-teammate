import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerCommands } from "../extensions/commands.ts";
import { personaIdentityTag } from "../extensions/persona.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";

// ── /team-join instance harness ──────────────────────────────────

function setup() {
  const pi = createMockPi();
  let mamoru: any = null;
  let extCtx: any = null;
  const bootstrapCalls: Array<{ channel: string; agentName: string; persona: any }> = [];
  const runtimes = new Map<string, any>();

  const { hintRegistry } = registerCommands(
    pi as any,
    () => mamoru,
    (m) => { mamoru = m; },
    () => extCtx as any,
    {
      bootstrapMamoru: (_ctx: any, channel: string, agentName: string, persona: any) => {
        bootstrapCalls.push({ channel, agentName, persona });
        const fake = { getAgentName: () => agentName, stop: () => {} };
        mamoru = fake;
        runtimes.set(channel, { channel, mamoru: fake, db: {} });
      },
      multi: {
        has: (channel: string) => runtimes.has(channel),
        leave: (channel: string) => { runtimes.delete(channel); return true; },
        leaveAll: () => runtimes.clear(),
        all: () => [...runtimes.values()],
        primary: () => null,
      },
    },
  );

  return {
    pi,
    hintRegistry,
    bootstrapCalls,
    setExtCtx: (c: any) => { extCtx = c; },
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-teammate-instance-test-"));
}

function writeResearcherPersona(dir: string): void {
  mkdirSync(join(dir, "persona"), { recursive: true });
  writeFileSync(
    join(dir, "persona", "researcher.yaml"),
    'name: "researcher"\ndescription: Researcher role\n',
    "utf-8",
  );
}

// ── /team-join instance argument ─────────────────────────────────

describe("/team-join multi-instance", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("instance suffix joins as researcher-2 with persona resolved", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeResearcherPersona(tmpDir);

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev researcher 2", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].agentName).toBe("researcher-2");
    expect(bootstrapCalls[0].persona?.name).toBe("researcher");
  });

  test("non-numeric instance is rejected without joining", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeResearcherPersona(tmpDir);

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev researcher alice", ctx);

    expect(bootstrapCalls).toHaveLength(0);
  });

  test("instance 0 is rejected", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeResearcherPersona(tmpDir);

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev researcher 0", ctx);

    expect(bootstrapCalls).toHaveLength(0);
  });

  test("no instance keeps the unsuffixed identity", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeResearcherPersona(tmpDir);

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev researcher", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].agentName).toBe("researcher");
  });

  test("instance with legacy persona.yaml default role", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeFileSync(join(tmpDir, "persona.yaml"), 'name: "researcher"\ndescription: x\n', "utf-8");

    const cmd = pi.registeredCommands.get("team-join");
    await cmd.handler("dev researcher 3", ctx);

    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].agentName).toBe("researcher-3");
  });

  test("rejoining the same instance after leave takes over deterministically", async () => {
    const { pi, bootstrapCalls, setExtCtx } = setup();
    const ctx = createMockCtx({ sessionId: "sess-1", cwd: tmpDir });
    setExtCtx(ctx);
    writeResearcherPersona(tmpDir);

    const join = pi.registeredCommands.get("team-join");
    const leave = pi.registeredCommands.get("team-leave");
    await join.handler("dev researcher 2", ctx);
    await leave.handler("dev", ctx);
    await join.handler("dev researcher 2", ctx);

    expect(bootstrapCalls).toHaveLength(2);
    expect(bootstrapCalls[1].agentName).toBe("researcher-2");
  });
});

// ── personaIdentityTag — permission identity is the role name ────

describe("personaIdentityTag role-name keying", () => {
  test("uses persona.name even when channelName differs", () => {
    const tag = personaIdentityTag({ name: "researcher", description: "x", channelName: "researcher-x" } as any);
    expect(tag).toBe('<active_agent name="researcher"></active_agent>');
  });

  test("plain persona unchanged", () => {
    const tag = personaIdentityTag({ name: "researcher", description: "x" } as any);
    expect(tag).toBe('<active_agent name="researcher"></active_agent>');
  });
});

// ── Mamoru system prompt — dual identity ─────────────────────────

describe("Mamoru buildSystemPromptAdditions dual identity", () => {
  function buildMamoru(agentName: string, persona: any) {
    const db = createTestDb();
    const mamoru = new Mamoru({
      db,
      sessionId: "self-session",
      agentName,
      channel: "general",
      persona,
      pi: createMockPi(),
      ctx: createMockCtx("self-session"),
      roster: new Roster(),
      config: DEFAULT_MAMORU_CONFIG,
      teammateDir: mkdtempSync(join(tmpdir(), "pi-teammate-inst-mamoru-")),
    });
    return mamoru;
  }

  test("instance session: tag carries role, card carries channel identity", () => {
    const mamoru = buildMamoru("researcher-2", { name: "researcher", description: "Researcher" });
    const result = mamoru.buildSystemPromptAdditions("base");
    const text = result?.systemPrompt ?? "";
    expect(text).toContain('<active_agent name="researcher">');
    expect(text).toContain('Your channel identity is "researcher-2"');
  });

  test("unsuffixed session with channelName keeps old behavior", () => {
    const mamoru = buildMamoru("rg-manager", { name: "manager", description: "Manager", channelName: "rg-manager" });
    const result = mamoru.buildSystemPromptAdditions("base");
    const text = result?.systemPrompt ?? "";
    expect(text).toContain('<active_agent name="manager">');
    expect(text).toContain('Your channel identity is "rg-manager"');
  });

  test("identity equal to role name emits no channel-identity line", () => {
    const mamoru = buildMamoru("researcher", { name: "researcher", description: "Researcher" });
    const result = mamoru.buildSystemPromptAdditions("base");
    const text = result?.systemPrompt ?? "";
    expect(text).toContain('<active_agent name="researcher">');
    expect(text).not.toContain("channel identity");
  });
});
