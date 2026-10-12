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
  buildFeedback,
  MAX_TOOL_ROUNDS,
  MODEL_TIMEOUT_MS,
  SYSTEM,
  TOOL_TIMEOUT_MS,
  withToolTimeout,
  type AgentEvent,
  type SessionApi,
  type Stream,
} from "./agent";
import { isSafePath } from "./paths";
import { piCompleteTurn, resolvePiModel, type PiTurnResult } from "./pi-opencode";
import type { ChatMessage, FileMap } from "./session";

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
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: Date.now() });
    } else if (m.role === "assistant") {
      const content: PiTurnResult["message"]["content"] = [];
      if (m.content.trim()) content.push({ type: "text", text: m.content });
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
      out.push({
        role: "toolResult",
        toolCallId: m.tool_call_id,
        toolName: m.name ?? "tool",
        content: [{ type: "text", text: m.content }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  return out;
}

function describe(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return typeof args["command"] === "string" && args["command"] ? `$ ${args["command"].slice(0, 80)}` : "shell";
    case "write_file":
      return typeof args["path"] === "string" && args["path"] ? `write ${args["path"]}` : "write";
    case "read_file":
      return typeof args["path"] === "string" && args["path"] ? `read ${args["path"]}` : "read";
    default:
      return name.replace(/_/g, " ");
  }
}

/** True when two file maps hold the same paths with the same contents. */
function sameFiles(a: FileMap, b: FileMap): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i] as string] !== b[kb[i] as string]) return false;
  }
  return true;
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
      yield { type: "tool", name, detail: describe(name, args) };

      let out: string;
      let ok = true;

      switch (name) {
        case "bash": {
          const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
          const before = files;
          let r: { stdout: string; stderr: string; exitCode: number; files: FileMap };
          try {
            r = await withToolTimeout(session.exec(command, files), toolTimeoutMs, "shell command");
          } catch (e) {
            await session.setMessages(messages);
            out = `$ ${command}\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            ok = false;
            yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
            break;
          }
          files = r.files;
          const head = `$ ${command}\n`;
          out = head + (r.stdout || "") + (r.stderr ? `\nstderr:\n${r.stderr}` : "") + `\n(exit ${r.exitCode})`;
          ok = r.exitCode === 0;
          const isDevCycle = /\b(build|tests|lint|deploy)\b/.test(command);
          if (isDevCycle || !sameFiles(before, files)) {
            try {
              const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
              if (built.files) files = built.files;
              yield { type: "build", result: built };
              const feedback = buildFeedback(built);
              out = `${out.slice(0, 6000)}\n${feedback}`;
              ok = ok && built.ok;
            } catch (e) {
              out += `\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
          break;
        }
        case "read_file": {
          files = await session.getFiles();
          const path = typeof args["path"] === "string" ? (args["path"] as string) : "";
          const contents = path in files ? files[path] : undefined;
          if (contents === undefined) {
            ok = false;
            out = `no such file: ${path}. Known: ${Object.keys(files).join(", ")}`;
          } else {
            out = contents;
          }
          break;
        }
        case "write_file": {
          const path = typeof args["path"] === "string" ? (args["path"] as string).trim() : "";
          if (!path || !isSafePath(path)) {
            ok = false;
            out = `refusing unsafe path: ${path || "(empty)"}`;
          } else {
            const content = typeof args["content"] === "string" ? (args["content"] as string) : "";
            files = { ...(await session.getFiles()), [path]: content };
            await session.setFiles(files);
            try {
              const built = await withToolTimeout(session.build(files), toolTimeoutMs, "build");
              if (built.files) files = built.files;
              yield { type: "build", result: built };
              out = `wrote ${path} (${content.length} chars)\n${buildFeedback(built)}`;
              ok = built.ok;
            } catch (e) {
              out = `wrote ${path} (${content.length} chars)\nbuild check failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          break;
        }
        default:
          ok = false;
          out = `unknown tool: ${name}`;
      }

      if (name !== "bash") {
        yield { type: "tool_result", name, ok, detail: out.slice(0, 400) };
      }
      const content = out.slice(0, 8000);
      messages.push({ role: "tool", content, name, tool_call_id: call.id });
    }

    await session.setMessages(messages);
  }

  yield {
    type: "error",
    message: `stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer`,
  };
}
