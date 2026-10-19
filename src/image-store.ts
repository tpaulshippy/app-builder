/**
 * Image persistence for chat attachments, factored out of the Durable Object
 * so it is unit-testable without the workerd runtime: every function takes
 * the bucket explicitly and touches no `this`. `AppSession` methods are thin
 * wrappers (see session.ts). Bytes live in R2; ChatMessage history carries
 * only `{ id, mimeType }` refs; Pi receives inline base64 via `buildPiInput`.
 */

import { imageKey, isAllowedImageMime, isImageId, validateImageInput, validateImageRefs, type AllowedImageMime } from "./images";
import type { UserInput } from "@earendil-works/pi-durable";
import type { ChatImageUpload, ChatMessage } from "./session";

/** Minimal R2 surface used here; the real R2Bucket satisfies it structurally. */
export type ImageBucket = {
  put(
    key: string,
    value: Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(
    key: string,
  ): Promise<{ httpMetadata?: { contentType?: string }; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
};

/** Store one chat image; throws when the binding is absent or input invalid. */
export async function saveStoredImage(
  bucket: ImageBucket | undefined,
  namespace: string,
  data: string,
  mimeType: string,
): Promise<{ id: string; mimeType: AllowedImageMime; size: number }> {
  if (!bucket) throw new Error("image storage is not configured (R2 bucket IMAGES is missing)");
  const checked = validateImageInput(data, mimeType);
  const id = crypto.randomUUID();
  const bytes = Uint8Array.from(atob(checked.data), (c) => c.charCodeAt(0));
  await bucket.put(await imageKey(id, namespace), bytes, { httpMetadata: { contentType: checked.mimeType } });
  return { id, mimeType: checked.mimeType, size: checked.size };
}

/** Load one chat image's bytes; null when absent, unreadable, or unbound. */
export async function loadStoredImage(
  bucket: ImageBucket | undefined,
  namespace: string,
  id: string,
): Promise<{ data: string; mimeType: AllowedImageMime } | null> {
  if (!isImageId(id) || !bucket) return null;
  const obj = await bucket.get(await imageKey(id, namespace));
  if (!obj) return null;
  const mime = obj.httpMetadata?.contentType ?? "";
  if (!isAllowedImageMime(mime)) return null;
  const buf = await obj.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { data: btoa(binary), mimeType: mime };
}

/** Delete one chat image (R2 delete is idempotent); validates the id. */
export async function deleteStoredImage(
  bucket: ImageBucket | undefined,
  namespace: string,
  id: string,
): Promise<void> {
  if (!isImageId(id)) throw new Error("bad image id");
  if (!bucket) throw new Error("image storage is not configured (R2 bucket IMAGES is missing)");
  await bucket.delete(await imageKey(id, namespace));
}

/**
 * Thrown when a referenced image has no stored bytes. Maps to 400 (the
 * client sent a dead ref); every other storage failure maps to 503.
 */
export class ImageNotFoundError extends Error {
  readonly imageId: string;
  constructor(id: string) {
    super("image not found");
    this.imageId = id;
  }
}

/**
 * Resolve the `/pi-harness` image refs (`[{ id }]`) to the bytes Pi needs.
 * Pure over the bucket (no `this`), so the edge handler is a thin mapper
 * over it and unit tests cover the exact resolution the DO performs.
 * Throws ImageNotFoundError on the first missing object.
 */
export async function resolveImageUploads(
  bucket: ImageBucket | undefined,
  namespace: string,
  refs: { id: string }[],
): Promise<ChatImageUpload[]> {
  const uploads: ChatImageUpload[] = [];
  for (const { id } of refs) {
    const stored = await loadStoredImage(bucket, namespace, id);
    if (!stored) throw new ImageNotFoundError(id);
    uploads.push({ id, mimeType: stored.mimeType, data: stored.data });
  }
  return uploads;
}

/**
 * Validate a `/pi-harness`-style body and resolve its image refs. Returns the
 * submit payload or a `{ error, status }` the handler can answer directly.
 */
export async function resolvePiHarnessBody(
  bucket: ImageBucket | undefined,
  namespace: string,
  body: unknown,
): Promise<
  | { message: string; apiKey: string; gateway: unknown; model: unknown; uploads: ChatImageUpload[] }
  | { error: string; status: 400 | 401 | 503 }
> {
  if (!body || typeof body !== "object") return { error: "expected a JSON body", status: 400 };
  const { message, apiKey, gateway, model, images } = body as {
    message?: unknown;
    apiKey?: unknown;
    gateway?: unknown;
    model?: unknown;
    images?: unknown;
  };
  if (typeof message !== "string" || !message.trim()) return { error: "empty message", status: 400 };
  if (typeof apiKey !== "string" || !apiKey.trim()) return { error: "no API key", status: 401 };
  let refs: { id: string }[];
  try {
    refs = validateImageRefs(images);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: 400 };
  }
  try {
    const uploads = await resolveImageUploads(bucket, namespace, refs);
    return { message, apiKey, gateway, model, uploads };
  } catch (e) {
    // Dead refs are the client's mistake (400); anything else is a storage
    // failure whose internals must not leak to the client — but the cause
    // must not vanish either, so log it server-side (Workers log pipeline).
    if (e instanceof ImageNotFoundError) return { error: e.message, status: 400 };
    console.error("resolvePiHarnessBody: image storage failure", e instanceof Error ? e.message : String(e));
    return { error: "image storage is temporarily unavailable — retry", status: 503 };
  }
}

/**
 * Pi submit payload for one turn: plain text when there are no attachments
 * (back-compat with existing Pi transcripts), otherwise the text plus one
 * inline base64 image block per upload.
 */
export function buildPiInput(message: string, uploads: ChatImageUpload[]): UserInput {
  if (!uploads.length) return message;
  return [
    { type: "text", text: message },
    ...uploads.map((u) => ({ type: "image" as const, data: u.data, mimeType: u.mimeType })),
  ];
}

/**
 * Whether a transcript-probe failure must abort the turn instead of
 * proceeding unhydrated: true when stored history carries image refs without
 * bytes. Continuing imageless would silently drop those images from the
 * model context, and a later migration could never recover them once the
 * turn appends to a non-empty Pi transcript. Text-only history may proceed.
 */
export function shouldAbortOnProbeFailure(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user" && (m.images ?? []).some((img) => !img.data));
}

/**
 * Fill `{ id }`-only image refs on stored messages with their R2 bytes so a
 * Pi migration (or any replay needing bytes) sees them. Refs whose bytes are
 * gone are dropped individually — history text must survive R2 expiry — and
 * messages left imageless lose the key entirely. Loads run sequentially:
 * hydrating is already the expensive path (it precedes a model call), so it
 * must not fan out over the whole history at once.
 */
export async function hydrateImageMessages(
  bucket: ImageBucket | undefined,
  namespace: string,
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !m.images?.length) {
      out.push(m);
      continue;
    }
    const hydrated: { id?: string; mimeType: string; data?: string }[] = [];
    for (const img of m.images) {
      if (img.data) {
        hydrated.push(img);
        continue;
      }
      if (img.id && isImageId(img.id)) {
        const stored = await loadStoredImage(bucket, namespace, img.id);
        if (stored) hydrated.push({ id: img.id, mimeType: stored.mimeType, data: stored.data });
      }
    }
    if (!hydrated.length) {
      // The spread would otherwise keep the stale id-only refs.
      const { images: _dropped, ...rest } = m;
      out.push(rest);
      continue;
    }
    out.push({ ...m, images: hydrated });
  }
  return out;
}
