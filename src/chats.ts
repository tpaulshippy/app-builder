import type { ChatMessage } from "./session";

/** Metadata row for one named chat checkpoint (see AppSession). */
export type ChatSnapshotMeta = {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  preview: string;
};

/**
 * Derive snapshot metadata from the live transcript: the preview is the
 * first user turn (truncated), and an explicit title wins over the preview
 * fallback, which wins over a timestamped default.
 */
export function snapshotMeta(
  id: string,
  messages: ChatMessage[],
  title: string | undefined,
  now: number = Date.now(),
): ChatSnapshotMeta {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  const preview = (firstUser?.content ?? "").trim().slice(0, 120);
  return {
    id,
    title: (title ?? "").trim() || preview.slice(0, 60) || `Chat ${new Date(now).toLocaleString()}`,
    createdAt: now,
    messageCount: messages.length,
    preview,
  };
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
