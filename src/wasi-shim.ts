/**
 * Host side of a `wasm32-wasip1` module running inside a Cloudflare Worker.
 *
 * Workers blocks V8 code generation, so `WebAssembly.compile` is unavailable.
 * Importing a `.wasm` file through the bundler yields an already-compiled
 * `WebAssembly.Module`, and `WebAssembly.instantiate(module, imports)` with a
 * pre-compiled module is permitted. That is the only door in.
 *
 * Two import groups have to be supplied by hand:
 *
 *   wasi_snapshot_preview1  — the WASI surface Rust's std pulls in
 *   ts_host                — the filesystem, injected by the embedder
 *
 * The second group is the important one for Workers. `crates/ts_wasm` does not
 * use WASI file syscalls at all; it calls back into the host for every
 * operation, so an in-memory filesystem is enough and `path_open` never
 * appears.
 *
 * ## Why imports are enumerated
 *
 * The imports are built by reading `WebAssembly.Module.imports(module)` and
 * filling every WASI name we implement, defaulting the rest to `ENOSYS`. A
 * hardcoded import object looks simpler and is wrong: a missing entry is not a
 * soft failure but a link error that throws from `WebAssembly.instantiate`, so
 * adding one Rust dependency upstream would break the Worker at start-up
 * instead of degrading gracefully. `ENOSYS` is what a real WASI host returns
 * for an unimplemented call, and the compiler's own path does not depend on
 * any of them.
 *
 * This mirrors `npm/wasm/core.js` in ts-rust, which is the reference host.
 */

/** Opcodes from `crates/ts_wasm/src/host.rs`. */
export const Op = {
  Read: 0,
  Stat: 1,
  ReadDir: 2,
  Realpath: 3,
  Write: 4,
  Append: 5,
  Remove: 6,
  Chtimes: 7,
} as const;

/** WASI errno values used here. */
const SUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/** KIND bytes for `ReadDir` results, from `host.rs`. */
const KIND_FILE = "f";
const KIND_DIR = "d";

/**
 * Thrown by the WASI `proc_exit` import to end a run.
 *
 * This is not a failure. Rust's panic hook calls `std::process::exit`, which
 * reaches `proc_exit`, and that is how a panic ends a run rather than
 * trapping. The caller catches `WasiExit` and still reads the output buffer:
 * `crates/ts_wasm` writes the reply before exiting, so diagnostics produced
 * before the exit survive it.
 */
export class WasiExit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "WasiExit";
    this.code = code;
  }
}

const dec = new TextDecoder();
const enc = new TextEncoder();

type Memory = WebAssembly.Memory;

/**
 * The WASI preview1 functions ts-rust's wasm module imports.
 *
 * `getMemory` is a thunk because the module's memory is only available after
 * instantiate, and because it grows, so every access must re-read the buffer.
 */
