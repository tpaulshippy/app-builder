/**
 * What `import mod from "./ts_rust.wasm"` means to the type checker.
 *
 * Wrangler hands the Worker a pre-compiled `WebAssembly.Module` for `.wasm`
 * imports (that is the only door through the `WebAssembly.compile` ban), so
 * the default import is the Module itself. Kept here rather than in the
 * generated `worker-configuration.d.ts` so the compiler import does not depend
 * on regenerating that file.
 */
declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}
