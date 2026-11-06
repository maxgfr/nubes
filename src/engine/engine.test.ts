/**
 * Replays crates/core/tests/vectors.json through the WebAssembly build: the
 * web app must plan exactly what the CLI plans (cargo test replays the same file).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blobShaOf,
  gitBlobSha,
  Ignore,
  isSafePath,
  loadEngineSync,
  MAX_BLOB,
  MAX_ENCRYPTED_BLOB,
  type PlanInput,
  plan,
  poolMerge,
  poolPlace,
} from "./index";
import * as raw from "./pkg/nubes_engine.js";

const ROOT = join(import.meta.dir, "../..");

interface Vectors {
  blobs: { text: string; sha: string }[];
  ignore: { patterns: string[]; path: string; ignored: boolean }[];
  plans: { name: string; input: PlanInput; actions: unknown[]; nextBase: unknown }[];
  pools: {
    merge: { name: string; input: Parameters<typeof poolMerge>[0]; output: unknown }[];
    place: { name: string; input: Parameters<typeof poolPlace>[0]; output: unknown }[];
  };
}

const vectors = JSON.parse(
  readFileSync(join(ROOT, "crates/core/tests/vectors.json"), "utf8"),
) as Vectors;

beforeAll(() => {
  loadEngineSync(readFileSync(join(import.meta.dir, "pkg/nubes_engine_bg.wasm")));
});

describe("engine vectors", () => {
  test("blob ids", async () => {
    for (const v of vectors.blobs) {
      const bytes = new TextEncoder().encode(v.text);
      expect(gitBlobSha(bytes)).toBe(v.sha);
      expect(await blobShaOf(new Blob([bytes]))).toBe(v.sha);
    }
  });

  test("ignore rules", () => {
    for (const v of vectors.ignore) {
      const m = new Ignore(v.patterns.join("\n"));
      expect([v.patterns, v.path, m.isIgnored(v.path)]).toEqual([v.patterns, v.path, v.ignored]);
      m.free();
    }
  });

  for (const v of vectors.plans) {
    test(`plan: ${v.name}`, () => {
      const out = plan(v.input);
      expect(out.actions).toEqual(v.actions as never);
      expect(out.nextBase).toEqual(v.nextBase as never);
    });
  }

  for (const v of vectors.pools.merge) {
    test(`pool merge: ${v.name}`, () => {
      expect(poolMerge(v.input)).toEqual(v.output as never);
    });
  }

  for (const v of vectors.pools.place) {
    test(`pool place: ${v.name}`, () => {
      expect(poolPlace(v.input)).toEqual(v.output as never);
    });
  }
});

describe("engine helpers", () => {
  test("blob hashing in slices matches whole-buffer hashing", async () => {
    const data = new Uint8Array(9 * 1024 * 1024 + 17).map((_, i) => i % 251);
    expect(await blobShaOf(new Blob([data]))).toBe(gitBlobSha(data));
  });

  test("safe paths", () => {
    expect(isSafePath("a/b.txt")).toBe(true);
    expect(isSafePath("../x")).toBe(false);
  });

  test("limits match the Rust constants", () => {
    expect(raw.maxBlobSize()).toBe(MAX_BLOB);
    expect(raw.maxEncryptedBlobSize()).toBe(MAX_ENCRYPTED_BLOB);
  });
});