function wasiImports(stdout: string[], stderr: string[], env: string[], getMemory: () => Memory) {
  const mem = () => new Uint8Array(getMemory().buffer);
  const view = () => new DataView(getMemory().buffer);

  const writeStrings = (list: string[], ptrs: number, buf: number): number => {
    const dv = view();
    let at = buf;
    list.forEach((text, i) => {
      const bytes = enc.encode(text);
      dv.setUint32(ptrs + i * 4, at, true);
      mem().set(bytes, at);
      at += bytes.length;
    });
    return SUCCESS;
  };

  const sizes = (list: string[], countPtr: number, sizePtr: number): number => {
    const dv = view();
    dv.setUint32(countPtr, list.length, true);
    dv.setUint32(sizePtr, list.reduce((n, text) => n + enc.encode(text).length, 0), true);
    return SUCCESS;
  };

  return {
    args_sizes_get: (countPtr: number, sizePtr: number) => sizes([], countPtr, sizePtr),
    // An empty argv is valid; the request itself arrives through ts_input.
    args_get: () => SUCCESS,
    environ_sizes_get: (countPtr: number, sizePtr: number) => sizes(env, countPtr, sizePtr),
    environ_get: (ptrs: number, buf: number) => writeStrings(env, ptrs, buf),
    clock_time_get: (id: number, _precision: number, out: number) => {
      // Wall time from `performance`, not `Date.now()`: Workers freezes
      // `Date.now()` to the time of the last I/O so code cannot measure its own
      // runtime. A frozen clock is not merely imprecise here, it makes tsc
      // print a timing row of zero (see ts-rust's own note on `core.js`).
      // id 0 is CLOCK_REALTIME, anything else is monotonic.
      const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
      view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
      return SUCCESS;
    },
    clock_res_get: (_id: number, out: number) => {
      view().setBigUint64(out, 1000n, true);
      return SUCCESS;
    },
    random_get: (ptr: number, len: number) => {
      const u8 = mem();
      for (let at = 0; at < len; at += 65536) {
        crypto.getRandomValues(u8.subarray(ptr + at, ptr + Math.min(len, at + 65536)));
      }
      return SUCCESS;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const dv = view();
      const sink = fd === 1 ? stdout : stderr;
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        // fd 2 is not decoration: ts-rust's Rust panic hook prints the panic and
        // every `unported: <name> <count>` line there. Those counters are how you
        // tell a port that is complete on your input from one that silently
        // skipped a check, so dropping stderr throws away the only evidence.
        sink.push(dec.decode(mem().subarray(ptr, ptr + len)));
        total += len;
      }
      dv.setUint32(nwritten, total, true);
      return SUCCESS;
    },
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd > 2) return EBADF;
      // A character device without seek rights is what Rust's `IsTerminal`
      // looks for. Reporting a terminal would make tsc default `--pretty`,
      // which emits ANSI colour into a JSON API. So: not a terminal.
      mem().fill(0, out, out + 24);
      view().setUint8(out, 0);
      return SUCCESS;
    },
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    proc_exit: (code: number) => {
      throw new WasiExit(code);
    },
    sched_yield: () => SUCCESS,
    // Report "no events ready" so anything that would sleep returns at once
    // rather than blocking a Worker CPU budget.
    poll_oneoff: (_in: number, _out: number, _n: number, nevents: number) => {
      view().setUint32(nevents, 0, true);
      return SUCCESS;
    },
  } as Record<string, (...args: number[]) => number>;
}

/**
 * An in-memory filesystem with just enough of the protocol to type-check a
 * project. Paths are POSIX and case-sensitive, matching the
 * `FLAG_CASE_INSENSITIVE`-off default.
 */
