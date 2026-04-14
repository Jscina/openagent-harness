# openagent-harness Makefile
#
# Key targets:
#   make wasm       — rebuild the WASM plugin module (requires wasm-pack)
#   make build      — build the native harness binary
#   make test       — run all Rust tests
#   make install    — install agent configs into ~/.config/opencode/agents/
#   make fmt        — run cargo fmt + clippy

.PHONY: wasm build test install fmt

# ── WASM ─────────────────────────────────────────────────────────────────────

# Recompile the Rust DAG state machine to WASM and regenerate the JS/TS glue
# files that plugin/harness.ts imports at runtime.
#
# Requires: wasm-pack  (cargo install wasm-pack)
wasm:
	wasm-pack build --target web --out-dir plugin/wasm
	rm -f plugin/wasm/.gitignore plugin/wasm/package.json plugin/wasm/README.md
	@echo "✓  WASM rebuilt → plugin/wasm/"

# ── Native binary ─────────────────────────────────────────────────────────────

build:
	cargo build --release

# ── Tests ─────────────────────────────────────────────────────────────────────

test:
	cargo test

# ── Install agent configs ─────────────────────────────────────────────────────

install:
	cargo run --release -- install

# ── Formatting / linting ──────────────────────────────────────────────────────

fmt:
	cargo fmt
	cargo clippy
