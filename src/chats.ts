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
