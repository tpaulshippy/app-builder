/**
 * OpenCode Zen/Go catalog for Pi: provider registration, gateway-to-model
 * resolution, and the shared Models collection. Auth resolves per attempt
 * through the BYOK credential store (see pi-durable-byok), so nothing here
 * holds a key.
 */

import { type CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  defaultModelFor,
  isGateway,
  isModelFor,
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
