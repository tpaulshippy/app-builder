/**
 * Slice (a): BYOK injection into Pi-owned generations.
 *
 * Pi's generation task dispatches through `models.streamSimple()`, which
 * resolves auth per request via the Models collection's `CredentialStore`
 * — before dispatch, and with no stored/env credential it fails the run as
 * unanswered (`Provider is not configured`) without ever touching the
 * network. Hooks cannot do this (`beforeRequest` may only replace
 * messages), and `settings.stream` carries only documented fields
 * (headers/timeouts, no `apiKey`). So the injection point is a live
 * credential store: its `read()` serves the holder's current key, making
 * the browser key the resolving credential for the `opencode` and
 * `opencode-go` providers on every attempt, including recovery attempts
 * after a restart.
 *
 * Scoping relies on the existing one-DO-per-user architecture (one
 * `AppSession` per `ab_session` cookie): the chat handler sets the holder
 * from the request's `x-provider-key` before `submit()`, and the isolate's
 * holder is that user's key. The key lives only in isolate memory — it is
 * never written to SQLite — so an eviction clears it and a resumed run
 * fails cleanly as `unanswered` instead of running under a stale key. The
 * browser still holds the key in localStorage, so a retry re-sets it and
 * continues.
 *
 * Posture change vs today: the key now rests in server-side volatile
 * memory for the run's duration (submit returns before the model runs, so
 * it cannot be cleared per request). It never touches disk.
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { MODEL_TIMEOUT_MS, USER_AGENT } from "./agent";
import { createPiModels, type PiModels } from "./pi-opencode";

/** Pi provider ids this store serves keys for. */
const BYOK_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** Per-isolate holder for the caller's credential. One DO per user. */
export type ByokKeyHolder = { current: Credential | undefined };

export function createByokKeyHolder(): ByokKeyHolder {
  return { current: undefined };
}

/** The stored credential, or nothing when there is no usable key. */
function liveCredential(holder: ByokKeyHolder): Credential | undefined {
  const current = holder.current;
  if (!current) return undefined;
  // A blank api_key cannot authenticate: treat it as absent so the run
  // fails cleanly as unconfigured instead of sending `Bearer `.
  if (current.type === "api_key" && !current.key?.trim()) return undefined;
  return current;
}

/**
 * Live credential store: `read()` serves the holder's stored credential
 * verbatim (key, env overlay, and type), so each generation attempt
 * (including post-restart recovery) resolves auth from the latest browser
 * state. Nothing usable stored => unconfigured => clean failure.
 * In-memory only; nothing is persisted. The chat handler writes
 * `{ type: "api_key", key }` before submit; `modify`/`delete` (login/logout)
 * apply through the holder.
 */
export function createByokCredentialStore(holder: ByokKeyHolder): CredentialStore {
  return {
    async read(providerId: string): Promise<Credential | undefined> {
      if (!BYOK_PROVIDERS.has(providerId)) return undefined;
      return liveCredential(holder);
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const stored = liveCredential(holder);
      if (!stored) return [];
      // Metadata only: never expose key material.
      return [...BYOK_PROVIDERS].map((providerId) => ({ providerId, type: stored.type }));
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      if (!BYOK_PROVIDERS.has(providerId)) return undefined;
      const next = await fn(liveCredential(holder));
      // Contract: `undefined` means "leave the entry unchanged".
      if (next === undefined) return liveCredential(holder);
      holder.current = next;
      return liveCredential(holder);
    },
    async delete(providerId: string): Promise<void> {
      if (BYOK_PROVIDERS.has(providerId)) holder.current = undefined;
    },
  };
}

/** Models collection wired to the live BYOK store. One per Harness. */
export function byokModels(holder: ByokKeyHolder): PiModels {
  return createPiModels(createByokCredentialStore(holder));
}

/** Documented-fields-only stream settings: identity header, timeouts. */
export function byokHarnessSettings(
  _holder: ByokKeyHolder,
  overrides?: Pick<HarnessSettings, "retry">,
): HarnessSettings {
  return {
    stream: {
      headers: { "user-agent": USER_AGENT },
      timeoutMs: MODEL_TIMEOUT_MS,
      maxRetries: 0,
    },
    ...overrides,
  };
}
