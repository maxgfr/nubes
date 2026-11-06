/**
 * The sync engine (nubes-core compiled to WebAssembly): git blob ids, ignore
 * rules and the three-way planner, the very code the CLI runs natively.
 *
 * `loadEngine()` must resolve before any other export is called. The binary
 * is fetched once, on demand, and stays out of the first-screen bundle.
 */
import init, * as wasm from "./pkg/nubes_engine.js";

export type Direction = "both" | "push" | "pull";

export interface Entry {
  sha: string;
  size: number;
}

export type Snapshot = Record<string, Entry>;

export interface PlanInput {
  base?: Snapshot;
  local?: Snapshot;
  remote?: Snapshot;
  direction?: Direction;
  ignore?: string[];
  device?: string;
  stamp?: string;
  maxSize?: number;
}

export type SkipReason = "tooLarge" | "unsafePath" | "pathClash" | "otherDirection";

export type Action =
  | { op: "upload"; path: string; sha: string; size: number }
  | { op: "download"; path: string; sha: string; size: number }
  | { op: "deleteLocal"; path: string }
  | { op: "deleteRemote"; path: string }
  | {
      op: "conflict";
      path: string;
      renamedTo: string;
      localSha: string;
      localSize: number;
      remoteSha: string;
      remoteSize: number;
      upload: boolean;
    }
  | { op: "skip"; path: string; reason: SkipReason };

export interface Plan {
  actions: Action[];
  nextBase: Snapshot;
  summary: {
    uploads: number;
    downloads: number;
    deleteLocal: number;
    deleteRemote: number;
    conflicts: number;
    skipped: number;
  };
}

let ready: Promise<void> | undefined;
let loaded = false;

/** Fetches and instantiates the engine (once). */
export function loadEngine(source?: string | URL | BufferSource): Promise<void> {
  ready ??= init({ module_or_path: source ?? __ENGINE_WASM_URL__ }).then(() => {
    loaded = true;
  });
  return ready;
}

/** Synchronous variant for tests (Bun reads the binary from disk). */
export function loadEngineSync(bytes: BufferSource): void {
  if (loaded) return;
  wasm.initSync({ module: bytes });
  loaded = true;
  ready = Promise.resolve();
}

function assertLoaded(): void {
  if (!loaded) throw new Error("engine not loaded: await loadEngine() first");
}

export function gitBlobSha(data: Uint8Array): string {
  assertLoaded();
  return wasm.gitBlobSha(data);
}

/** Hashes a File or Blob in 4 MiB slices, without holding it all in memory twice. */
export async function blobShaOf(file: Blob): Promise<string> {
  assertLoaded();
  const h = new wasm.BlobHasher(file.size);
  try {
    const step = 4 * 1024 * 1024;
    for (let off = 0; off < file.size; off += step) {
      h.update(new Uint8Array(await file.slice(off, off + step).arrayBuffer()));
    }
    return h.finish();
  } finally {
    h.free();
  }
}

export function plan(input: PlanInput): Plan {
  assertLoaded();
  return JSON.parse(wasm.plan(JSON.stringify(input))) as Plan;
}

/** A remote change in a pool: `sha: null` deletes `path`. */
export interface PoolChange {
  path: string;
  sha: string | null;
  size: number;
}

export interface PoolMember {
  index: number;
  used?: number;
  files?: Snapshot;
}

export interface Fixup extends PoolChange {
  member: number;
}

export interface View {
  files: Snapshot;
  owner: Record<string, number>;
  fixups: Fixup[];
}

export interface Placement {
  members: { index: number; changes: PoolChange[] }[];
  create: number;
}

/** The union of a pool's members, duplicate paths resolved (crates/core/src/pool.rs). */
export function poolMerge(input: {
  members: PoolMember[];
  device?: string;
  stamp?: string;
}): View {
  assertLoaded();
  return JSON.parse(wasm.poolMerge(JSON.stringify(input))) as View;
}

/** Which member each change goes to, and how many members to create. */
export function poolPlace(input: {
  members: PoolMember[];
  owner?: Record<string, number>;
  fixups?: Fixup[];
  limit?: number | null;
  changes: PoolChange[];
}): Placement {
  assertLoaded();
  return JSON.parse(wasm.poolPlace(JSON.stringify(input))) as Placement;
}

export function isSafePath(path: string): boolean {
  assertLoaded();
  return wasm.isSafePath(path);
}

/** Matches paths against `.nubesignore` text plus the built-in defaults. */
export class Ignore {
  readonly #m: wasm.IgnoreMatcher;
  constructor(text = "") {
    assertLoaded();
    this.#m = new wasm.IgnoreMatcher(text);
  }
  isIgnored(path: string): boolean {
    return this.#m.isIgnored(path);
  }
  isDirIgnored(path: string): boolean {
    return this.#m.isDirIgnored(path);
  }
  free(): void {
    this.#m.free();
  }
}

export const MAX_BLOB = 100 * 1024 * 1024;
/** Largest file an encrypted folder uploads: sealed, it still fits in MAX_BLOB. */
export const MAX_ENCRYPTED_BLOB = MAX_BLOB - 32 * 1024;
export const WARN_BLOB = 50 * 1024 * 1024;