export class MemoryFs {
  files: Map<string, Uint8Array>;
  /** Result handed to the next `fs_take`, per the two-step protocol. */
  pending: Uint8Array | null = null;
  /** Error text to hand back instead, or null. */
  errorText: Uint8Array | null = null;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = new Map();
    for (const [path, text] of Object.entries(files)) this.write(path, text);
  }

  static normalize(path: string): string {
    const parts: string[] = [];
    for (const seg of path.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "/" + parts.join("/");
  }

  write(path: string, data: string | Uint8Array): void {
    const key = MemoryFs.normalize(path);
    this.files.set(key, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
  }

  has(path: string): boolean {
    return this.files.has(MemoryFs.normalize(path));
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(MemoryFs.normalize(path));
  }

  /** Derive directory membership from file paths; no real dirs are stored. */
  isDir(path: string): boolean {
    const key = MemoryFs.normalize(path);
    if (key === "/") return true;
    for (const p of this.files.keys()) {
      if (p !== key && p.startsWith(key + "/")) return true;
    }
    return false;
  }

  entries(dir: string): { name: string; kind: string }[] {
    const key = MemoryFs.normalize(dir);
    const prefix = key === "/" ? "/" : key + "/";
    const seen = new Map<string, { name: string; kind: string }>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (!name) continue;
      const kind = slash !== -1 ? KIND_DIR : KIND_FILE;
      if (!seen.has(name)) seen.set(name, { name, kind });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Run one op. Returns the result bytes, or throws to signal failure. */
  dispatch(op: number, request: Uint8Array): Uint8Array {
    const req = dec.decode(request);
    switch (op) {
      case Op.Read: {
        const data = this.read(req);
        if (!data) throw new Error(`open ${req}: no such file or directory`);
        return data;
      }
      case Op.Stat: {
        const data = this.read(req);
        const isDir = !data && this.isDir(req);
        if (!data && !isDir) throw new Error(`stat ${req}: no such file or directory`);
        // `<kind> <size> <mtime ns>`; a fixed mtime keeps output deterministic.
        return enc.encode(`${isDir ? KIND_DIR : KIND_FILE} ${data ? data.length : 0} 0\n`);
      }
      case Op.ReadDir: {
        if (!this.isDir(req)) throw new Error(`open ${req}: not a directory`);
        // `<kind><name>` per entry, each NUL-terminated. No Buffer in a Worker.
        const entries = this.entries(req);
        let size = 0;
        for (const e of entries) size += 1 + enc.encode(e.name).length + 1;
        const out = new Uint8Array(size);
        let at = 0;
        for (const e of entries) {
          const name = enc.encode(e.name);
          out[at++] = e.kind.charCodeAt(0);
          out.set(name, at);
          at += name.length;
          out[at++] = 0;
        }
        return out;
      }
      case Op.Realpath:
        return enc.encode(MemoryFs.normalize(req));
      case Op.Write: {
        const nul = request.indexOf(0);
        const path = dec.decode(request.subarray(0, nul));
        this.write(path, request.subarray(nul + 1));
        return new Uint8Array(0);
      }
      case Op.Append: {
        const nul = request.indexOf(0);
        const path = MemoryFs.normalize(dec.decode(request.subarray(0, nul)));
        const prev = this.files.get(path) ?? new Uint8Array(0);
        const add = request.subarray(nul + 1);
        const next = new Uint8Array(prev.length + add.length);
        next.set(prev, 0);
        next.set(add, prev.length);
        this.files.set(path, next);
        return new Uint8Array(0);
      }
      case Op.Remove: {
        const key = MemoryFs.normalize(req);
        for (const p of [...this.files.keys()]) {
          if (p === key || p.startsWith(key + "/")) this.files.delete(p);
        }
        return new Uint8Array(0);
      }
      case Op.Chtimes:
        return new Uint8Array(0);
      default:
        throw new Error(`unknown fs op ${op}`);
    }
  }
}

export type InstantiateOptions = {
  /** Environment entries, `NAME=value`. Empty by default. */
  env?: string[];
};

export type Instance = {
  instance: WebAssembly.Instance;
  stdout: string[];
  stderr: string[];
};

/**
 * Instantiate a wasm module with a WASI shim and a host filesystem.
 *
 * The module is a pre-compiled `WebAssembly.Module` (a bundler `.wasm` import).
 * A pre-compiled module is what Workers permits; `WebAssembly.compile` is
 * blocked.
 */
export async function instantiate(
  mod: WebAssembly.Module,
  fs: MemoryFs,
  { env = [] }: InstantiateOptions = {},
): Promise<Instance> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let memory: Memory | null = null;
  const getMemory = () => memory as Memory;

  const wasi = wasiImports(stdout, stderr, env, getMemory);

  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
    wasi_snapshot_preview1: {},
    ts_host: {},
  };

  // Build the WASI object from what the module actually asks for, so an
  // upstream Rust change cannot turn into a link error here.
  for (const { module: modName, name } of WebAssembly.Module.imports(mod)) {
    if (modName !== "wasi_snapshot_preview1") continue;
    imports.wasi_snapshot_preview1[name] = wasi[name] ?? (() => ENOSYS);
  }

  imports.ts_host.fs = (op: number, ptr: number, len: number) => {
    // Memory grows during a run, so never hold a view across a host call.
    const req = new Uint8Array(getMemory().buffer, ptr, len).slice();
    try {
      const out = fs.dispatch(op, req);
      fs.pending = out;
      fs.errorText = null;
      return out.length;
    } catch (e) {
      const text = enc.encode((e as Error)?.message ?? String(e));
      fs.errorText = text;
      fs.pending = null;
      return -2 - text.length;
    }
  };

  /** Step two of the filesystem protocol: copy in what `fs` promised. */
  imports.ts_host.fs_take = (ptr: number) => {
    const payload = fs.errorText ?? fs.pending ?? new Uint8Array(0);
    new Uint8Array(getMemory().buffer).set(payload, ptr);
    fs.errorText = null;
    fs.pending = null;
    return undefined;
  };

  const instance = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  memory = instance.exports.memory as Memory;
  return { instance, stdout, stderr };
}