import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import { sendMessage, sendTaskReq } from "../db.ts";
import { createPayload, MESSAGE_EVENTS, TASK_ID_REQUIRED_EVENTS, MAX_CONTENT_WORDS, countWords } from "../types.ts";
import type { MessageEvent } from "../types.ts";
import type { Mamoru } from "../mamoru.ts";

export const SendMessageParams = Type.Object({
  to: Type.Optional(Type.String({ description: "session_id of recipient. Omit for broadcast." })),
  event: Type.String({ description: "Message event type: task_req (request work or ask a question), task_done, task_fail, task_update, task_clarify, task_clarify_res, broadcast, info_only, etc." }),
  task_id: Type.Optional(Type.Number({ description: "The originating task_req's message_id. Required for task_done, task_fail, task_update, task_clarify, task_clarify_res. Not needed for task_req (auto-set)." })),
  ref_message_id: Type.Optional(Type.Number({ description: "The specific message this replies to. Usually same as task_id." })),
  content: Type.String({ description: "Brief summary (max 20 words). Put full details in 'detail' field." }),
  detail: Type.Optional(Type.String({ description: "Absolute file path to a detail markdown file in your teammate directory. REQUIRED for task_req — write a .md file containing full context, requirements, and absolute paths to any referenced files (images, screenshots, code). Also use for task_done/task_fail to include results." })),
  intent: Type.Optional(Type.String({ description: "Freeform intent hint" })),
  blocking: Type.Optional(Type.Boolean({ description: "For task_req only. If true, MAMORU auto-retries when rejected (waits for recipient to become available). If false (default), you are notified of the rejection and can retry manually when the recipient is available." })),
  gate: Type.Optional(Type.String({ description: "For task_req only. Set to 'milestone' to make the requester pause receiving new messages after this task's task_done arrives, until a human runs /team-resume." })),
  channel: Type.Optional(Type.String({ description: "Joined channel to send on. Only needed when the recipient exists in more than one joined channel; broadcasts default to the primary channel." })),
});

export type SendMessageInput = Static<typeof SendMessageParams>;

export interface SendMessageDetails {
  messageId: number;
  taskId?: number;
  event: string;
  to: string | null;
  agentName?: string;
  blocking?: boolean;
}

export interface ChannelRuntimeView {
  channel: string;
  db: Database.Database;
  mamoru: Mamoru;
}

/**
 * M2 cross-channel routing: pick the joined channel a message should go out
 * on. Explicit channel wins; direct targets resolve by roster across all
 * joined channels (session_id or display name); ambiguity is an error, never
 * a guess; broadcasts default to the primary channel.
 */
export function resolveTargetChannel<
  T extends { channel: string; mamoru: { getRoster(): { getAll(): Array<{ session_id: string; agent_name: string }> } } },
>(runtimes: T[], primary: ChannelRuntimeView | null, target: string | null, explicitChannel?: string): T {
  if (runtimes.length === 0) {
    throw new Error("Not connected to a team. Use /team-join first.");
  }

  if (explicitChannel) {
    const rt = runtimes.find((r) => r.channel === explicitChannel);
    if (!rt) {
      throw new Error(
        `Not joined to channel "${explicitChannel}". Joined: ${runtimes.map((r) => r.channel).join(", ")}.`,
      );
    }
    return rt;
  }

  if (!target) {
    // Broadcast — primary channel, unless told otherwise via 'channel'.
    const primaryView = runtimes.find((r) => primary && r.channel === primary.channel);
    return primaryView ?? runtimes[0]!;
  }

  const hits = runtimes.filter((r) =>
    r.mamoru.getRoster().getAll().some((e) => e.session_id === target || e.agent_name === target),
  );
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new Error(
      `Ambiguous recipient "${target}" — present in channels: ${hits.map((h) => h.channel).join(", ")}. Set the 'channel' param to disambiguate.`,
    );
  }
  throw new Error(`Agent "${target}" not found in any joined channel roster.`);
}

