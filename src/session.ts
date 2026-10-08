import { DurableObject } from "cloudflare:workers";
import { createAgentBash, execWithSync, type FileMap } from "./bash";
import { DEFAULT_FILES, runCapsule, type CapsuleResult } from "./capsule";
import type { Sandbox } from "./sandbox";
import { createSandbox } from "./sandbox";
import type { Bash } from "just-bash";

/** A tool call as the Responses API represents one. */
export type ToolCall = {
  call_id: string;
  name: string;
  arguments: string;
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * Present on assistant turns that requested tools. Replayed verbatim on the
   * next request, each paired with following function outputs, or the API
   * rejects the conversation.
   */
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
};

const FILES_KEY = "files";
const MESSAGES_KEY = "messages";

export type { FileMap };

/**
 * One Durable Object per session: the capsule files, its chat history, one
 * QuickJS runtime, and one just-bash instance. Files and messages persist to
 * the DO's SQLite storage, so a session survives eviction; the in-memory VM
 * and bash state do not, and are re-seeded from storage on next use.
 */
export class AppSession extends DurableObject {
  private readonly sandbox: Sandbox = createSandbox();
  private bash: Bash | null = null;

  private async agentBash(): Promise<Bash> {
    if (!this.bash) {
      this.bash = await createAgentBash(await this.getFiles(), {
        sandbox: this.sandbox,
      });
    }
    return this.bash;
  }

  async getFiles(): Promise<FileMap> {
    const stored = await this.ctx.storage.get<FileMap>(FILES_KEY);
    return stored ?? { ...DEFAULT_FILES };
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

  /** Build = validate + execute the server entry, smoke-run every query. */
  async build(files?: FileMap): Promise<CapsuleResult & { files: FileMap }> {
    const current = files ?? (await this.getFiles());
    const result = await runCapsule(current, this.sandbox);
    return { ...result, files: current };
  }

  /** Run one bash command; syncs the bash FS back to stored files. */
  async exec(
    command: string,
    files?: FileMap,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }> {
    const bash = await this.agentBash();
    const current = files ?? (await this.getFiles());
    const out = await execWithSync(bash, current, command);
    await this.setFiles(out.files);
    return out;
  }

  async reset(): Promise<{ files: FileMap; messages: ChatMessage[] }> {
    const files: FileMap = { ...DEFAULT_FILES };
    await this.ctx.storage.put(FILES_KEY, files);
    await this.ctx.storage.put(MESSAGES_KEY, []);
    this.bash = null;
    return { files, messages: [] };
  }
}
