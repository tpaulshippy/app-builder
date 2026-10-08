//! A minimal `wasm32-wasip1` module standing in for `ts_rust.wasm`.
//!
//! It does what `crates/ts_wasm` does at the boundary: an exported entry point
//! that writes to stdout through WASI fd 1, plus the ambient std machinery
//! (clock, hashing) that makes any Rust `wasip1` binary import
//! `wasi_snapshot_preview1`. Building this takes seconds; building the real
//! compiler needs a machine with tens of gigabytes free.

use std::io::Write;

#[unsafe(no_mangle)]
pub extern "C" fn ts_input(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_run(n: i32) -> i32 {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "ts_run received {}", n);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::collections::hash_map::DefaultHasher::new();
    (n * 2) + ((t as i32) & 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn ts_output_len() -> i32 {
    42
}
