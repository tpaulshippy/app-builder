/**
 * Issue #14, cubic follow-ups: image persistence and Pi input building live
 * in `src/image-store.ts` (pure functions over an explicit bucket) so they
 * are unit-testable without the workerd runtime. `AppSession` methods are
 * thin wrappers over these (see session.ts).
 */
import { describe, expect, it } from "vitest";
import {
  buildPiInput,
  deleteStoredImage,
  hydrateImageMessages,
  loadStoredImage,
  resolveImageUploads,
  saveStoredImage,
  type ImageBucket,
} from "../src/image-store";
import type { ChatImageUpload, ChatMessage } from "../src/session";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG_B64}`;

/** Minimal in-memory ImageBucket stand-in. */
function fakeBucket() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const bucket: ImageBucket = {
    async put(key, value, opts) {
      store.set(key, { bytes: value.slice(), contentType: opts?.httpMetadata?.contentType ?? "" });
    },
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        httpMetadata: { contentType: hit.contentType },
        async arrayBuffer() {
          const body = hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength);
          return body as ArrayBuffer;
        },
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return { bucket, store };
}

describe("image persistence (save/load/delete)", () => {
  it("round-trips bytes through save/get and deletes by id", async () => {
    const { bucket } = fakeBucket();
    const saved = await saveStoredImage(bucket, TINY_PNG_URL, "image/png");
    expect(saved.mimeType).toBe("image/png");
    expect(saved.size).toBeGreaterThan(0);
    expect(await loadStoredImage(bucket, saved.id)).toEqual({ data: TINY_PNG_B64, mimeType: "image/png" });
    await deleteStoredImage(bucket, saved.id);
    expect(await loadStoredImage(bucket, saved.id)).toBeNull();
  });

  it("rejects bad uploads, bad ids, and a missing bucket", async () => {
    const { bucket } = fakeBucket();
    await expect(saveStoredImage(bucket, TINY_PNG_B64, "image/svg+xml")).rejects.toThrow(/unsupported image type/);
    await expect(saveStoredImage(bucket, "!!!", "image/png")).rejects.toThrow();
    expect(await loadStoredImage(bucket, "not-an-id")).toBeNull();
    await expect(deleteStoredImage(bucket, "not-an-id")).rejects.toThrow(/bad image id/);

    await expect(saveStoredImage(undefined, TINY_PNG_URL, "image/png")).rejects.toThrow(/not configured/);
    await expect(deleteStoredImage(undefined, "123e4567-e89b-12d3-a456-426614174000")).rejects.toThrow(/not configured/);
    expect(await loadStoredImage(undefined, "123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });
});

describe("resolveImageUploads", () => {
  it("resolves stored refs to decoded uploads, and fails on missing objects", async () => {
    const { bucket } = fakeBucket();
    const saved = await saveStoredImage(bucket, TINY_PNG_URL, "image/png");
    expect(await resolveImageUploads(bucket, [{ id: saved.id }])).toEqual([
      { id: saved.id, mimeType: "image/png", data: TINY_PNG_B64 },
    ]);
    await expect(resolveImageUploads(bucket, [{ id: "123e4567-e89b-12d3-a456-426614174000" }])).rejects.toThrow(
      /image not found/,
    );
  });
});

describe("buildPiInput", () => {
  it("stays a plain string without uploads (Pi transcript back-compat)", () => {
    expect(buildPiInput("hi", [])).toBe("hi");
  });

  it("emits text plus inline base64 image blocks with uploads", () => {
    const uploads: ChatImageUpload[] = [{ id: "x", mimeType: "image/png", data: TINY_PNG_B64 }];
    expect(buildPiInput("look", uploads)).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
    ]);
  });
});

describe("hydrateImageMessages", () => {
  it("fills id-only refs with bytes and drops refs whose bytes are gone", async () => {
    const { bucket } = fakeBucket();
    const saved = await saveStoredImage(bucket, TINY_PNG_URL, "image/png");
    const out = await hydrateImageMessages(bucket, [
      { role: "user", content: "see this", images: [{ id: saved.id, mimeType: "image/png" }] },
      { role: "user", content: "gone", images: [{ id: "123e4567-e89b-12d3-a456-426614174000", mimeType: "image/png" }] },
      { role: "assistant", content: "ok" },
    ]);
    expect(out[0]?.images).toEqual([{ id: saved.id, mimeType: "image/png", data: TINY_PNG_B64 }]);
    // Missing bytes: the image is dropped but the text survives.
    expect(out[1]).toEqual({ role: "user", content: "gone" });
    expect(out[2]?.images).toBeUndefined();
  });
});