export function createSendMessageTool(opts: {
  getPrimary: () => ChannelRuntimeView | null;
  listRuntimes: () => ChannelRuntimeView[];
}) {
  return {
    name: "send_message",
    label: "Send Team Message",
    description:
      "Send a message to a teammate or broadcast to the team. " +
      "Use event 'task_req' to request work or ask a question (expects a response). " +
      "For task_req: always write a detail markdown file with full context, requirements, and absolute paths to any referenced files (images, screenshots, etc.), then set 'detail' to its path. The 'content' field is a brief summary (max 20 words). " +
      "Use task_done/task_fail/task_update/task_clarify for task lifecycle. " +
      "Use broadcast/info_only for announcements (no response expected). " +
      "No teammates are currently online.",
    parameters: SendMessageParams,
    async execute(
      toolCallId: string,
      params: SendMessageInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<SendMessageDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<SendMessageDetails>> {
      const runtimes = opts.listRuntimes();
      // Self-delegation guard runs BEFORE cross-channel routing: self is never
      // in a roster, so routing would report a misleading "not found".
      const selfId = opts.getPrimary()?.mamoru.getSessionId();
      if (params.event === "task_req" && params.to && selfId && params.to === selfId) {
        throw new Error("Cannot send a task_req to yourself. Pick a different teammate.");
      }
      const rt = resolveTargetChannel(runtimes, opts.getPrimary(), params.to ?? null, params.channel);
      const mamoru = rt.mamoru;
      const db = rt.db;

      // Validate event
      if (!MESSAGE_EVENTS.includes(params.event as MessageEvent)) {
        throw new Error(
          `Unknown event "${params.event}". Must be one of: ${MESSAGE_EVENTS.join(", ")}`,
        );
      }

      // Reject MAMORU-reserved events. These are sent automatically by the
      // guardian process and must never be emitted by the LLM, otherwise the
      // recipient would see duplicate acknowledgements.
      const MAMORU_RESERVED_EVENTS: readonly MessageEvent[] = [
        "task_ack",
        "task_reject",
        "task_cancel_ack",
        "pong",
        "ping",
      ];
      if (MAMORU_RESERVED_EVENTS.includes(params.event as MessageEvent)) {
        throw new Error(
          `Event "${params.event}" is reserved for MAMORU and is sent automatically. ` +
          `You do not need to (and must not) send it yourself. ` +
          `When you receive a task_req, MAMORU has already acknowledged it on your behalf — ` +
          `just start working on the task and send task_update / task_done / task_fail messages.`,
        );
      }

      // Validate content length (use persona's contentWordLimit if set)
      const wordLimit = mamoru.getContentWordLimit();
      if (countWords(params.content) > wordLimit) {
        throw new Error(`Content exceeds ${wordLimit} words (got ${countWords(params.content)}). Put details in the 'detail' field.`);
      }

      // ── task_req: special handling ─────────────────────────────
      if (params.event === "task_req") {
        if (!params.to) throw new Error("task_req requires a 'to' recipient.");

        // Prevent self-delegation
        if (params.to === mamoru.getSessionId()) {
          throw new Error("Cannot send a task_req to yourself. Pick a different teammate.");
        }

        // Validate target is in roster
        const roster = mamoru.getRoster();
        const target = roster.get(params.to);
        if (!target) throw new Error(`Agent "${params.to}" not found in roster.`);

        const payload = createPayload("task_req", params.content, {
          intent: params.intent ?? null,
          need_reply: true,
          detail: params.detail ?? null,
          gate: params.gate ?? null,
        });

        // sendTaskReq auto-sets task_id = message_id
        const messageId = sendTaskReq(db, {
          from_agent: mamoru.getSessionId(),
          to_agent: params.to,
          channel: mamoru.getChannel(),
          payload: JSON.stringify(payload),
          maxContentWords: wordLimit,
        });

        // Register outbound task for timeout tracking (with watchdog metadata)
        mamoru.registerOutboundTask(messageId, params.to, {
          content: params.content,
          detail: params.detail ?? null,
          intent: params.intent ?? null,
          gate: params.gate ?? null,
        });
        mamoru.logOutbound("task_req", target.agent_name, messageId, params.content);

        // Register pending retry if blocking/non-blocking retry is requested
        if (params.blocking !== undefined) {
          mamoru.registerPendingRetry({
            targetSessionId: params.to,
            content: params.content,
            detail: params.detail ?? null,
            intent: params.intent ?? null,
            blocking: params.blocking,
            retryCount: 0,
            createdAt: Date.now(),
          });
        }

        const retryNote = params.blocking === true
          ? " (blocking — will auto-retry if rejected)"
          : params.blocking === false
            ? " (non-blocking — will auto-retry when available, you can continue other work)"
            : "";

        return {
          content: [{ type: "text" as const, text: `Task #${messageId} sent to "${target.agent_name}". Waiting for acknowledgement.${retryNote}` }],
          details: { messageId, taskId: messageId, event: "task_req", to: params.to, agentName: target.agent_name, blocking: params.blocking },
        };
      }

      // ── All other events ───────────────────────────────────────

      // Auto-fill 'to' and 'task_id' from active task for task replies
      const activeTask = mamoru.getActiveTask();
      if (activeTask && TASK_ID_REQUIRED_EVENTS.includes(params.event as MessageEvent)) {
        if (!params.to) params.to = activeTask.requesterSessionId;
        if (params.task_id === undefined || params.task_id === null) params.task_id = activeTask.taskId;
      }

      // Validate task_id required for task-related events
      if (
        TASK_ID_REQUIRED_EVENTS.includes(params.event as MessageEvent) &&
        (params.task_id === undefined || params.task_id === null)
      ) {
        throw new Error(
          `Event "${params.event}" requires a task_id.`,
        );
      }

      const payload = createPayload(params.event as MessageEvent, params.content, {
        intent: params.intent ?? null,
        need_reply: false,
        detail: params.detail ?? null,
      });

      const messageId = sendMessage(db, {
        from_agent: mamoru.getSessionId(),
        to_agent: params.to ?? null,
        channel: mamoru.getChannel(),
        task_id: params.task_id ?? null,
        ref_message_id: params.ref_message_id ?? null,
        payload: JSON.stringify(payload),
        maxContentWords: wordLimit,
      });

      // Let MAMORU handle outbound status transitions
      mamoru.handleOutbound(params.event, params.task_id);
      mamoru.logOutbound(params.event, params.to ?? "(broadcast)", params.task_id ?? null, params.content);

      const target = params.to ? `"${params.to}"` : "broadcast";
      return {
        content: [
          {
            type: "text" as const,
            text: `Message #${messageId} (${params.event}) sent to ${target}.`,
          },
        ],
        details: { messageId, event: params.event, to: params.to ?? null },
      };
    },
  };
}
