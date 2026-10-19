/**
 * Slice (c): PiHarness inside the Durable Object.
 *
 * This module holds everything the DO integration needs except the DO
 * itself: opening Pi over caller-provided storage (DO SQLite in prod via
 * the `PiHarness` factory, MemoryStorage in tests), per-request model
 * selection, Pi entries -> ChatMessage transcript sync, and Pi event
 * batches -> SSE AgentEvents.
 *
 * Deliberately stateless: the BYOK holder, session, and build drain live
 * on the Durable Object (one per user); this module only maps between the
 * two worlds.
 */

import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  createRegistry,
  Harness,
  type AgentEvent as PiAgentEvent,
  type EntryRecord,
  type Harness as HarnessType,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describeCapsuleTool } from "./capsule-tool-exec";
import type { AgentEvent, SessionApi } from "./agent";
import { byokHarnessSettings, byokModels, type ByokKeyHolder } from "./pi-durable-byok";
import { resolvePiModel } from "./pi-opencode";
import { createCapsuleExtension } from "./pi-tools";
import type { BuildResult, ChatMessage } from "./session";

export type PiHarnessDeps = {
  holder: ByokKeyHolder;
  session: SessionApi;
  onBuild?: (build: BuildResult) => void;
};

type OpenArgs = Parameters<typeof Harness.open>;

/**
 * Open Pi over any storage. Production passes the `PiHarness` factory's
 * SQLite storage; tests pass MemoryStorage.
 */
export function openPiHarness(storage: OpenArgs[0], context: OpenArgs[2], deps: PiHarnessDeps) {
  const registry = createRegistry();
  registry.install(createCapsuleExtension(deps.session, deps.onBuild ? { onBuild: deps.onBuild } : undefined));
  return Harness.open(
    storage,
    {
      models: byokModels(deps.holder),
      registry,
      settings: byokHarnessSettings(deps.holder),
    },
    context,
  );
}

/** Gateway + model picker -> Pi session model reference. */
export function piDefaultsFor(gateway: unknown, model: unknown): { provider: string; id: string } {
  const { provider, modelId } = resolvePiModel(gateway, model);
  return { provider, id: modelId };
}

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Image blocks on a Pi user message: base64 `data` + mime. Returned with no
 * R2 id — the Durable Object re-attaches ids (or re-saves to R2) before the
 * ChatMessage is persisted, so history stays refs, not base64.
 */
export function userImages(message: UserMessage): { mimeType: string; data: string }[] {
  if (typeof message.content === "string") return [];
  return message.content
    .filter((b) => b.type === "image")
    .map((b) => ({ mimeType: b.mimeType, data: b.data }));
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function safeArgs(json: string): Record<string, JsonValue> {
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, JsonValue>;
    }
  } catch {
    // Fall through to empty args; Pi validates against the tool schema.
  }
  return {};
}

/** One legacy transcript message as a Pi entry draft (kind + model). */
export type LegacyDraft =
  | { kind: "pi.user"; model: [UserMessage] }
  | { kind: "pi.assistant"; model: [AssistantMessage] }
  | { kind: "pi.tool-result"; model: [ToolResultMessage] };

/**
 * One-time cutover migration: copy a legacy ChatMessage transcript into a
 * fresh Pi conversation as native entries. Runs only when Pi is empty and
 * legacy history exists, so later turns (and post-reset turns, where both
 * sides clear together) never re-import. Appending entries directly starts
 * no run. Returns whether anything was imported.
 */
export async function migrateLegacyTranscript(
  harness: HarnessType,
  legacy: ChatMessage[],
  provider: string,
  modelId: string,
  context: Context,
): Promise<boolean> {
  if (legacy.length === 0) return false;
  const conv = await harness.root(context);
  const view = await conv.context(context);
  if (view.entries.length > 0) return false;
  const drafts = legacyChatToEntryDrafts(legacy.slice(-60), provider, modelId);
  if (!drafts.length) return false;
  await conv.commit(async (tx) => {
    for (const draft of drafts) {
      if (draft.kind === "pi.user") {
        await tx.appendEntry(UserEntry, conv.id, { model: draft.model });
      } else if (draft.kind === "pi.assistant") {
        await tx.appendEntry(AssistantEntry, conv.id, { model: draft.model });
      } else {
        await tx.appendEntry(ToolResultEntry, conv.id, { model: draft.model, data: { diagnostics: [] } });
      }
    }
  }, context);
  return true;
}

/**
 * Legacy ChatMessage transcript -> Pi entry drafts for one-time migration
 * into a fresh Pi conversation. Assistant tool calls without a matching
 * tool result are dropped (Pi rejects unpaired calls on replay), as is the
 * custom loop's text-only + combined double-store of identical narration.
 * Entries the loop never stored visibly (system/reset) have no legacy form
 * and need none: Pi starts its own context from here.
 */
