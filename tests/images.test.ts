/**
 * Issue #14 (agent vision): image attachments live in R2, ride to the model
 * as Pi `ImageContent`, and persist in ChatMessage history as refs only.
 *
 * Covers the shared validators, the Pi <-> ChatMessage image mapping, and
 * the Worker's /api/images + /api/chat(images) routes (stub-DO pattern from
 * auth.test.ts — the heavy Durable Object module stays mocked out).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session", () => ({
  AppSession: class MockAppSession {},
}));

import worker from "../src/index";
import type { Env } from "../src/index";
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  base64Bytes,
  extractBase64,
  imageKey,
  isAllowedImageMime,
  isImageId,
  validateImageInput,
  validateImageRefs,
} from "../src/images";
import { legacyChatToEntryDrafts, piEntriesToChatMessages, userImages } from "../src/pi-harness";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ChatMessage } from "../src/session";

/** 1x1 PNG (~70 bytes decoded): small enough for unit tests, real mime. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG_B64}`;
const TEST_ID = "123e4567-e89b-12d3-a456-426614174000";

function testEnv(token: string | null, overrides: Record<string, unknown> = {}): Env {
  const images = new Map<string, { data: string; mimeType: string }>();
  const stub: Record<string, unknown> = {
    getGitHubToken: async () => token,
    getGitHubStatus: async () => ({
      connected: Boolean(token),
      user: null,
      linked: null,
      scopes: [],
      grantedScopes: [],
      tokenKind: token ? "oauth" : "missing",
    }),
    getFiles: async () => ({}),
    getMessages: async () => [],
    build: async () => ({ ok: true, files: {}, diagnostics: [] }),
    saveImage: async (data: string, mimeType: string) => {
      const { validateImageInput: validate } = await import("../src/images");
      const checked = validate(data, mimeType);
      const id = TEST_ID;
      images.set(id, { data: checked.data, mimeType: checked.mimeType });
      return { id, mimeType: checked.mimeType, size: checked.size };
    },
    getImage: async (id: string) => images.get(id) ?? null,
    deleteImage: async (id: string) => {
      if (!isImageId(id)) throw new Error("bad image id");
      images.delete(id);
    },
    fetch: async (req: Request) => {
      const body = await req.json().catch(() => ({}));
      (stub as { lastPiBody?: unknown }).lastPiBody = body;
      return new Response(`data: ${JSON.stringify({ type: "done", messages: [], files: {} })}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
    ...overrides,
  };
  return {
    APP: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
}

const call = (path: string, env: Env, init?: RequestInit) =>
  worker.fetch(new Request(`https://app.test${path}`, init), env);

const post = (path: string, env: Env, body: unknown) =>
  call(path, env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("image validators", () => {
  it("accepts data URLs and raw base64 for allowlisted mimes", () => {
    // Minimal per-mime payloads with genuine magic bytes (12 raw bytes each).
    const payload: Record<(typeof ALLOWED_IMAGE_MIME)[number], string> = {
      "image/png": TINY_PNG_B64,
      "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
      "image/gif": Buffer.from("GIF89a" + "\0".repeat(6), "binary").toString("base64"),
      "image/webp": Buffer.from("RIFF\0\0\0\0WEBP", "binary").toString("base64"),
    };
    for (const mime of ALLOWED_IMAGE_MIME) {
      const checked = validateImageInput(`data:${mime};base64,${payload[mime]}`, mime);
      expect(checked.mimeType).toBe(mime);
      expect(checked.data).toBe(payload[mime]);
      expect(checked.size).toBeGreaterThan(0);
    }
    expect(validateImageInput(TINY_PNG_B64, "image/png").data).toBe(TINY_PNG_B64);
  });

  it("rejects non-image mimes, empty data, and bad base64", () => {
    expect(() => validateImageInput(TINY_PNG_B64, "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => validateImageInput(TINY_PNG_B64, "application/pdf")).toThrow(/unsupported image type/);
    expect(() => validateImageInput("", "image/png")).toThrow(/required/);
    expect(() => validateImageInput("!!!not-base64!!!", "image/png")).toThrow(/base64/);
  });

  it("rejects payloads over the byte cap", () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64");
    expect(() => validateImageInput(big, "image/png")).toThrow(/too large/);
  });

  it("sniffs magic bytes: declared mime must match the decoded bytes", () => {
    expect(() => validateImageInput(TINY_PNG_B64, "image/jpeg")).toThrow(/do not match/);
    // Random (but valid-base64) bytes are refused for every image mime.
    const junk = Buffer.from("this is definitely not image data ".repeat(8)).toString("base64");
    for (const mime of ALLOWED_IMAGE_MIME) {
      expect(() => validateImageInput(junk, mime)).toThrow(/do not match/);
    }
    // Whitespace inside the payload is stripped before sniffing and storage.
    const spacedPng = `${TINY_PNG_B64.slice(0, 20)}\n  ${TINY_PNG_B64.slice(20)}`;
    expect(validateImageInput(spacedPng, "image/png").data).toBe(TINY_PNG_B64);
  });

  it("validates chat image refs: array of { id }, capped", () => {
    expect(validateImageRefs(undefined)).toEqual([]);
    expect(validateImageRefs([{ id: TEST_ID }])).toEqual([{ id: TEST_ID }]);
    expect(() => validateImageRefs([{ id: "nope" }])).toThrow(/{ id }/);
    expect(() => validateImageRefs("x" as never)).toThrow(/array/);
    expect(() => validateImageRefs(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ id: TEST_ID })))).toThrow(
      /too many/,
    );
  });

  it("ids and keys are well-formed", () => {
    expect(isImageId(TEST_ID)).toBe(true);
    expect(isImageId("short")).toBe(false);
    expect(isImageId(42)).toBe(false);
    expect(imageKey(TEST_ID)).toBe(`img/${TEST_ID}`);
    expect(isAllowedImageMime("image/png")).toBe(true);
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
    expect(extractBase64(TINY_PNG_URL)).toBe(TINY_PNG_B64);
    expect(base64Bytes("AAAA")).toBe(3);
  });
});

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("pi image mapping", () => {
  it("piEntriesToChatMessages keeps user image bytes transiently (never dropped)", () => {
    const entries = [
      {
        id: "e1",
        conversationId: "c",
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      },
    ] as unknown as EntryRecord[];
    const out = piEntriesToChatMessages(entries);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user", content: "what is this?" });
    expect(out[0]?.images).toEqual([{ mimeType: "image/png", data: TINY_PNG_B64 }]);
  });

  it("text-only user entries carry no images key (back-compat)", () => {
    const entries = [
      {
        id: "e1",
        conversationId: "c",
        kind: "pi.user",
        model: [{ role: "user", content: "hi", timestamp: 1 }],
      },
    ] as unknown as EntryRecord[];
    expect(piEntriesToChatMessages(entries)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("userImages extracts only image blocks", () => {
    expect(userImages({ role: "user", content: "hi", timestamp: 1 })).toEqual([]);
    expect(
      userImages({
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "QQ==", mimeType: "image/jpeg" },
        ],
        timestamp: 1,
      }),
    ).toEqual([{ mimeType: "image/jpeg", data: "QQ==" }]);
  });

  it("legacy migration imports image bytes, skips refs without data", () => {
    const legacy: ChatMessage[] = [
      { role: "user", content: "look", images: [{ mimeType: "image/png", data: TINY_PNG_B64 }] },
      { role: "user", content: "old ref", images: [{ id: TEST_ID, mimeType: "image/png" }] },
    ];
    const drafts = legacyChatToEntryDrafts(legacy, "opencode", "muse-spark-1.3");
    expect(drafts).toHaveLength(2);
    const first = drafts[0];
    expect(first?.kind).toBe("pi.user");
    if (first?.kind === "pi.user") {
      expect(first.model[0]?.content).toContainEqual({ type: "text", text: "look" });
      expect(first.model[0]?.content).toContainEqual({
        type: "image",
        data: TINY_PNG_B64,
        mimeType: "image/png",
      });
    }
    // Ref without bytes: no Pi equivalent (bytes live in R2, unreachable
    // here), so only the text migrates.
    const second = drafts[1];
    if (second?.kind === "pi.user") {
      expect(second.model[0]?.content).toEqual("old ref");
    } else {
      throw new Error("expected pi.user draft");
    }
  });
});

describe("image API routes", () => {
  it("rejects anonymous uploads and serves with the login gate", async () => {
    const res = await post("/api/images", testEnv(null), { data: TINY_PNG_URL, mimeType: "image/png" });
    expect(res.status).toBe(401);
    const get = await call(`/api/images/${TEST_ID}`, testEnv(null));
    expect(get.status).toBe(401);
  });

  it("uploads then serves one image with its content type", async () => {
    const env = testEnv("gho_test");
    const up = await post("/api/images", env, { data: TINY_PNG_URL, mimeType: "image/png" });
    expect(up.status).toBe(200);
    const saved = (await up.json()) as { id: string; url: string; mimeType: string; size: number };
    expect(saved.id).toBe(TEST_ID);
    expect(saved.url).toBe(`/api/images/${TEST_ID}`);
    expect(saved.mimeType).toBe("image/png");

    const down = await call(`/api/images/${TEST_ID}`, env);
    expect(down.status).toBe(200);
    expect(down.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await down.arrayBuffer());
    expect(bytes.length).toBe(saved.size);
    expect(Buffer.from(bytes)).toEqual(Buffer.from(TINY_PNG_B64, "base64"));
  });

  it("rejects bad uploads, unknown ids, and malformed ids", async () => {
    const env = testEnv("gho_test");
    expect((await post("/api/images", env, { data: TINY_PNG_B64, mimeType: "image/svg+xml" })).status).toBe(400);
    expect((await post("/api/images", env, { data: "!!!", mimeType: "image/png" })).status).toBe(400);
    expect((await post("/api/images", env, {})).status).toBe(400);
    expect((await call(`/api/images/${TEST_ID}`, env)).status).toBe(404);
    expect((await call("/api/images/not-an-id", env)).status).toBe(400);
  });

  it("deletes an uploaded image by id (removed attachments leave no orphans)", async () => {
    const env = testEnv("gho_test");
    const up = await post("/api/images", env, { data: TINY_PNG_URL, mimeType: "image/png" });
    expect(up.status).toBe(200);
    const gone = await call(`/api/images/${TEST_ID}`, env, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect((await call(`/api/images/${TEST_ID}`, env)).status).toBe(404);
  });

  it("rejects anonymous and malformed deletes", async () => {
    expect((await call(`/api/images/${TEST_ID}`, testEnv(null), { method: "DELETE" })).status).toBe(401);
    expect((await call("/api/images/not-an-id", testEnv("gho_test"), { method: "DELETE" })).status).toBe(400);
  });

  it("forwards chat image refs to the Pi harness request", async () => {
    const env = testEnv("gho_test");
    const res = await call("/api/chat", env, {
      method: "POST",
      headers: { "content-type": "application/json", "x-provider-key": "k" },
      body: JSON.stringify({ message: "what is this?", images: [{ id: TEST_ID }] }),
    });
    expect(res.status).toBe(200);
    const ns = env.APP as unknown as { get(id: string): { lastPiBody?: { images?: unknown } } };
    expect(ns.get("x").lastPiBody?.images).toEqual([{ id: TEST_ID }]);
  });

  it("rejects malformed chat images without reaching the harness", async () => {
    const env = testEnv("gho_test");
    const res = await call("/api/chat", env, {
      method: "POST",
      headers: { "content-type": "application/json", "x-provider-key": "k" },
      body: JSON.stringify({ message: "hi", images: [{ id: "bad" }] }),
    });
    expect(res.status).toBe(400);
    const tooMany = await call("/api/chat", env, {
      method: "POST",
      headers: { "content-type": "application/json", "x-provider-key": "k" },
      body: JSON.stringify({
        message: "hi",
        images: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ id: TEST_ID })),
      }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("serves the composer attach UI (button, picker, pending strip, paste)", async () => {
    const html = await (await call("/", testEnv(null))).text();
    for (const needle of [
      'id="attach"',
      'id="filepick"',
      'id="pending"',
      "attachFiles",
      "/api/images",
      "paste images to attach",
    ]) {
      expect(html, needle).toContain(needle);
    }
  });
});
