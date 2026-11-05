/**
 * Builds the sync engine (crates/core, through crates/wasm) to WebAssembly
 * and generates its JavaScript glue in src/engine/pkg/. Needs the
 * wasm32-unknown-unknown target and a wasm-bindgen CLI whose version matches
 * the `wasm-bindgen` crate pinned in crates/wasm/Cargo.toml.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const PKG = join(ROOT, "src/engine/pkg");

function run(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`engine: \`${cmd.join(" ")}\` failed`);
  return p.stdout.toString();
}

if (import.meta.main) {
  const pinned = readFileSync(join(ROOT, "crates/wasm/Cargo.toml"), "utf8").match(
    /wasm-bindgen = "=([^"]+)"/,
  )?.[1];
  const cli = run(["wasm-bindgen", "--version"]).trim().split(" ")[1];
  if (pinned && cli !== pinned) {
    console.error(`wasm-bindgen CLI is ${cli}, the crate is pinned to ${pinned}`);
    console.error(`install it with: cargo install wasm-bindgen-cli --version ${pinned}`);
    process.exit(1);
  }
  run([
    "cargo",
    "build",
    "--locked",
    "-p",
    "nubes-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    "wasm",
  ]);
  run([
    "wasm-bindgen",
    "--target",
    "web",
    "--out-dir",
    PKG,
    "--out-name",
    "nubes_engine",
    join(ROOT, "target/wasm32-unknown-unknown/wasm/nubes_wasm.wasm"),
  ]);
  const size = Bun.file(join(PKG, "nubes_engine_bg.wasm")).size;
  console.log(`engine: ${(size / 1024).toFixed(1)} KiB wasm in src/engine/pkg`);
}
