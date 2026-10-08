import { DurableObject } from "cloudflare:workers";
import { createSandbox, type RunResult } from "./sandbox";

/** A tool call as the chat-completions API represents one. */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * Present on assistant turns that requested tools. The API requires these to
   * be replayed verbatim on the next request, each paired with a following
   * `role: "tool"` message, or it rejects the conversation.
   */
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
};

export type FileMap = Record<string, string>;

const FILES_KEY = "files";
const MESSAGES_KEY = "messages";

export const DEFAULT_FILE = `// index.ts — the agent edits this file.
// \`state\` persists between runs, in the same isolate. \`html\` renders output.

state.runs = (state.runs ?? 0) + 1;

interface Task {
  title: string;
  done: boolean;
}

const tasks: Task[] = [
  { title: "Share a read-only board", done: true },
  { title: "A quieter notification inbox", done: false },
];

console.log("build", state.runs, "with", tasks.length, "tasks");

html\`
  <h1>Project board</h1>
  <p class="muted">\${tasks.filter((t) => t.done).length} of \${tasks.length} complete · build \${state.runs}</p>
  <ul>
    \${tasks.map((t) => "<li>" + t.title + "</li>").join("")}
  </ul>
\`;
`;

/**
 * One Durable Object per session: the project's files, its chat history, and one
 * QuickJS runtime that survives across runs and rebuilds.
 *
 * Files and messages are persisted to the DO's SQLite storage, so a session
 * survives eviction of the isolate. The in-memory globals of the QuickJS VM do
 * not, which is the one thing that resets when the object is evicted.
 */
export class AppSession extends DurableObject {
  private readonly sandbox = createSandbox();

  async getFiles(): Promise<FileMap> {
    const stored = await this.ctx.storage.get<FileMap>(FILES_KEY);
    return stored ?? { "index.ts": DEFAULT_FILE };
  }

  async setFiles(files: FileMap): Promise<void> {
    await this.ctx.storage.put(FILES_KEY, files);
  }

  async getMessages(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>(MESSAGES_KEY)) ?? [];
  }

  async setMessages(messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put(MESSAGES_KEY, messages.slice(-60));
  }

  /** Type-check is not wired up yet, so `build` is compile plus execute. */
  async build(files?: FileMap): Promise<RunResult & { files: FileMap }> {
    const current = files ?? (await this.getFiles());
    const source = current["index.ts"] ?? Object.values(current)[0] ?? "";
    const result = await this.sandbox.run(source);
    return { ...result, files: current };
  }

  async reset(): Promise<{ files: FileMap; messages: ChatMessage[] }> {
    const files: FileMap = { "index.ts": DEFAULT_FILE };
    await this.ctx.storage.put(FILES_KEY, files);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    return { files, messages: [] };
  }
}