import { describe, expect, it } from "vitest";
import { type SessionApi } from "../src/agent";
import { execCapsuleTool, isDevCycleCommand, normalizeCapsulePath } from "../src/capsule-tool-exec";
import type { ChatMessage, FileMap } from "../src/session";

function memorySession(initial: FileMap = { "server/index.ts": "v1" }): SessionApi & {
  files: FileMap;
} {
  const s = {
    files: { ...initial },
    getFiles: async () => ({ ...s.files }),
    setFiles: async (f: FileMap) => {
      s.files = { ...f };
    },
    getMessages: async () => [] as ChatMessage[],
    setMessages: async (_m: ChatMessage[]) => {},
    build: async (f?: FileMap) => {
      const files = f ?? s.files;
      return { ok: true, tables: ["todos"], queries: {}, logs: [], durationMs: 1, files };
    },
    exec: async (command: string, f?: FileMap) => {
      const files = { ...(f ?? s.files) };
      return { stdout: "ok", stderr: "", exitCode: 0, files };
    },
  };
  return s;
}

describe("isDevCycleCommand", () => {
  it("matches dev commands as segments, not substrings", () => {
    expect(isDevCycleCommand("build")).toBe(true);
    expect(isDevCycleCommand("ls server && build")).toBe(true);
    expect(isDevCycleCommand("tests 2>&1 | head")).toBe(true);
    expect(isDevCycleCommand("lint; deploy")).toBe(true);
    expect(isDevCycleCommand("ls | grep build")).toBe(false);
    expect(isDevCycleCommand("grep -l deploy *.ts")).toBe(false);
    expect(isDevCycleCommand("echo build")).toBe(false);
    expect(isDevCycleCommand("ls")).toBe(false);
  });
});

describe("normalizeCapsulePath", () => {
  it("collapses dot segments without touching traversal rejection", () => {
    expect(normalizeCapsulePath("./server/index.ts")).toBe("server/index.ts");
    expect(normalizeCapsulePath("server/./index.ts")).toBe("server/index.ts");
    expect(normalizeCapsulePath("server/index.ts")).toBe("server/index.ts");
    expect(normalizeCapsulePath("../evil.ts")).toBe("../evil.ts");
  });

  it("a dotted write lands on the canonical key", async () => {
    const session = memorySession();
    const outcome = await execCapsuleTool(
      session,
      await session.getFiles(),
      "write_file",
      { path: "./server/note.txt", content: "hi" },
      1000,
    );
    expect(outcome.ok).toBe(true);
    expect(session.files["server/note.txt"]).toBe("hi");
    expect(Object.keys(session.files).some((k) => k.includes("./"))).toBe(false);
  });
});

describe("execCapsuleTool", () => {
  it("returns fresh files (not the pre-command snapshot) when the shell times out", async () => {
    const session = memorySession();
    session.exec = (async () => {
      // Lands an edit, then hangs past the tool timeout: the late
      // setFiles still happens, so the outcome must re-read.
      const files = { ...(await session.getFiles()), ["server/late.txt"]: "landed" };
      await session.setFiles(files);
      return new Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }>(() => {});
    }) as SessionApi["exec"];
    const outcome = await execCapsuleTool(session, await session.getFiles(), "bash", { command: "slow" }, 20);
    expect(outcome.ok).toBe(false);
    expect(outcome.files["server/late.txt"]).toBe("landed");
  });

  it("refuses git-internal paths like the editor APIs", async () => {
    const session = memorySession();
    const outcome = await execCapsuleTool(
      session,
      await session.getFiles(),
      "write_file",
      { path: ".git/config", content: "x" },
      1000,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("git-internal");
    expect(Object.keys(session.files).some((k) => k.includes(".git"))).toBe(false);
  });
});
