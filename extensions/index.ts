/**
 * pi-teammate extension entry point.
 *
 * Wires together MAMORU, tools, commands, and lifecycle hooks.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { initSchema } from "./schema.ts";
import { resolvePersona, channelIdentity, personaIdentityTag } from "./persona.ts";
import { Mamoru } from "./mamoru.ts";
import { Roster } from "./roster.ts";
import { createSendMessageTool } from "./tools/send-message.ts";
import { registerCommands, setupHintWatcher } from "./commands.ts";
import { DEFAULT_MAMORU_CONFIG } from "./types.ts";
import { setupPrefixKeys } from "./prefix-keys.ts";
import { getChannelDir, getDbPath, getTeammateDir, channelExists } from "./paths.ts";
import { setupTts } from "./tts.ts";

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(mins)}:${pad(secs)}`
    : `${mins}:${pad(secs)}`;
}

export default function (pi: ExtensionAPI) {
  // M2: multi-channel instance table. One session may join N channels; each
  // has its own SQLite DB + MAMORU instance. primaryChannel is the fallback
  // target for single-instance surfaces (TTS, overlays, broadcasts).
  interface ChannelRuntime {
    channel: string;
    db: Database.Database;
    mamoru: Mamoru;
  }
  const runtimes = new Map<string, ChannelRuntime>();
  let primaryChannel: string | null = null;
  let extensionCtx: ExtensionContext | null = null;
  let uptimeTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeHintWatcher: (() => void) | null = null;

  // ── CLI Flags ───────────────────────────────────────────────────
  pi.registerFlag("team-channel", {
    description: "Auto-join a team channel on startup (requires --agent-name)",
    type: "string",
  });
  pi.registerFlag("agent-name", {
    description: "Agent name for team registration (requires --team-channel)",
    type: "string",
  });
  pi.registerFlag("team-new", {
    description: "Delete existing channel DB and start clean (use with --team-channel)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("team-audio", {
    description: "Force teammate audio on/off for this session (overrides ELEVENLABS_API_KEY)",
    type: "string",
  });

  // ── TTS ──────────────────────────────────────────────────────────
  const getPrimary = (): ChannelRuntime | null => {
    if (primaryChannel) return runtimes.get(primaryChannel) ?? null;
    for (const rt of runtimes.values()) return rt;
    return null;
  };
  const tts = setupTts(pi, () => getPrimary()?.db ?? null);

  // ── Tools ───────────────────────────────────────────────────────
  const sendMessageTool = createSendMessageTool({
    getPrimary: () => getPrimary(),
    listRuntimes: () => [...runtimes.values()],
  });
  pi.registerTool(sendMessageTool);

  // The send_message tool is only useful while connected to a team channel.
  // Toggle its presence in the active tool set so the LLM never sees it when
  // MAMORU is inactive (before /team-join or after /team-leave).
  function activateSendMessageTool(): void {
    const active = pi.getActiveTools();
    if (!active.includes("send_message")) {
      pi.setActiveTools([...active, "send_message"]);
    }
  }

  function deactivateSendMessageTool(): void {
    const active = pi.getActiveTools();
    if (active.includes("send_message")) {
      pi.setActiveTools(active.filter((t) => t !== "send_message"));
    }
  }

  // Rebuild the combined tool description across ALL joined channels
  pi.events.on("teammate_roster_changed", () => {
    const parts: string[] = [];
    for (const rt of runtimes.values()) {
      parts.push(`[Channel: ${rt.channel}]\n${rt.mamoru.getRoster().buildToolDescription(rt.mamoru.getSessionId())}`);
    }
    const desc = parts.length > 0 ? parts.join("\n\n") : "Not connected to any team channel.";
    pi.registerTool({ ...sendMessageTool, description: desc });
  });

  // ── Uptime Footer Status ─────────────────────────────────────
  function startUptimeDisplay(ctx: ExtensionContext): void {
    stopUptimeDisplay(ctx);
    uptimeTimer = setInterval(() => {
      if (runtimes.size === 0) {
        ctx.ui.setStatus("teammate", "mamoru: inactive");
        return;
      }
      const parts: string[] = [];
      for (const rt of runtimes.values()) {
        parts.push(rt.mamoru.isActive() ? `${rt.channel}:${formatUptime(rt.mamoru.getUptimeMs())}` : `${rt.channel}:off`);
      }
      ctx.ui.setStatus("teammate", parts.join(" · "));
    }, 1000);
  }

  function stopUptimeDisplay(ctx: ExtensionContext): void {
    if (uptimeTimer) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }
    ctx.ui.setStatus("teammate", "mamoru: inactive");
  }

  // ── Bootstrap Helper ────────────────────────────────────────────
  function leaveChannel(channel: string): boolean {
    const rt = runtimes.get(channel);
    if (!rt) return false;
    try { rt.mamoru.stop(); } catch {}
    try { rt.db.close(); } catch {}
    runtimes.delete(channel);
    if (primaryChannel === channel) {
      primaryChannel = runtimes.size > 0 ? [...runtimes.keys()][0]! : null;
    }
    if (runtimes.size === 0) deactivateSendMessageTool();
    return true;
  }

  function bootstrapMamoru(ctx: ExtensionContext, channel: string, agentName: string, persona: import("./persona.ts").PersonaConfig | null, forceNew?: boolean): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const channelDir = getChannelDir(channel);
    const dbPath = getDbPath(channel);

    // --team-new: delete entire channel directory and start clean
    if (forceNew && existsSync(channelDir)) {
      rmSync(channelDir, { recursive: true, force: true });
      console.log(`[teammate] Deleted existing channel: ${channelDir}`);
    }

    if (!channelExists(channel)) {
      mkdirSync(channelDir, { recursive: true });
      const tempDb = new Database(dbPath);
      initSchema(tempDb);
      tempDb.close();
      console.log(`[teammate] Created channel DB: ${dbPath}`);
    }

    // Re-join of an already-joined channel: tear down the old instance first.
    const existing = runtimes.get(channel);
    if (existing) {
      try { existing.mamoru.stop(); } catch {}
      try { existing.db.close(); } catch {}
      runtimes.delete(channel);
      if (primaryChannel === channel) primaryChannel = null;
    }

    // Create this teammate's detail directory
    const teammateDir = getTeammateDir(channel, sessionId);

    const db = new Database(dbPath);
    initSchema(db);

    const roster = new Roster();

    const m = new Mamoru({
      db,
      sessionId,
      agentName,
      channel,
      persona,
      pi,
      ctx,
      roster,
      config: DEFAULT_MAMORU_CONFIG,
      teammateDir,
    });
    m.start();
    runtimes.set(channel, { channel, db, mamoru: m });
    if (!primaryChannel) primaryChannel = channel;
    startUptimeDisplay(ctx);
    activateSendMessageTool();

    // L1.5 permission bridge: persistent active-agent marker (persona may
    // differ per join). See session_start for the non-team path.
    try {
      ctx.sessionManager.appendCustomEntry("active_agent", { name: agentName });
    } catch {}

    // Start TTS poller for this channel (no-op if TTS not enabled, or
    // if poller already running). This must happen before mamoru.start()
    // emits the agent_join broadcast — but mamoru.start() is synchronous
    // and the TTS poller picks up queued items on its next tick, so the
    // ordering is fine either way.
    tts?.onSessionStart(ctx, channel);
  }

  // ── Commands ────────────────────────────────────────────────────
  const { hintRegistry } = registerCommands(
    pi,
    () => getPrimary()?.mamoru ?? null,
    (m) => {
      if (m === null) {
        // Legacy single-leave hook: a command cleared MAMORU — hide send_message.
        const pc = primaryChannel;
        if (pc) leaveChannel(pc);
        if (runtimes.size === 0) deactivateSendMessageTool();
      }
    },
    () => extensionCtx,
    {
      bootstrapMamoru,
      multi: {
        has: (channel: string) => runtimes.has(channel),
        leave: leaveChannel,
        leaveAll: () => {
          for (const ch of [...runtimes.keys()]) leaveChannel(ch);
        },
        all: () => [...runtimes.values()],
        primary: getPrimary,
      },
    },
  );

  // ── Prefix Keys (Ctrl+T → m/r/t) + Esc to close ──────────
  setupPrefixKeys(
    pi,
    () => extensionCtx,
    () => {
      if (runtimes.size === 0 || !extensionCtx) return null;
      const ctx = extensionCtx;
      return {
        m: () => {
          // Toggle MAMORU overlay (reuse the toggle from commands.ts)
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleMamoru) actions.toggleMamoru(ctx);
        },
        r: () => {
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleRoster) actions.toggleRoster(ctx);
        },
        t: () => {
          const actions = (pi as any).__teammateActions;
          if (actions?.toggleTask) actions.toggleTask(ctx);
        },
      };
    },
    {
      onEsc: () => {
        // Close any open overlay (regardless of focus state)
        const actions = (pi as any).__teammateActions;
        if (actions?.closeRoster?.()) return true;
        if (actions?.closeTask?.()) return true;
        if (actions?.closeMamoru?.()) return true;
        return false;
      },
    },
  );

  // ── Lifecycle Hooks ─────────────────────────────────────────────

  // Auto-bootstrap from CLI flags on session start, and apply persona config
  pi.on("session_start", async (_event, ctx) => {
    extensionCtx = ctx;

    // Show inactive status in footer until team is joined
    ctx.ui.setStatus("teammate", "mamoru: inactive");

    // Hide send_message from the LLM until a team is joined
    deactivateSendMessageTool();

    // Install the slash-command usage-hint watcher (fires ctx.ui.notify
    // whenever the editor text becomes "/team-... " or "/task-... ").
    if (unsubscribeHintWatcher) {
      unsubscribeHintWatcher();
      unsubscribeHintWatcher = null;
    }
    unsubscribeHintWatcher = setupHintWatcher(ctx, hintRegistry);

    // ── Resolve identity (L1 registry): --agent-name → persona/<name>.yaml → persona.yaml ──
    const flagAgentName = pi.getFlag("agent-name") as string | undefined;
    let resolvedPersona: import("./persona.ts").PersonaConfig | null = null;
    try {
      resolvedPersona = resolvePersona(ctx.cwd, flagAgentName);
    } catch (err: any) {
      ctx.ui.notify(`Failed to load persona: ${err.message}`, "warning");
    }

    // L1.5 permission bridge (persistent side): pi-permission-system scans
    // session entries for a custom "active_agent" entry to key per-agent
    // frontmatter (<cwd>/.pi/agents/<agent>.md). The system-prompt tag alone
    // is ephemeral and invisible to it.
    if (resolvedPersona) {
      try {
        ctx.sessionManager.appendCustomEntry("active_agent", {
          name: channelIdentity(resolvedPersona),
        });
      } catch {}
    }

    // ── Apply persona provider/model/thinkingLevel on session start (also runs on /reload) ──
    try {
      const persona = resolvedPersona;
      if (persona) {
        if (persona.provider && persona.model) {
          const modelObj = ctx.modelRegistry.find(persona.provider, persona.model);
          if (modelObj) {
            const ok = await pi.setModel(modelObj);
            if (ok) {
              console.log(`[teammate] Applied persona model: ${persona.provider}/${persona.model}`);
            } else {
              ctx.ui.notify(`persona.yaml: no API key for ${persona.provider}/${persona.model}`, "warning");
            }
          } else {
            ctx.ui.notify(`persona.yaml: model "${persona.model}" not found for provider "${persona.provider}"`, "warning");
          }
        }
        if (persona.thinkingLevel) {
          try {
            pi.setThinkingLevel(persona.thinkingLevel);
            console.log(`[teammate] Applied persona thinkingLevel: ${persona.thinkingLevel}`);
          } catch (err: any) {
            ctx.ui.notify(`persona.yaml: failed to set thinkingLevel: ${err.message}`, "warning");
          }
        }
      }
    } catch (err: any) {
      ctx.ui.notify(`Failed to load persona.yaml: ${err.message}`, "warning");
    }

    // ── Auto-join team channel(s) from CLI flags + declared persona channels ──
    // M2: union of --team-channel and persona.channels — join ALL of them.
    const flagChannel = pi.getFlag("team-channel") as string | undefined;
    let agentName: string | undefined;
    if (resolvedPersona) {
      agentName = channelIdentity(resolvedPersona);
    } else if (flagAgentName) {
      agentName = flagAgentName;
    }

    const targets = new Set<string>();
    if (flagChannel) targets.add(flagChannel);
    if (resolvedPersona?.channels) for (const c of resolvedPersona.channels) targets.add(c);

    if (targets.size === 0) {
      // Nothing to join — still init TTS for /tts-test command
      tts?.onSessionStart(ctx, null);
      if (agentName) {
        ctx.ui.notify("No channel to join: pass --team-channel or declare 'channels' in the persona.", "info");
      }
      return;
    }

    if (!agentName) {
      ctx.ui.notify("--agent-name is required (or set 'name' in persona.yaml)", "error");
      tts?.onSessionStart(ctx, null);
      return;
    }

    const forceNew = pi.getFlag("team-new") as boolean | undefined;
    for (const ch of targets) {
      // --team-new only resets the explicitly flagged channel.
      bootstrapMamoru(ctx, ch, agentName, resolvedPersona, forceNew === true && ch === flagChannel);
      console.log(`[teammate] Joined "${ch}" as "${agentName}"`);
    }
    // TTS poller is started inside bootstrapMamoru.
  });

  // Inject persona + task context into system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    // Multi-channel (M2): primary instance builds the base (persona + tag +
    // its channel section); every other joined channel appends a section.
    // M3-lite: informational digests, one block per channel (if any).
    const primary = getPrimary();
    if (primary) {
      let base = primary.mamoru.buildSystemPromptAdditions(event.systemPrompt)?.systemPrompt ?? event.systemPrompt;
      const extras: string[] = [];
      for (const rt of runtimes.values()) {
        if (rt.channel === primary.channel) continue;
        extras.push(rt.mamoru.buildChannelSection());
      }
      for (const rt of runtimes.values()) {
        const digest = rt.mamoru.buildDigestBlock();
        if (digest) extras.push(`[Channel: ${rt.channel}]\n${digest}`);
      }
      if (extras.length > 0) base += "\n\n" + extras.join("\n\n");
      return { systemPrompt: base };
    }

    // When not in a team, still apply persona systemPrompt if present
    try {
      const persona = resolvePersona(ctx.cwd, pi.getFlag("agent-name") as string | undefined);
      if (persona) {
        // Tag always injected — the permission bridge must work even when the
        // persona carries no systemPrompt.
        const sp = persona.systemPrompt;
        return { systemPrompt: event.systemPrompt + "\n\n" + personaIdentityTag(persona) + (sp ? "\n\n" + sp : "") };
      }
    } catch {
      // Silently ignore — persona errors are already reported on session_start
    }
    return undefined;
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    tts?.onShutdown();
    if (uptimeTimer) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }
    if (unsubscribeHintWatcher) {
      unsubscribeHintWatcher();
      unsubscribeHintWatcher = null;
    }
    const all = [...runtimes.values()];
    runtimes.clear();
    primaryChannel = null;
    for (const rt of all) {
      try { rt.mamoru.stop(); } catch {}
      try { rt.db.close(); } catch {}
    }
  });
}
