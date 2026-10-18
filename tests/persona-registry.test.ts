/**
 * L1 identity registry tests (M1): project-local persona/ registry, resolution
 * chain (--agent-name → persona/<name>.yaml → legacy persona.yaml), v2 fields
 * (workspace/channels/channelName/skills), and the permission-system bridge tag.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, createMockPi, createMockCtx } from "./helpers/mock-pi.ts";
import { Mamoru } from "../extensions/mamoru.ts";
import { Roster } from "../extensions/roster.ts";
import { DEFAULT_MAMORU_CONFIG } from "../extensions/types.ts";
import type { PersonaConfig } from "../extensions/types.ts";
import { loadPersona, loadPersonaByName, resolvePersona, channelIdentity, personaIdentityTag, personaIdentityCard } from "../extensions/persona.ts";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pt-m1-"));
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const GOOD = (name: string, extra = "") =>
  `name: "${name}"\ndescription: "test persona"\nprovider: "anthropic"\nmodel: "claude-sonnet-4-5"\n${extra}`;

describe("persona registry resolution chain", () => {
  test("legacy persona.yaml still loads (highest priority for legacy setups)", () => {
    const dir = makeProject({ "persona.yaml": GOOD("legacy") });
    const p = resolvePersona(dir, null);
    expect(p?.name).toBe("legacy");
    expect(p?.workspace).toBeUndefined();
  });

  test("--agent-name selects persona/<name>.yaml from the registry", () => {
    const dir = makeProject({
      "persona/developer.yaml": GOOD("dev", 'workspace: "/w"\nchannels: [proj-a, managers]\nchannelName: projx-dev\nskills: [code, test]\n'),
    });
    const p = resolvePersona(dir, "developer");
    expect(p?.name).toBe("dev");
    expect(p?.workspace).toBe("/w");
    expect(p?.channels).toEqual(["proj-a", "managers"]);
    expect(p?.channelName).toBe("projx-dev");
    expect(p?.skills).toEqual(["code", "test"]);
  });

  test("registry miss falls back to legacy persona.yaml", () => {
    const dir = makeProject({ "persona.yaml": GOOD("legacy") });
    const p = resolvePersona(dir, "ghost");
    expect(p?.name).toBe("legacy");
  });

  test("no persona anywhere → null (no throw)", () => {
    const dir = makeProject({});
    expect(resolvePersona(dir, null)).toBeNull();
    expect(resolvePersona(dir, "ghost")).toBeNull();
  });

  test("loadPersonaByName returns null on miss, throws on path escape", () => {
    const dir = makeProject({ "persona/a.yaml": GOOD("a") });
    expect(loadPersonaByName(dir, "a")?.name).toBe("a");
    expect(loadPersonaByName(dir, "missing")).toBeNull();
    expect(() => loadPersonaByName(dir, "../a")).toThrow();
  });
});

describe("v2 field validation", () => {
  test("invalid channelName rejected", () => {
    const dir = makeProject({ "persona/bad.yaml": GOOD("bad", 'channelName: "Has Spaces"\n') });
    expect(() => loadPersonaByName(dir, "bad")).toThrow(/channelName/);
  });

  test("non-array channels rejected", () => {
    const dir = makeProject({ "persona/bad.yaml": GOOD("bad", "channels: proj-a\n") });
    expect(() => loadPersonaByName(dir, "bad")).toThrow(/channels/);
  });

  test("channelIdentity defaults to name, honors channelName", () => {
    const dir = makeProject({
      "persona/plain.yaml": GOOD("plain"),
      "persona/qualified.yaml": GOOD("qualified", 'channelName: projx-qualified\n'),
    });
    expect(channelIdentity(loadPersonaByName(dir, "plain")!)).toBe("plain");
    expect(channelIdentity(loadPersonaByName(dir, "qualified")!)).toBe("projx-qualified");
  });
});

describe("permission-system bridge", () => {
  test("identity tag matches <active_agent name=\"...\"> and strips quotes", () => {
    const tag = personaIdentityTag({ name: "dev", channelName: "projx-dev" } as PersonaConfig);
    expect(tag).toBe(`<active_agent name="projx-dev"></active_agent>`);
  });

  test("identity card carries workspace, channels, skills", () => {
    const persona = {
      name: "dev",
      channels: ["proj-a"],
      skills: ["code"],
    } as PersonaConfig;
    const lines = personaIdentityCard(persona, "/work/dir");
    expect(lines).toContain("Workspace (your permission scope): /work/dir");
    expect(lines).toContain("Declared channels: proj-a");
    expect(lines).toContain("Skills: code");
  });
});

describe("Mamoru injects identity card + bridge tag", () => {
  test("system prompt additions carry tag, workspace, channel identity note", () => {
    const db = createTestDb();
    const pi = createMockPi();
    const ctx = createMockCtx("self-session");
    ctx.cwd = "/work/dir";
    const persona = {
      name: "dev",
      description: "test",
      channelName: "projx-dev",
      workspace: "/work/dir",
      channels: ["proj-a"],
      skills: ["code"],
    } as PersonaConfig;
    const mamoru = new Mamoru({
      db, sessionId: "self-session", agentName: "projx-dev", channel: "general",
      persona, pi: pi as any, ctx: ctx as any,
      roster: new Roster(), config: { ...DEFAULT_MAMORU_CONFIG },
    });

    const result = mamoru.buildSystemPromptAdditions("BASE");
    expect(result?.systemPrompt).toContain(`<active_agent name="projx-dev"></active_agent>`);
    expect(result?.systemPrompt).toContain(`Workspace (your permission scope): /work/dir`);
    expect(result?.systemPrompt).toContain(`You are "dev"`);
    expect(result?.systemPrompt).toContain(`channel identity is "projx-dev"`);
  });
});
