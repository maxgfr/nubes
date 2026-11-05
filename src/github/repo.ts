/**
 * A nubes folder inside a GitHub repository: one branch, and optionally a
 * prefix (a sub-folder of the repository). Paths here are relative to the
 * prefix; the repository-wide `.nubes/meta.json` marks it as a nubes repo.
 *
 * An encrypted folder (it has `.nubes/key.age`) stores each file as
 * `<path>.age`, and `.nubes/manifest.json` maps each path to the id of its
 * plain content. This class hides the difference: paths and ids are the
 * plain ones in both modes, so the engine compares the same things. Mirrors
 * `Remote` in cli/src/github.rs.
 */
import type { Cipher } from "../crypto";
import { GitHub, RefMovedError, type TreeChange } from "./client";

export interface RepoTarget {
  /** `owner/name`. */
  full: string;
  branch: string;
  /** Sub-folder of the repository, without leading or trailing slash ("" for the root). */
  prefix: string;
}

export interface RemoteFile {
  sha: string;
  size: number;
  mode: string;
}

/** One file of an encrypted folder, as the manifest records it. */
export interface Sealed {
  /** The git blob id of the plain content (what the engine compares). */
  plainSha: string;
  size: number;
  /** The blob that stores it, encrypted, as `<path>.age`. */
  blobSha: string;
}

export interface Manifest {
  version: number;
  files: Record<string, Sealed>;
}

export interface RemoteState {
  /** The branch's commit, null while the repository is empty. */
  head: string | null;
  tree: string | null;
  /** Files under the prefix, by path relative to it. Symlinks and submodules are left out. */
  files: Map<string, RemoteFile>;
  /** Content already stored: uploading it again is never needed. */
  blobs: Set<string>;
  /** Whether `.nubes/meta.json` exists at the repository root. */
  hasMeta: boolean;
  /** Whether the folder is encrypted (it has `.nubes/key.age`). */
  encrypted?: boolean;
  keyBlob?: string | null;
  manifest?: Manifest;
  /** Encrypted folder: plain id → stored blob id. */
  stored?: Map<string, string>;
  /** Encrypted folder: files nubes did not write (no manifest entry), left alone. */
  foreign?: string[];
}

export const META_PATH = ".nubes/meta.json";
/** nubes' own files, at the top of the nubes folder. */
export const OWN_DIR = ".nubes/";
export const KEY_FILE = ".nubes/key.age";
export const MANIFEST_FILE = ".nubes/manifest.json";
/** FORMAT.md version of an encrypted folder. */
const AGE_FORMAT_VERSION = 2;

