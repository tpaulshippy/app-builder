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
  createRegistry,
  Harness,
  type AgentEvent as PiAgentEvent,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
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
      out.push({ role: "user", content: userText(first) });
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
 * accumulates them); tool starts/results mirror the manual loop. Everything
 * else (snapshots, run boundaries, inbox/usage/compaction noise, retries)
 * is orchestration state the `wait()` result already reports — mapped to
 * nothing so the transcript stays narration plus tool traffic.
 */
export function mapPiEvents(events: readonly PiAgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "text_delta") out.push({ type: "text", text: change.delta });
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
