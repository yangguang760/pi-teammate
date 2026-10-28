import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { PersonaConfig } from "./types.ts";

const PERSONA_FILE = "persona.yaml";
const PERSONA_DIR = "persona";

/** Channel identity must be a safe token: 1-48 lowercase letters/digits/hyphens, starting with a letter. */
const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;

function parsePersona(doc: unknown, source: string): PersonaConfig {
  if (doc == null || typeof doc !== "object") {
    throw new Error(`${source}: expected a YAML mapping, got ${doc === null ? "null" : typeof doc}`);
  }
  const d = doc as Record<string, unknown>;

  const name = d.name;
  const description = d.description;

  if (name == null || (typeof name === "string" && name.trim() === "")) {
    throw new Error(`${source}: 'name' is required and must not be empty`);
  }
  if (typeof name !== "string") {
    throw new Error(`${source}: 'name' must be a string`);
  }
  if (description == null || (typeof description === "string" && description.trim() === "")) {
    throw new Error(`${source}: 'description' is required and must not be empty`);
  }
  if (typeof description !== "string") {
    throw new Error(`${source}: 'description' must be a string`);
  }

  // Optional v2 fields (L1 identity registry)
  let workspace: string | undefined;
  if (d.workspace != null) {
    if (typeof d.workspace !== "string" || !d.workspace.trim()) {
      throw new Error(`${source}: 'workspace' must be a non-empty string`);
    }
    workspace = d.workspace.trim();
  }

  let channels: string[] | undefined;
  if (d.channels != null) {
    if (!Array.isArray(d.channels) || d.channels.some((c) => typeof c !== "string" || !c.trim())) {
      throw new Error(`${source}: 'channels' must be an array of non-empty strings`);
    }
    channels = (d.channels as string[]).map((c) => c.trim());
  }

  let channelName: string | undefined;
  if (d.channelName != null) {
    if (typeof d.channelName !== "string" || !CHANNEL_NAME_RE.test(d.channelName)) {
      throw new Error(
        `${source}: 'channelName' must be 1-48 lowercase letters/digits/hyphens, starting with a letter (got: ${JSON.stringify(d.channelName)})`,
      );
    }
    channelName = d.channelName;
  }

  let skills: string[] | undefined;
  if (d.skills != null) {
    if (!Array.isArray(d.skills) || d.skills.some((s) => typeof s !== "string" || !s.trim())) {
      throw new Error(`${source}: 'skills' must be an array of non-empty strings`);
    }
    skills = (d.skills as string[]).map((s) => s.trim());
  }

  // Collect any extra user-defined properties
  const knownKeys = new Set([
    "name", "description", "provider", "model", "thinkingLevel", "systemPrompt",
    "workspace", "channels", "channelName", "skills",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!knownKeys.has(k)) {
      extras[k] = v;
    }
  }

  // Validate thinkingLevel if present
  const validThinkingLevels = new Set(["off", "low", "medium", "high"]);
  let thinkingLevel: "off" | "low" | "medium" | "high" | null = null;
  if (d.thinkingLevel != null) {
    if (typeof d.thinkingLevel !== "string" || !validThinkingLevels.has(d.thinkingLevel)) {
      throw new Error(
        `${source}: 'thinkingLevel' must be one of: off, low, medium, high (got: ${JSON.stringify(d.thinkingLevel)})`,
      );
    }
    thinkingLevel = d.thinkingLevel as "off" | "low" | "medium" | "high";
  }

  return {
    name: name.trim(),
    description: description.trim(),
    provider: typeof d.provider === "string" ? d.provider : null,
    model: typeof d.model === "string" ? d.model : null,
    thinkingLevel,
    systemPrompt: typeof d.systemPrompt === "string" && d.systemPrompt.trim() !== ""
      ? d.systemPrompt.trim()
      : null,
    ...(workspace ? { workspace } : {}),
    ...(channels ? { channels } : {}),
    ...(channelName ? { channelName } : {}),
    ...(skills ? { skills } : {}),
    ...extras,
  };
}

/**
 * Load legacy single-file persona.yaml from the given directory.
 * Returns null if the file doesn't exist. Throws on invalid YAML or missing required fields.
 */
export function loadPersona(cwd: string): PersonaConfig | null {
  const filePath = join(cwd, PERSONA_FILE);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  return parsePersona(YAML.parse(raw), PERSONA_FILE);
}

/**
 * Load a named persona from the project registry: `<cwd>/persona/<name>.yaml`.
 * Returns null if the file doesn't exist (caller decides whether to fall back
 * to the legacy single-file persona or report the miss).
 */
export function loadPersonaByName(cwd: string, name: string): PersonaConfig | null {
  if (!name || /[/\\]/.test(name) || name.includes("..")) {
    throw new Error(`invalid persona name: ${JSON.stringify(name)}`);
  }
  const filePath = join(cwd, PERSONA_DIR, `${name}.yaml`);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  return parsePersona(YAML.parse(raw), `persona/${name}.yaml`);
}

/**
 * M1 resolution chain: an explicit --agent-name selects `<cwd>/persona/<name>.yaml`
 * from the project registry; when absent, fall back to the legacy single-file
 * persona.yaml (whose own 'name' field stays authoritative for legacy setups).
 */
export function resolvePersona(cwd: string, agentName: string | null | undefined): PersonaConfig | null {
  if (agentName && agentName.trim()) {
    const fromRegistry = loadPersonaByName(cwd, agentName.trim());
    if (fromRegistry) return fromRegistry;
    // Registry miss: fall through to the legacy file (flag then only names the join).
  }
  return loadPersona(cwd);
}

/** Identity this persona uses inside a channel: channelName override, else name. */
export function channelIdentity(persona: PersonaConfig): string {
  return persona.channelName ?? persona.name;
}

/**
 * `<active_agent>` tag consumed by @gotgenes/pi-permission-system to key
 * per-agent permission frontmatter (<cwd>/.pi/agents/<agent>.md).
 */
export function personaIdentityTag(persona: PersonaConfig): string {
  // Permission identity is the ROLE name, not the channel identity: multiple
  // sessions of one role (researcher-1/2/3) share the same frontmatter walls
  // (<cwd>/.pi/agents/<role>.md) while their channel identities differ.
  return `<active_agent name="${persona.name.replace(/"/g, "")}"></active_agent>`;
}

/** Identity-card lines injected into the system prompt (workspace, channels, skills). */
export function personaIdentityCard(persona: PersonaConfig, effectiveWorkspace: string): string[] {
  const lines: string[] = [];
  lines.push(`Workspace (your permission scope): ${effectiveWorkspace}`);
  if (persona.channels?.length) {
    lines.push(`Declared channels: ${persona.channels.join(", ")}`);
  }
  if (persona.skills?.length) {
    lines.push(`Skills: ${persona.skills.join(", ")}`);
  }
  return lines;
}