export function legacyChatToEntryDrafts(
  messages: ChatMessage[],
  provider: string,
  modelId: string,
): LegacyDraft[] {
  const out: LegacyDraft[] = [];
  const answered = new Set(
    messages.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id as string),
  );
  // Calls present in this window: a result whose call was dropped (60-word
  // window split, or a never-stored call) must not import either — Pi
  // rejects unmatched outputs on replay and post-migration turns fail.
  const called = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) called.add(c.call_id);
  }
  let lastAssistantText: string | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      // Inline bytes only: refs without `data` cannot migrate because this
      // pure mapper has no R2 access. The caller (AppSession.piChatTurn)
      // hydrates stored refs first, so by the time messages arrive here
      // every live attachment carries bytes; skip the rest (their text, if
      // any, still migrates below).
      const images = (m.images ?? []).filter(
        (img): img is { mimeType: string; data: string } & { id?: string } =>
          typeof img.data === "string" && !!img.data && typeof img.mimeType === "string",
      );
      // Refs without inline data cannot migrate: Pi needs the bytes, and the
      // sync function has no R2 access. Text still migrates; the image bytes
      // arrive on the next turn's submit (see piChatTurn).
      if (!m.content.trim() && !images.length) continue;
      if (images.length) {
        out.push({
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: [
                ...(m.content.trim() ? [{ type: "text" as const, text: m.content }] : []),
                ...images.map((img) => ({ type: "image" as const, data: img.data as string, mimeType: img.mimeType })),
              ],
              timestamp: Date.now(),
            },
          ],
        });
      } else {
        out.push({ kind: "pi.user", model: [{ role: "user", content: m.content, timestamp: Date.now() }] });
      }
      lastAssistantText = undefined;
    } else if (m.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      const text = m.content.trim() ? m.content : "";
      if (text && text !== lastAssistantText) {
        content.push({ type: "text", text: m.content });
        lastAssistantText = m.content;
      }
      for (const c of m.tool_calls ?? []) {
        if (!answered.has(c.call_id)) continue;
        content.push({ type: "toolCall", id: c.call_id, name: c.name, arguments: safeArgs(c.arguments) as JsonObject });
      }
      if (!content.length) continue;
      out.push({
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content,
            api: "openai-responses",
            provider,
            model: modelId,
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ],
      });
    } else if (m.role === "tool" && m.tool_call_id) {
      lastAssistantText = undefined;
      if (!called.has(m.tool_call_id)) continue;
      out.push({
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: m.tool_call_id,
            toolName: m.name ?? "tool",
            content: [{ type: "text", text: m.content }],
            isError: m.isError ?? false,
            timestamp: Date.now(),
          },
        ],
      });
    }
  }
  return out;
}

/**
 * Pi transcript -> ChatMessage storage. System/reset/compaction entries
 * are display and bookkeeping state: they stay in Pi, out of the UI
 * transcript (same rule as the manual loop, which never stored them).
 */
export function piEntriesToChatMessages(entries: readonly EntryRecord[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const entry of entries) {
    const [first] = entry.model ?? [];
    if (entry.kind === "pi.user" && first?.role === "user") {
      const images = userImages(first);
      out.push({
        role: "user",
        content: userText(first),
        ...(images.length ? { images: images.map((img) => ({ mimeType: img.mimeType, data: img.data })) } : {}),
      });
    } else if (entry.kind === "pi.assistant" && first?.role === "assistant") {
      const toolCalls = first.content
        .filter((b) => b.type === "toolCall")
        .map((c) => ({ call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }));
      out.push({
        role: "assistant",
        content: assistantText(first),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (entry.kind === "pi.tool-result" && first?.role === "toolResult") {
      out.push({
        role: "tool",
        content: toolResultText(first),
        name: first.toolName,
        tool_call_id: first.toolCallId,
        isError: first.isError,
      });
    }
  }
  return out;
}

/**
 * One Pi event batch -> UI AgentEvents. Text deltas stream as text (the UI
 * accumulates them); tool starts/results mirror the manual loop. A text
 * block or whole assistant message delivered at once (single-commit
 * responses, retries, non-streaming rounds) maps to text_block carrying
 * the complete text — the UI reconciles it with already-accumulated
 * deltas instead of dropping it, so these rounds reach the live
 * transcript like the restored snapshot does. Everything else (snapshots, run boundaries, inbox/usage/
 * compaction noise, retries) is orchestration state the `wait()` result
 * already reports — mapped to nothing so the transcript stays narration
 * plus tool traffic.
 */
export function mapPiEvents(events: readonly PiAgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "text_delta") out.push({ type: "text", text: change.delta });
        else if (
          (change.type === "text_start" || change.type === "block") &&
          change.block.type === "text" &&
          change.block.text
        ) {
          out.push({ type: "text_block", text: change.block.text });
        } else if (change.type === "message" && change.message.role === "assistant") {
          const text = assistantText(change.message);
          if (text) out.push({ type: "text_block", text });
        }
      }
    } else if (event.type === "tool_execution_start") {
      out.push({
        type: "tool",
        name: event.toolName,
        detail: describeCapsuleTool(event.toolName, event.args as Record<string, unknown>),
      });
    } else if (event.type === "entry_appended" && event.entry.kind === "pi.tool-result") {
      const [first] = event.entry.model ?? [];
      const text = first?.role === "toolResult" ? toolResultText(first) : "";
      const isError = first?.role === "toolResult" ? first.isError : false;
      const name = first?.role === "toolResult" ? first.toolName : "tool";
      out.push({ type: "tool_result", name, ok: !isError, detail: text.slice(0, 400) });
    }
  }
  return out;
}
