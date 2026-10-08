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
 *   wasi_snapshot_preview1  — the five functions Rust's std pulls in
 *   ts_host                — the filesystem, injected by the embedder
 *
 * The second group is the important one for Workers. `crates/ts_wasm` does not
 * use WASI file syscalls at all; it calls back into the host for every
 * operation, so an in-memory filesystem is enough and `path_open` never
 * appears.
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
};

const dec = new TextDecoder();
const enc = new TextEncoder();

/**
 * The five WASI functions a Rust `wasm32-wasip1` binary actually imports.
 *
 * `getMemory` is a thunk because the module's memory is only available after
 * instantiate, and because it can grow, so every access must re-read the buffer.
 */
function wasiImports(stdout, getMemory) {
  return {
    environ_sizes_get: (countPtr, bufPtr) => {
      const mem = new Uint8Array(getMemory().buffer);
      // No environment variables: an empty argv/environ is valid.
      for (const ptr of [countPtr, bufPtr]) {
        mem[ptr] = 0;
        mem[ptr + 1] = 0;
        mem[ptr + 2] = 0;
        mem[ptr + 3] = 0;
      }
      return 0;
    },
    environ_get: () => 0,
    clock_time_get: (_id, _precision, outPtr) => {
      const mem = new Uint8Array(getMemory().buffer);
      const ns = BigInt(Date.now()) * 1000000n;
      for (let i = 0; i < 8; i++) mem[outPtr + i] = Number((ns >> BigInt(8 * i)) & 0xffn);
      return 0;
    },
    fd_write: (fd, iovs, iovsLen, nwritten) => {
      const memory = getMemory();
      const mem = new Uint8Array(memory.buffer);
      const view = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovs + i * 8;
        const ptr = view.getUint32(base, true);
        const len = view.getUint32(base + 4, true);
        if (fd === 1) stdout.push(dec.decode(mem.subarray(ptr, ptr + len)));
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    // tsc uses proc_exit to report a Go panic. Reaching it means the run died.
    proc_exit: (code) => {
      throw new Error(`ts-rust called proc_exit(${code})`);
    },
  };
}

/**
 * An in-memory filesystem with just enough of the protocol to type-check a
 * small project. Paths are treated as POSIX and case-sensitively.
 */
export class MemoryFs {
  constructor(files = {}) {
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
    /** Result handed to the next fs_take, per the two-step protocol. */
    this.pending = null;
    /** Error text to hand back instead, or null. */
    this.errorText = null;
    for (const [path, text] of Object.entries(files)) this.write(path, text);
  }

  static normalize(path) {
    const parts = [];
    for (const seg of path.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "/" + parts.join("/");
  }

  write(path, data) {
    const key = MemoryFs.normalize(path);
    this.files.set(key, typeof data === "string" ? enc.encode(data) : new Uint8Array(data));
  }

  has(path) {
    return this.files.has(MemoryFs.normalize(path));
  }

  read(path) {
    return this.files.get(MemoryFs.normalize(path));
  }

  /** Derive directory membership from file paths; no real dirs are stored. */
  isDir(path) {
    const key = MemoryFs.normalize(path);
    if (key === "/") return true;
    for (const p of this.files.keys()) {
      if (p !== key && p.startsWith(key + "/")) return true;
    }
    return false;
  }

  entries(dir) {
    const key = MemoryFs.normalize(dir);
    const prefix = key === "/" ? "/" : key + "/";
    const seen = new Map();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (!name) continue;
      const isDir = slash !== -1;
      if (!seen.has(name)) seen.set(name, { name, kind: isDir ? "d" : "f" });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Run one op. Returns the result bytes, or throws to signal failure. */
  dispatch(op, request) {
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
        return enc.encode(`${isDir ? "d" : "f"} ${data ? data.length : 0} 0\n`);
      }
      case Op.ReadDir: {
        if (!this.isDir(req)) throw new Error(`open ${req}: not a directory`);
        // `<kind><name>` per entry, each NUL-terminated. No Buffer in a Worker.
        let size = 0;
        for (const e of this.entries(req)) size += 1 + enc.encode(e.name).length + 1;
        const out = new Uint8Array(size);
        let at = 0;
        for (const e of this.entries(req)) {
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

/**
 * Instantiate a wasm module with a WASI shim and a host filesystem.
 *
 * @param {WebAssembly.Module} mod pre-compiled module from a bundler import
 * @param {MemoryFs} fs filesystem the module reads and writes through
 */
export async function instantiate(mod, fs) {
  const stdout = [];
  let memory = null;
  const getMemory = () => memory;

  const shim = {
    wasi_snapshot_preview1: wasiImports(stdout, getMemory),
    ts_host: {
      /**
       * Step one of the filesystem protocol: do the work, remember the bytes,
       * return their length. -1 means failure, -2-n means an error text of n
       * bytes is waiting for `fs_take`.
       */
      fs: (op, ptr, len) => {
        const req = new Uint8Array(getMemory().buffer, ptr, len).slice();
        try {
          const out = fs.dispatch(op, req);
          fs.pending = out;
          fs.errorText = null;
          return out.length;
        } catch (e) {
          const text = enc.encode(e?.message ?? String(e));
          fs.errorText = text;
          fs.pending = null;
          return -2 - text.length;
        }
      },
      /** Step two: copy the result the host promised into wasm memory. */
      fs_take: (ptr) => {
        const payload = fs.errorText ?? fs.pending ?? new Uint8Array(0);
        new Uint8Array(getMemory().buffer).set(payload, ptr);
        fs.errorText = null;
        fs.pending = null;
      },
    },
  };

  const instance = await WebAssembly.instantiate(mod, shim);
  memory = instance.exports.memory;
  return { instance, stdout };
}