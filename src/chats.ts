import type { ChatMessage } from "./session";

/** Metadata row for one named chat checkpoint (see AppSession). */
export type ChatSnapshotMeta = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  /** FNV-1a fingerprint of the full messages + files (see fingerprintSnapshot). */
  fingerprint?: string;
};

/** Cap matching the live transcript window (see setMessages): snapshots and resume share it. */
export const MESSAGE_CAP = 60;

/** Newest-first window the live session keeps; snapshots store the same slice. */
export function capMessages<T>(messages: T[], max: number = MESSAGE_CAP): T[] {
  return messages.slice(-max);
}

/**
 * Derive snapshot metadata from the live transcript: the preview is the
 * first user turn (truncated), and an explicit title wins over the preview
 * fallback, which wins over a timestamped default.
 */
export function snapshotMeta(
  id: string,
  messages: ChatMessage[],
  files: Record<string, string>,
  title: string | undefined,
  now: number = Date.now(),
): ChatSnapshotMeta {
  const preview = firstUserPreview(messages);
  return {
    id,
    title: (title ?? "").trim() || preview.slice(0, 60) || `Chat ${new Date(now).toLocaleString()}`,
    createdAt: now,
    messageCount: messages.length,
    preview,
    fingerprint: fingerprintSnapshot(messages, files),
  };
}

/** The naming signal for auto-checkpoints: the first user turn, truncated. */
export function firstUserPreview(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  return (firstUser?.content ?? "").trim().slice(0, 120);
}

/**
 * Durable fingerprint of the full transcript + files: the dedupe key for
 * auto-checkpoints. Count + truncated preview collide across conversations
 * with a shared opening, so hash everything (FNV-1a; collisions are not a
 * security concern here, only a skipped checkpoint).
 */
export function fingerprintSnapshot(messages: ChatMessage[], files: Record<string, string>): string {
  const raw = JSON.stringify({ messages, files });
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Whether settling this state deserves a new checkpoint: never for an
 * empty transcript, and never when the newest entry already fingerprints
 * it — so idle New-chat clicks, duplicate settles, and transcript-only
 * compares that miss editor file changes do not stack or skip wrongly.
 */
export function shouldAutoSnapshot(
  newest: ChatSnapshotMeta | undefined,
  messages: ChatMessage[],
  files: Record<string, string>,
): boolean {
  if (!messages.length) return false;
  if (!newest) return true;
  // Entries written before the fingerprint field read as undefined here,
  // which mismatches and checkpoints again: the safe direction.
  return newest.fingerprint !== fingerprintSnapshot(messages, files);
}

/**
 * Single snapshot payload ceiling, kept under the 2 MB single-key value
 * cap. Snapshots beyond this are rejected with a clear error instead of
 * failing the storage put.
 */
export const CHAT_SNAPSHOT_MAX_CHARS = 1_500_000;

/** Throw when a snapshot's messages + files would not fit one storage value. */
export function checkSnapshotSize(
  messages: ChatMessage[],
  files: Record<string, string>,
  max: number = CHAT_SNAPSHOT_MAX_CHARS,
): void {
  const size = JSON.stringify({ messages, files }).length;
  if (size > max) {
    throw new Error(
      `chat snapshot too large (${(size / 1_000_000).toFixed(1)} MB): remove files or clear the chat before saving`,
    );
  }
}

/**
 * Prepend a snapshot to the newest-first list, capping at `max`. Returns
 * the trimmed list plus ids that fell off so the caller can delete them.
 */
export function capChatList(
  prev: ChatSnapshotMeta[],
  meta: ChatSnapshotMeta,
  max: number,
): { chats: ChatSnapshotMeta[]; evicted: string[] } {
  const chats = [meta, ...prev].slice(0, max);
  const live = new Set(chats.map((c) => c.id));
  return { chats, evicted: prev.filter((c) => !live.has(c.id)).map((c) => c.id) };
}
