#!/usr/bin/env bash
# Build the stand-in probe module to wasm32-wasip1 into ./build/.
set -euo pipefail
cd "$(dirname "$0")"
command -v cargo >/dev/null || { echo "cargo not found; see README" >&2; exit 1; }
rustup target list --installed | grep -q wasm32-wasip1 || rustup target add wasm32-wasip1
cargo build --release --manifest-path rust/Cargo.toml --target wasm32-wasip1
mkdir -p build
cp rust/target/wasm32-wasip1/release/wasmprobe.wasm build/wasmprobe.wasm
echo "built build/wasmprobe.wasm ($(wc -c < build/wasmprobe.wasm) bytes)"
