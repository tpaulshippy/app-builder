/**
 * just-bash backend for the agent.
 *
 * One `Bash` instance lives in the Durable Object, seeded from the session's
 * files at `/app`. Standard commands (`ls`, `cat`, `grep`, `sed`, `jq`…)
 * come free with just-bash; the dev cycle is four custom commands that close
 * over the shared QuickJS sandbox:
 *
 *   build   validate + execute the server entry, smoke-run every query
 *   tests   run `*.test.ts` in the isolate against the stub database
 *   lint    parse, import, and anonymous-deploy checks
 *   deploy  assemble the lakebed artifact and POST it (anonymous, or owned
 *           with LAKEBED_TOKEN)
 */

import { Bash, defineCommand } from "just-bash";
import { formatDiagnostics } from "./agent";
import { lintCapsule, runCapsule, runCapsuleTests } from "./capsule";
import { deployCapsule, deployLint } from "./lakebed";
import type { Sandbox } from "./sandbox";
import type { Diagnostic } from "./typecheck";

export type FileMap = Record<string, string>;

export type BashHooks = {
  sandbox: Sandbox;
  /**
   * Real type check; the session serializes calls (69 MiB peak each).
   * Optional so tests can run the shell without the compiler.
   */
  typecheck?: (files: FileMap) => Promise<{ diagnostics: Diagnostic[]; failure?: { name: string; message: string; stderr: string } }>;
  /** LAKEBED_TOKEN for owned deploys; anonymous when unset. */
  deployToken?: string;
  lakebedApi?: string;
};

const APP_ROOT = "/app";
const MAX_SYNC_FILES = 100;
const MAX_FILE_BYTES = 200 * 1024;

function truncate(s: string, n = 4000): string {
  return s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s;
}

async function readProjectFiles(bash: Bash): Promise<FileMap> {
  const found = await bash.exec(`find ${APP_ROOT} -type f | head -n ${MAX_SYNC_FILES + 1}`);
  if (found.exitCode !== 0) throw new Error(`find failed: ${found.stderr}`);
  const paths = found.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
  const files: FileMap = {};
  for (const abs of paths.slice(0, MAX_SYNC_FILES)) {
    const rel = abs.startsWith(`${APP_ROOT}/`) ? abs.slice(APP_ROOT.length + 1) : abs.slice(1);
    if (!rel || rel.includes("..")) continue;
    try {
      const content = await bash.readFile(abs);
      if (content.length <= MAX_FILE_BYTES) files[rel] = content;
    } catch {
      // unreadable (virtual fs node) — skip
    }
  }
  return files;
}

export async function createAgentBash(initial: FileMap, hooks: BashHooks): Promise<Bash> {
  const seed: Record<string, string> = {};
  for (const [path, content] of Object.entries(initial)) seed[`${APP_ROOT}/${path}`] = content;

  // Set after construction; commands only run later, so this is safe.
  let bash: Bash | null = null;
  const files = (): Promise<FileMap> => {
    if (!bash) throw new Error("bash not ready");
    return readProjectFiles(bash);
  };

  const buildCmd = defineCommand("build", async () => {
    const result = await runCapsule(await files(), hooks.sandbox);
    if (!result.ok) {
      return { stdout: "", stderr: truncate(`${result.error?.name ?? "Error"}: ${result.error?.message ?? ""}`), exitCode: 1 };
    }
    const lines = [
      `build passed in ${result.durationMs}ms. Tables: ${result.tables.join(", ") || "(none)"}.`,
      ...Object.entries(result.queries).map(([name, rows]) => `query ${name}: ${truncate(JSON.stringify(rows), 1200)}`),
      ...(result.logs.length ? [`console:\n${truncate(result.logs.join("\n"), 1500)}`] : []),
    ];
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  });

  const testCmd = defineCommand("tests", async () => {
    const result = await runCapsuleTests(await files(), hooks.sandbox);
    const lines = [`${result.passed} passed, ${result.failed.length} failed in ${result.durationMs}ms.`];
    for (const f of result.failed) lines.push(`FAIL ${f.file} :: ${f.test} :: ${truncate(f.message, 500)}`);
    if (result.logs.length) lines.push(`console:\n${truncate(result.logs.join("\n"), 1500)}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: result.ok ? 0 : 1 };
  });

  const lintCmd = defineCommand("lint", async () => {
    const current = await files();
    const problems = [...lintCapsule(current), ...deployLint(current).map((d) => `${d.file}: ${d.message}`)];
    if (hooks.typecheck) {
      const checked = await hooks.typecheck(current);
      if (checked.failure) {
        problems.push(`type checker did not finish (${checked.failure.name}): ${checked.failure.message}`);
      }
      if (checked.diagnostics.length) problems.push(formatDiagnostics(checked.diagnostics));
    }
    if (!problems.length) return { stdout: "lint passed: no problems.\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: `${truncate(problems.join("\n"))}\n`, exitCode: 1 };
  });

  const deployCmd = defineCommand("deploy", async () => {
    const currentFiles = await files();
    if (hooks.typecheck) {
      // Deploy gates on the real type check, not just the fast rules: files may
      // have changed since the last lint, and an unchecked capsule must not ship.
      const checked = await hooks.typecheck(currentFiles);
      const blocking = checked.failure
        ? [`type checker did not finish (${checked.failure.name}): ${checked.failure.message}`]
        : checked.diagnostics.length
          ? [formatDiagnostics(checked.diagnostics)]
          : [];
      if (blocking.length) {
        return { stdout: "", stderr: `deploy blocked by type errors:\n${truncate(blocking.join("\n"))}\n`, exitCode: 1 };
      }
    }
    const result = await deployCapsule(currentFiles, hooks.sandbox, {
      api: hooks.lakebedApi,
      token: hooks.deployToken,
    });
    if (!result.ok) return { stdout: "", stderr: `${truncate(result.message)}\n`, exitCode: 1 };
    const lines = [`deployed: ${result.url}`, `deployId: ${result.deployId}`];
    if (result.expiresAt) lines.push(`expires: ${result.expiresAt} (unclaimed)`);
    if (result.claimed) lines.push(`claimed: true`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  });

  bash = new Bash({
    cwd: APP_ROOT,
    files: seed,
    customCommands: [buildCmd, testCmd, lintCmd, deployCmd],
  });
  return bash;
}

/** Write the session FileMap into the bash FS, then run a command. */
export async function execWithSync(
  bash: Bash,
  files: FileMap,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; files: FileMap }> {
  const current = await readProjectFiles(bash);
  for (const path of Object.keys(current)) {
    // Session paths are isSafePath-constrained (no spaces or metacharacters),
    // so unquoted interpolation is safe here.
    if (!(path in files)) await bash.exec(`rm -f /app/${path}`);
  }
  for (const [path, content] of Object.entries(files)) {
    await bash.writeFile(`${APP_ROOT}/${path}`, content);
  }
  const result = await bash.exec(command);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 1,
    files: await readProjectFiles(bash),
  };
}
