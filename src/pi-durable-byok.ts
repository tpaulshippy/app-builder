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

/** Per-isolate holder for the caller's browser key. One DO per user. */
export type ByokKeyHolder = { current: string | undefined };

export function createByokKeyHolder(): ByokKeyHolder {
  return { current: undefined };
}

function liveCredential(holder: ByokKeyHolder): Credential | undefined {
  const key = holder.current?.trim();
  return key ? { type: "api_key", key } : undefined;
}

/**
 * Live credential store: `read()` serves the holder's current key, so each
 * generation attempt (including post-restart recovery) resolves auth from
 * the latest browser key. No key => unconfigured => clean failure.
 * In-memory only; nothing is persisted. `modify`/`delete` mutate the
 * holder (login/logout), serialized by the caller's await chain.
 */
export function createByokCredentialStore(holder: ByokKeyHolder): CredentialStore {
  return {
    async read(providerId: string): Promise<Credential | undefined> {
      if (!BYOK_PROVIDERS.has(providerId)) return undefined;
      return liveCredential(holder);
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const out: CredentialInfo[] = [];
      for (const providerId of BYOK_PROVIDERS) {
        if (liveCredential(holder)) out.push({ providerId, type: "api_key" });
      }
      return out;
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      if (!BYOK_PROVIDERS.has(providerId)) return undefined;
      const next = await fn(liveCredential(holder));
      holder.current = next?.type === "api_key" ? next.key?.trim() || undefined : undefined;
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