export function metaJson(mode: "plain" = "plain"): string {
  return `${JSON.stringify(
    { format: "nubes", version: 1, mode, createdAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
}

export function normalizePrefix(prefix: string): string {
  return prefix
    .split("/")
    .filter((p) => p && p !== ".")
    .join("/");
}

/** The folder is encrypted and this device does not have its key yet. */
export class LockedError extends Error {
  constructor() {
    super("This folder is encrypted: enter its passphrase to open its files.");
    this.name = "LockedError";
  }
}

const enc = new TextEncoder();

export class Remote {
  readonly prefix: string;
  /** The key of an encrypted folder, once unlocked. */
  cipher: Cipher | null = null;
  /** Whether the last state read was of an encrypted folder. */
  encrypted = false;
  /** Plain id → stored id and size, for content seen or uploaded. */
  readonly #known = new Map<string, { blob: string; size: number }>();
  readonly #manifests = new Map<string, Manifest>();

  constructor(
    readonly gh: GitHub,
    readonly target: RepoTarget,
  ) {
    this.prefix = normalizePrefix(target.prefix);
  }

  /** Repository path of a nubes path. */
  full(path: string): string {
    return this.prefix ? `${this.prefix}/${path}` : path;
  }

  /** Where a file is stored in the repository (`.age` added in an encrypted folder). */
  storedPath(path: string): string {
    return this.encrypted ? `${this.full(path)}.age` : this.full(path);
  }

  /** The nubes path of a repository path, or null if outside the folder or nubes' own. */
  nubesPath(repoPath: string): string | null {
    const strip = this.prefix ? `${this.prefix}/` : "";
    if (!repoPath.startsWith(strip)) return null;
    const rel = repoPath.slice(strip.length);
    if (rel.startsWith(OWN_DIR)) return null;
    if (!this.encrypted) return rel;
    return rel.endsWith(".age") ? rel.slice(0, -4) : null;
  }

  async #manifest(sha: string): Promise<Manifest> {
    const hit = this.#manifests.get(sha);
    if (hit) return hit;
    const m = JSON.parse(
      new TextDecoder().decode(await this.gh.blob(this.target.full, sha)),
    ) as Partial<Manifest>;
    const out: Manifest = { version: m.version ?? 1, files: m.files ?? {} };
    this.#manifests.set(sha, out);
    return out;
  }

  async state(): Promise<RemoteState> {
    const { full, branch } = this.target;
    const head = await this.gh.head(full, branch);
    const files = new Map<string, RemoteFile>();
    const blobs = new Set<string>();
    if (!head) return { head, tree: null, files, blobs, hasMeta: false };
    const tree = await this.gh.commitTree(full, head);
    const strip = this.prefix ? `${this.prefix}/` : "";
    const entries = (await this.gh.tree(full, tree)).filter((e) => e.type === "blob");
    const find = (p: string) => entries.find((e) => e.path === strip + p)?.sha ?? null;
    const keyBlob = find(KEY_FILE);
    const encrypted = keyBlob !== null;
    const manifestBlob = encrypted ? find(MANIFEST_FILE) : null;
    const manifest: Manifest = manifestBlob
      ? await this.#manifest(manifestBlob)
      : { version: 1, files: {} };
    const stored = new Map<string, string>();
    const foreign: string[] = [];
    let hasMeta = false;
    for (const e of entries) {
      if (e.path === META_PATH) hasMeta = true;
      if (!encrypted) blobs.add(e.sha);
      // Symlinks (120000) are not files nubes can sync.
      if (e.mode === "120000") continue;
      if (strip && !e.path.startsWith(strip)) continue;
      const rel = e.path.slice(strip.length);
      // nubes' own metadata is not one of the user's files.
      if (rel.startsWith(OWN_DIR)) continue;
      if (!encrypted) {
        files.set(rel, { sha: e.sha, size: e.size ?? 0, mode: e.mode });
        continue;
      }
      const path = rel.endsWith(".age") ? rel.slice(0, -4) : null;
      const m = path ? manifest.files[path] : undefined;
      if (!path || !m || m.blobSha !== e.sha) {
        foreign.push(rel);
        continue;
      }
      blobs.add(m.plainSha);
      stored.set(m.plainSha, e.sha);
      this.#known.set(m.plainSha, { blob: e.sha, size: m.size });
      files.set(path, { sha: m.plainSha, size: m.size, mode: e.mode });
    }
    this.encrypted = encrypted;
    return { head, tree, files, blobs, hasMeta, encrypted, keyBlob, manifest, stored, foreign };
  }

  /** Writes `.nubes/meta.json` if missing; creates the first commit of an empty repository. */
  async ensureMeta(state?: RemoteState): Promise<void> {
    const s = state ?? (await this.state());
    if (s.hasMeta) return;
    await this.gh.putFile(
      this.target.full,
      this.target.branch,
      META_PATH,
      enc.encode(metaJson()),
      "nubes: initialize",
    );
  }

  /** Opens an encrypted folder with its passphrase. */
  async unlock(state: RemoteState, passphrase: string): Promise<Cipher> {
    if (!state.keyBlob) throw new Error("This folder is not encrypted.");
    const { unlockKey } = await import("../crypto");
    this.cipher = await unlockKey(await this.gh.blob(this.target.full, state.keyBlob), passphrase);
    return this.cipher;
  }

  /** Makes a new, empty folder encrypted: its key, locked with `passphrase`. */
  async initEncryption(passphrase: string): Promise<Cipher> {
    const { lockKey, newCipher } = await import("../crypto");
    let state = await this.state();
    if (!state.head || !state.hasMeta) {
      await this.ensureMeta(state);
      state = await this.state();
    }
    if (state.encrypted) throw new Error("This folder is already encrypted.");
    if (state.files.size > 0)
      throw new Error(
        `This folder already has ${state.files.size} plain file${state.files.size === 1 ? "" : "s"}: encryption is for a new folder (a new repository, or a new folder inside one).`,
      );
    const { cipher, recipient } = await newCipher();
    const meta = `${JSON.stringify(
      {
        format: "nubes",
        version: AGE_FORMAT_VERSION,
        mode: "age",
        recipient,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`;
    const { full } = this.target;
    await this.commit(
      [
        { path: KEY_FILE, sha: await this.gh.createBlob(full, await lockKey(cipher, passphrase)) },
        { path: META_PATH, sha: await this.gh.createBlob(full, enc.encode(meta)) },
      ],
      "nubes: encrypt this folder",
      state,
    );
    this.cipher = cipher;
    return cipher;
  }

  #cipher(): Cipher {
    if (!this.cipher) throw new LockedError();
    return this.cipher;
  }

  /** Whether content `sha` (plain id) is already stored. */
  has(sha: string, state: RemoteState): boolean {
    return state.encrypted
      ? !!state.stored?.has(sha) || this.#known.has(sha)
      : state.blobs.has(sha);
  }

  /** Stores content whose plain id is `sha` (encrypted in an encrypted folder). */
  async put(data: Uint8Array, sha: string, state: RemoteState): Promise<void> {
    if (this.has(sha, state)) return;
    const { full } = this.target;
    if (!state.encrypted) {
      const got = await this.gh.createBlob(full, data);
      if (got !== sha) throw new Error(`GitHub stored ${got}, expected ${sha}`);
      return;
    }
    const blob = await this.gh.createBlob(full, await this.#cipher().encrypt(data));
    this.#known.set(sha, { blob, size: data.length });
  }

  /** The plain content whose id is `sha`. */
  async get(sha: string): Promise<Uint8Array> {
    const { full } = this.target;
    if (!this.encrypted) return this.gh.blob(full, sha);
    const k = this.#known.get(sha);
    if (!k) throw new Error(`No encrypted content for ${sha}`);
    const cipher = this.#cipher();
    return cipher.decrypt(await this.gh.blob(full, k.blob));
  }

  /** The plain id of `path` at commit `rev`, if it existed there. */
  async versionAt(path: string, rev: string): Promise<string | null> {
    const { full } = this.target;
    if (!this.encrypted) return this.gh.fileAt(full, this.full(path), rev);
    const m = await this.gh.fileAt(full, this.full(MANIFEST_FILE), rev);
    const e = m ? (await this.#manifest(m)).files[path] : undefined;
    if (!e) return null;
    this.#known.set(e.plainSha, { blob: e.blobSha, size: e.size });
    return e.plainSha;
  }

  /**
   * Commits `changes` (nubes paths, plain ids) on `state` and moves the
   * branch, only if nobody moved it in between (RefMovedError otherwise).
   * In an encrypted folder, files go to `<path>.age` and the manifest
   * follows in the same commit.
   */
  async commit(changes: TreeChange[], message: string, state: RemoteState): Promise<string> {
    const { full, branch } = this.target;
    const { head, tree } = state;
    if (!head || !tree) throw new Error("empty repository");
    let out: TreeChange[];
    if (state.encrypted) {
      const files = { ...state.manifest?.files };
      out = [];
      for (const c of changes) {
        const path = `${this.full(c.path)}.age`;
        if (c.sha === null) {
          delete files[c.path];
          out.push({ path, sha: null });
          continue;
        }
        const k = this.#known.get(c.sha);
        if (!k) throw new Error(`${c.path} was not uploaded`);
        files[c.path] = { plainSha: c.sha, size: k.size, blobSha: k.blob };
        out.push({ path, sha: k.blob, ...(c.mode ? { mode: c.mode } : {}) });
      }
      const sorted: Record<string, Sealed> = {};
      for (const p of Object.keys(files).sort()) sorted[p] = files[p] as Sealed;
      const text = `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`;
      out.push({
        path: this.full(MANIFEST_FILE),
        sha: await this.gh.createBlob(full, enc.encode(text)),
      });
    } else {
      out = changes.map((c) => ({ ...c, path: this.full(c.path) }));
    }
    const newTree = await this.gh.createTree(full, tree, out);
    if (newTree === tree) return head;
    const commit = await this.gh.createCommit(full, message, newTree, [head]);
    await this.gh.updateRef(full, branch, commit);
    return commit;
  }

  /**
   * Reads the branch, asks `build` for the changes to make on that state,
   * and commits them; starts over if the branch moved meanwhile.
   * Returns the new head (or the old one when there was nothing to change).
   */
  async apply(
    build: (state: RemoteState) => TreeChange[] | Promise<TreeChange[]>,
    message: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      let state = await this.state();
      if (!state.head || !state.hasMeta) {
        await this.ensureMeta(state);
        state = await this.state();
      }
      const changes = await build(state);
      if (changes.length === 0 || !state.head || !state.tree) return state.head;
      try {
        return await this.commit(changes, message, state);
      } catch (err) {
        if (err instanceof RefMovedError) continue;
        throw err;
      }
    }
    throw new RefMovedError();
  }
}

export { GitHub };
