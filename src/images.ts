/**
 * Shared image-attachment contract: validation used by the edge Worker, the
 * Durable Object, and unit tests. Binary bytes live in Cloudflare R2 (or an
 * in-memory fallback when the binding is absent); ChatMessage history carries
 * only `{ id, mimeType }` refs, and the model receives base64 `ImageContent`
 * through Pi's `UserInput`.
 */

/** Mime types the chat composer accepts. Keep small: model-supported rasters. */
export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

/** Per-image cap: 5 MiB decoded. Keeps DO SQLite values and R2 puts bounded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Per-message cap: Pi and most Responses providers handle a few images. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Image ids are uuid-shaped hex with dashes (see IMAGE_ID_RE below). */
export const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAllowedImageMime(mime: unknown): mime is AllowedImageMime {
  return typeof mime === "string" && (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

export function isImageId(id: unknown): id is string {
  return typeof id === "string" && IMAGE_ID_RE.test(id);
}

/** R2 object key for an image id. Namespaced so non-image keys never collide. */
export function imageKey(id: string): string {
  return `img/${id}`;
}

/**
 * Accept raw base64 or a `data:<mime>;base64,<payload>` URL; return the bare
 * base64 payload. Throws on empty input.
 */
export function extractBase64(data: string): string {
  const trimmed = (data ?? "").trim();
  if (!trimmed) throw new Error("image data is required");
  const marker = ";base64,";
  const at = trimmed.indexOf(marker);
  return at === -1 ? trimmed : trimmed.slice(at + marker.length);
}

/** Decoded byte length of a base64 payload without decoding the whole thing. */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0 || !clean.length) {
    throw new Error("image data is not valid base64");
  }
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

/**
 * Validate one upload: mime allowlist, base64 shape, decoded size cap.
 * Returns the canonical `{ data, mimeType, size }` for storage.
 */
export function validateImageInput(
  data: unknown,
  mimeType: unknown,
): { data: string; mimeType: AllowedImageMime; size: number } {
  if (!isAllowedImageMime(mimeType)) {
    throw new Error(`unsupported image type (want one of ${ALLOWED_IMAGE_MIME.join(", ")})`);
  }
  if (typeof data !== "string" || !data.trim()) throw new Error("image data is required");
  const bare = extractBase64(data);
  const size = base64Bytes(bare);
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${size} bytes, max ${MAX_IMAGE_BYTES})`);
  }
  if (size === 0) throw new Error("image data is required");
  return { data: bare, mimeType, size };
}

/** Validate the `images` array on POST /api/chat: `[{ id }]` refs, capped. */
export function validateImageRefs(images: unknown): { id: string }[] {
  if (images === undefined) return [];
  if (!Array.isArray(images)) throw new Error("images must be an array of { id }");
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`too many images (max ${MAX_IMAGES_PER_MESSAGE})`);
  }
  return images.map((item) => {
    if (!item || typeof item !== "object" || !isImageId((item as { id?: unknown }).id)) {
      throw new Error("each image must be { id }");
    }
    return { id: (item as { id: string }).id };
  });
}
