# AGENTS.md

- `crates/core`: the sync engine (pure Rust). Any rule change goes with a new
  case in `crates/core/tests/vectors.json`, which both `cargo test` and
  `bun run test` (through WebAssembly) replay.
- `crates/wasm`: wasm-bindgen wrapper; `bun run engine` builds it into
  `src/engine/pkg` (git-ignored). The `wasm-bindgen` crate is pinned to the
  CLI version used in CI.
- `cli/`: the `nubes` binary. `src/github.rs` mirrors `src/github/client.ts`;
  keep the two clients in step.
- `src/`: the Preact web app. Only `api.github.com` is reachable (CSP in
  `scripts/build.ts`); URLs must stay relative (site served under `/nubes/`).
- `test/fake-github.ts`: in-memory GitHub used by every test. Never call the
  real API from tests.
- Commits follow Conventional Commits: `fix`/`feat` on `cli/` or `crates/`
  release a new CLI version (`cli-v*` tags) picked up daily by
  `maxgfr/homebrew-tap`.

Checks: `bun run typecheck && bun run lint && bun run test && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && bun run test:e2e`.
