/**
 * Image persistence for chat attachments, factored out of the Durable Object
 * so it is unit-testable without the workerd runtime: every function takes
 * the bucket explicitly and touches no `this`. `AppSession` methods are thin
 * wrappers (see session.ts). Bytes live in R2; ChatMessage history carries
 * only `{ id, mimeType }` refs; Pi receives inline base64 via `buildPiInput`.
 */

import { imageKey, isAllowedImageMime, isImageId, validateImageInput, type AllowedImageMime } from "./images";
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
  data: string,
  mimeType: string,
): Promise<{ id: string; mimeType: AllowedImageMime; size: number }> {
  if (!bucket) throw new Error("image storage is not configured (R2 bucket IMAGES is missing)");
  const checked = validateImageInput(data, mimeType);
  const id = crypto.randomUUID();
  const bytes = Uint8Array.from(atob(checked.data), (c) => c.charCodeAt(0));
  await bucket.put(imageKey(id), bytes, { httpMetadata: { contentType: checked.mimeType } });
  return { id, mimeType: checked.mimeType, size: checked.size };
}

/** Load one chat image's bytes; null when absent, unreadable, or unbound. */
export async function loadStoredImage(
  bucket: ImageBucket | undefined,
  id: string,
): Promise<{ data: string; mimeType: AllowedImageMime } | null> {
  if (!isImageId(id) || !bucket) return null;
  const obj = await bucket.get(imageKey(id));
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
export async function deleteStoredImage(bucket: ImageBucket | undefined, id: string): Promise<void> {
  if (!isImageId(id)) throw new Error("bad image id");
  if (!bucket) throw new Error("image storage is not configured (R2 bucket IMAGES is missing)");
  await bucket.delete(imageKey(id));
}

/**
 * Resolve validated `{ id }` refs to the bytes Pi needs. Throws
 * `image not found` on the first missing object (mapped to 400 at the edge).
 */
export async function resolveImageUploads(
  bucket: ImageBucket | undefined,
  refs: { id: string }[],
): Promise<ChatImageUpload[]> {
  const uploads: ChatImageUpload[] = [];
  for (const { id } of refs) {
    const stored = await loadStoredImage(bucket, id);
    if (!stored) throw new Error("image not found");
    uploads.push({ id, mimeType: stored.mimeType, data: stored.data });
  }
  return uploads;
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
 * Fill `{ id }`-only image refs on stored messages with their R2 bytes so a
 * Pi migration (or any replay needing bytes) sees them. Refs whose bytes are
 * gone are dropped individually — history text must survive R2 expiry — and
 * messages left imageless lose the key entirely.
 */
export async function hydrateImageMessages(
  bucket: ImageBucket | undefined,
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (m) => {
      if (m.role !== "user" || !m.images?.length) return m;
      const hydrated: { id?: string; mimeType: string; data?: string }[] = [];
      for (const img of m.images) {
        if (img.data) {
          hydrated.push(img);
          continue;
        }
        if (img.id && isImageId(img.id)) {
          const stored = await loadStoredImage(bucket, img.id);
          if (stored) hydrated.push({ id: img.id, mimeType: stored.mimeType, data: stored.data });
        }
      }
      // All refs unresolvable: drop the key entirely (the spread below would
      // otherwise keep the stale id-only refs).
      if (!hydrated.length) {
        const { images: _dropped, ...rest } = m;
        return rest;
      }
      return { ...m, images: hydrated };
    }),
  );
}
