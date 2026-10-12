/**
 * Pi spike: same turn shape as `agentTurn` (`src/agent.ts`), but model
 * rounds go through Pi AI (`piCompleteTurn`) instead of raw Responses
 * `fetch`. Tool execution (bash/read_file/write_file + build feedback),
 * transcript storage, timeouts, and the SSE `AgentEvent` stream are
 * deliberately identical so the two engines stay interchangeable while the
 * spike is evaluated.
 *
 * The model driver is injectable (`deps.streamTurn`) so tests can drive the
 * tool loop without a network round-trip; production passes nothing and
 * gets the real Pi call with the caller's BYOK key.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import {
  MAX_TOOL_ROUNDS,
  MODEL_TIMEOUT_MS,
  SYSTEM,
  TOOL_TIMEOUT_MS,
  type AgentEvent,
  type SessionApi,
  type Stream,
} from "./agent";
import { execCapsuleTool, describeCapsuleTool } from "./capsule-tool-exec";
import { piCompleteTurn, resolvePiModel, type PiTurnResult } from "./pi-opencode";
import type { ChatMessage } from "./session";

export type PiStreamTurn = typeof piCompleteTurn;

function zeroUsage(): PiTurnResult["message"]["usage"] {
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
    // Fall through to empty args; the tool reports the missing field.
  }
  return {};
}

/**
 * Persisted ChatMessage history -> Pi transcript. Assistant turns replay
 * with their tool calls; tool turns replay as tool results. Entries that
 * carry neither text nor calls are skipped (the custom harness stores a
 * text-only message plus a tool-call message per round; the Pi engine
 * stores one message carrying both — both shapes convert).
 */
export function chatHistoryToPiMessages(messages: ChatMessage[], provider: string, modelId: string): Message[] {
  const out: Message[] = [];
  // agentTurn stores a text-only message AND a combined message carrying the
  // same text per round; collapse the adjacent duplicate so the Pi transcript
  // carries each narration once.
  let lastAssistantText: string | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: Date.now() });
      lastAssistantText = undefined;
    } else if (m.role === "assistant") {
      const content: PiTurnResult["message"]["content"] = [];
      const text = m.content.trim() ? m.content : "";
      if (text && text !== lastAssistantText) {
        content.push({ type: "text", text: m.content });
        lastAssistantText = m.content;
      }
      for (const c of m.tool_calls ?? []) {
        content.push({ type: "toolCall", id: c.call_id, name: c.name, arguments: safeArgs(c.arguments) });
      }
      if (!content.length) continue;
      out.push({
        role: "assistant",
        content,
        api: "openai-responses",
        provider,
        model: modelId,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
    } else if (m.role === "tool" && m.tool_call_id) {
      // A tool result breaks assistant adjacency: later narration is new.
      lastAssistantText = undefined;
      out.push({
        role: "toolResult",
        toolCallId: m.tool_call_id,
        toolName: m.name ?? "tool",
        content: [{ type: "text", text: m.content }],
        isError: m.isError ?? false,
        timestamp: Date.now(),
      });
    }
  }
  return out;
}

/** Run one turn via Pi: same events, same storage, Pi model rounds. */
export async function* piAgentTurn(
  session: SessionApi,
  apiKey: string,
  userMessage: string,
  opts?: { gateway?: unknown; model?: unknown; sessionId?: unknown; timeoutMs?: unknown; toolTimeoutMs?: unknown },
  deps?: { streamTurn?: PiStreamTurn },
): Stream {
  const streamTurn = deps?.streamTurn ?? piCompleteTurn;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : MODEL_TIMEOUT_MS;
  const toolTimeoutMs =
    typeof opts?.toolTimeoutMs === "number" && opts.toolTimeoutMs > 0 ? opts.toolTimeoutMs : TOOL_TIMEOUT_MS;
  const sessionId = typeof opts?.sessionId === "string" && opts.sessionId.trim() ? opts.sessionId.trim() : "";
  let files = await session.getFiles();
  const messages = await session.getMessages();
  messages.push({ role: "user", content: userMessage });
  await session.setMessages(messages);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { provider, modelId } = resolvePiModel(opts?.gateway, opts?.model);
    let turn: PiTurnResult;
    try {
      turn = await streamTurn(apiKey, chatHistoryToPiMessages(messages, provider, modelId), SYSTEM, {
        gateway: opts?.gateway,
        model: opts?.model,
        sessionId,
        timeoutMs,
      });
    } catch (e) {
      await session.setMessages(messages);
      const raw = e instanceof Error ? e.message : String(e);
      const hint = /401/.test(raw)
        ? " (check the API key — it is stored in this browser's local storage)"
        : /429/.test(raw)
          ? " (rate limited — wait and try again)"
          : "";
      yield { type: "error", message: `${raw}${hint}` };
      return;
    }

    if (turn.text || turn.toolCalls.length) {
      messages.push({
        role: "assistant",
        content: turn.text,
        ...(turn.toolCalls.length
          ? { tool_calls: turn.toolCalls.map((c) => ({ call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) }
          : {}),
      });
      if (turn.text) yield { type: "text", text: turn.text };
    }
    if (turn.toolCalls.length === 0) {
      await session.setMessages(messages);
      yield { type: "done", messages, files };
      return;
    }

    for (const call of turn.toolCalls) {
      const name = call.name ?? "";
      const args = call.args ?? {};
      yield { type: "tool", name, detail: describeCapsuleTool(name, args) };

      // Shared execution: same report the Pi extension tools produce.
      const outcome = await execCapsuleTool(session, files, name, args, toolTimeoutMs);
      files = outcome.files;
      if (outcome.build) yield { type: "build", result: outcome.build };
      yield { type: "tool_result", name, ok: outcome.ok, detail: outcome.output.slice(0, 400) };
      const content = outcome.output.slice(0, 8000);
      messages.push({ role: "tool", content, name, tool_call_id: call.id, isError: !outcome.ok });
    }

    await session.setMessages(messages);
  }

  yield {
    type: "error",
    message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer`,
  };
}
