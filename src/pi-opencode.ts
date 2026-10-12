/**
 * Pi spike: OpenCode Zen/Go through Pi AI, keeping per-request BYOK.
 *
 * The Worker's BYOK posture is unchanged: the browser holds the caller's key
 * in localStorage and sends it per chat request (`x-provider-key`). Nothing
 * is stored server-side. Pi AI supports an explicit per-request `apiKey`
 * that wins over anything the provider would resolve (env, stored
 * credential), so the spike passes the browser key straight into
 * `models.stream()` alongside the per-conversation `sessionId` Pi forwards
 * as `x-opencode-session`.
 *
 * Scope: Pi AI model layer only (same 3 tools, same SYSTEM prompt, same
 * transcript storage). The durable PiHarness (`pi-durable` + `agents`
 * Lifecycle) is the follow-up once this proves BYOK on the wire.
 */

import { Type, type CredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  defaultModelFor,
  isGateway,
  isModelFor,
  MAX_OUTPUT_TOKENS,
  MODEL_TIMEOUT_MS,
  USER_AGENT,
  type Gateway,
} from "./agent";

export type PiModels = ReturnType<typeof createModels>;

/** Pi provider id per gateway: Zen is `opencode`, Go is `opencode-go`. */
export const PI_PROVIDER_FOR: Record<Gateway, string> = {
  zen: "opencode",
  go: "opencode-go",
};

let cached: PiModels | undefined;

/** Fresh collection with only the two OpenCode providers registered. */
export function createPiModels(credentials?: CredentialStore): PiModels {
  const models = createModels(credentials ? { credentials } : undefined);
  models.setProvider(opencodeProvider());
  models.setProvider(opencodeGoProvider());
  return models;
}

/** Shared collection (providers are stateless; auth is per request). */
export function piModels(): PiModels {
  cached ??= createPiModels();
  return cached;
}

/** Visible for tests: drop the shared collection between cases. */
export function resetPiModels(): void {
  cached = undefined;
}

/**
 * Gateway + model id -> Pi catalog reference. Unknown models fall back to
 * the gateway default (same rule as the custom harness), and catalog drift
 * (id not listed by Pi) falls back the same way. The check runs against the
 * collection that will serve the request, so an explicit `models` override
 * and the stream can never disagree.
 */
export function resolvePiModel(
  gateway: unknown,
  model: unknown,
  models?: PiModels,
): { provider: string; modelId: string } {
  const gw: Gateway = isGateway(gateway) ? gateway : "zen";
  const provider = PI_PROVIDER_FOR[gw];
  const id = isModelFor(gw, model) ? String(model) : defaultModelFor(gw);
  const collection = models ?? piModels();
  if (!collection.getModel(provider, id)) return { provider, modelId: defaultModelFor(gw) };
  return { provider, modelId: id };
}

/** Same three tools as the custom harness, as Pi Tool definitions. */
export const PI_TOOLS: Tool[] = [
  {
    name: "bash",
    description:
      "Run a bash command in the capsule workspace (/app). Use ls/cat/grep/sed/jq to inspect, and the custom commands build, tests, lint, deploy to check and publish your work. Always run build after editing, and tests + lint before deploy.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command, e.g. ls server && build" }),
    }),
  },
  {
    name: "read_file",
    description: "Read a file's current contents without shell quoting.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, e.g. server/index.ts" }),
    }),
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file. This is the usual way to change the app. Write complete file contents, not a diff.",
    parameters: Type.Object({
      path: Type.String({ description: "File path, e.g. server/index.ts" }),
      content: Type.String({ description: "The full new contents of the file" }),
    }),
  },
];

export type PiToolCall = { id: string; name: string; args: Record<string, unknown> };

export type PiTurnResult = { text: string; toolCalls: PiToolCall[]; message: AssistantMessage };

export type PiTurnOptions = {
  gateway?: unknown;
  model?: unknown;
  sessionId?: unknown;
  timeoutMs?: unknown;
  models?: PiModels;
};

/**
 * One model round through Pi AI. The BYOK `apiKey` is explicit per request
 * (never env), `sessionId` becomes `x-opencode-session`, and `user-agent`
 * stays `app-builder/...` so Go routes exactly as it does today.
 */
export async function piCompleteTurn(
  apiKey: string,
  messages: Message[],
  systemPrompt: string,
  opts?: PiTurnOptions,
): Promise<PiTurnResult> {
  const collection = opts?.models ?? piModels();
  const { provider, modelId } = resolvePiModel(opts?.gateway, opts?.model, collection);
  const model = collection.getModel(provider, modelId);
  if (!model) throw new Error(`pi model not in catalog: ${provider}/${modelId}`);
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && (opts.timeoutMs as number) > 0
      ? (opts.timeoutMs as number)
      : MODEL_TIMEOUT_MS;
  const sessionId =
    typeof opts?.sessionId === "string" && (opts.sessionId as string).trim()
      ? (opts.sessionId as string).trim()
      : undefined;

  const stream = collection.stream(
    model,
    { systemPrompt, messages, tools: PI_TOOLS },
    {
      apiKey,
      ...(sessionId ? { sessionId } : {}),
      headers: { "user-agent": USER_AGENT },
      maxTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  let message: AssistantMessage;
  try {
    message = await stream.result();
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`model request timed out after ${timeoutMs}ms — retry your message`);
    }
    throw e;
  }
  if (message.stopReason === "aborted") {
    throw new Error(`model request timed out after ${timeoutMs}ms — retry your message`);
  }
  if (message.stopReason === "error") {
    throw new Error(`pi model request failed: ${message.errorMessage ?? "unknown error"}`);
  }

  let text = "";
  const toolCalls: PiToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "toolCall") {
      toolCalls.push({ id: block.id, name: block.name, args: { ...(block.arguments as Record<string, unknown>) } });
    }
  }
  return { text, toolCalls, message };
}
