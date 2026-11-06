/**
 * The remote side of a folder: one repository, or a pool of them
 * (`owner/name-1`, `owner/name-2`…) that nubes creates as they fill up.
 * Mirrors `Pool` in cli/src/pool.rs.
 *
 * The rules (which repository holds a path, where a new file goes,
 * duplicate paths) are the engine's `poolMerge` and `poolPlace`, shared with
 * the CLI. A folder linked to one repository is a pool of one member,
 * without a size limit. The state it returns is the union of the members,
 * so the rest of the app reads one folder; its `head` changes when any
 * member's does.
 */
import type { Cipher } from "../crypto";
import {
  loadEngine,
  type Placement,
  type PoolChange,
  type PoolMember,
  poolMerge,
  poolPlace,
  type Snapshot,
  type View,
} from "../engine";

type PlaceInput = Parameters<typeof poolPlace>[0];

import {
  type CommitFiles,
  type CommitInfo,
  type GitHub,
  GitHubError,
  RefMovedError,
  type TreeChange,
} from "./client";
import { LockedError, Remote, type RemoteFile, type RemoteState, type RepoTarget } from "./repo";

export interface PoolSpec {
  /** The account that owns the repositories. */
  owner: string;
  /** Repositories are `<name>-1`, `<name>-2`… */
  name: string;
  /** A repository takes no new file past this size, in bytes. */
  maxSize: number;
}

/** GitHub recommends a repository under 5 GB. */
export const DEFAULT_MAX_SIZE = 5 * 1024 ** 3;

export interface PoolFile extends RemoteFile {
  /** Index of the member that holds it (1 for `<name>-1`). */
  member: number;
}

/** The union of the members, plus what the pool needs to write to them. */
export interface PoolState extends RemoteState {
  files: Map<string, PoolFile>;
  /** Each member's own state, in order. */
  members?: RemoteState[];
  /** Path → member index (duplicates resolved). */
  owner?: Record<string, number>;
  /** Changes that clean duplicate paths up (written with the next commit). */
  fixups?: (PoolChange & { member: number })[];
}

export interface MemberSize {
  repo: string;
  size: number;
}

const snapshot = (s: RemoteState): Snapshot =>
  Object.fromEntries([...s.files].map(([p, f]) => [p, { sha: f.sha, size: f.size }]));

export class Pool {
  readonly members: Remote[] = [];
  #cipher: Cipher | null = null;
  /** Members whose meta.json says they belong to the pool (or that this tab created). */
  readonly #verified = new Set<string>();
  /** New paths whose content was uploaded to a member, until committed. */
  readonly #assigned = new Map<string, number>();
  /** Content id → member known to have it (a file, or an old version read). */
  readonly #where = new Map<string, number>();
  readonly #sizes = new Map<string, number>();
  /** Members' sizes as last asked, for one batch of uploads. */
  #used: { at: number; bytes: number[] } | null = null;
  /** Bytes uploaded since `#used` was read, by member index. */
  readonly #reserved = new Map<number, number>();
  #last: PoolState | null = null;

  /** One repository (`target`), or a pool (`spec`). */
  constructor(
    readonly gh: GitHub,
    readonly spec: PoolSpec | null,
    target?: RepoTarget,
  ) {
    if (!spec) {
      if (!target) throw new Error("a pool needs a spec or a repository");
      this.members.push(new Remote(gh, target));
    }
  }

  /** Where the folder lives, for keys of this device's storage. */
  get id(): string {
    if (this.spec) return `pool:${this.spec.owner}/${this.spec.name}`;
    const t = (this.members[0] as Remote).target;
    return `${t.full}:${t.branch}:${(this.members[0] as Remote).prefix}`;
  }

  get prefix(): string {
    return this.spec ? "" : (this.members[0] as Remote).prefix;
  }

  get cipher(): Cipher | null {
    return this.#cipher;
  }

  set cipher(c: Cipher | null) {
    this.#cipher = c;
    for (const m of this.members) m.cipher = c;
  }

  get encrypted(): boolean {
    return this.members.some((m) => m.encrypted);
  }

  #member(index: number): Remote {
    const m = this.members[index - 1];
    if (!m) throw new Error(`no repository number ${index}`);
    return m;
  }

  #add(branch: string): Remote {
    const spec = this.spec as PoolSpec;
    const index = this.members.length + 1;
    const r = new Remote(this.gh, {
      full: `${spec.owner}/${spec.name}-${index}`,
      branch,
      prefix: "",
      pool: { name: spec.name, index, maxSize: spec.maxSize },
    });
    r.cipher = this.#cipher;
    this.members.push(r);
    return r;
  }

  /** Adds the members that exist after the known ones; whether there were any. */
  async discover(): Promise<boolean> {
    const spec = this.spec;
    if (!spec) return false;
    let found = false;
    for (;;) {
      const info = await this.gh.repoInfo(`${spec.owner}/${spec.name}-${this.members.length + 1}`);
      if (!info) return found;
      this.#add(info.defaultBranch);
      found = true;
    }
  }

  /** Creates the next member (a private repository) with its meta.json, and its key if encrypted. */
  async #create(): Promise<Remote> {
    const spec = this.spec as PoolSpec;
    const index = this.members.length + 1;
    const name = `${spec.name}-${index}`;
    const full = `${spec.owner}/${name}`;
    const made = await this.gh.createRepo(name, `nubes storage: ${spec.name} (part ${index})`);
    // Null: another device created it meanwhile (`state` checks it is ours).
    const info = made ?? (await this.gh.repoInfo(full));
    if (!info) throw new Error(`${full} exists but cannot be read`);
    if (made) this.#verified.add(full);
    const r = this.#add(info.defaultBranch);
    if (made) {
      await r.ensureMeta();
      const first = this.#last?.members?.findIndex((s) => s.encrypted) ?? -1;
      if (first >= 0) await this.#adopt(r, first);
    }
    return r;
  }

  /** Encrypts member `r` with the key of member `first` (0-based). */
  async #adopt(r: Remote, first: number): Promise<void> {
    if (!this.#cipher) throw new LockedError();
    const blob = this.#last?.members?.[first]?.keyBlob;
    if (!blob) throw new Error("no key in this folder");
    const src = this.members[first] as Remote;
    await r.adoptKey(await this.gh.blob(src.target.full, blob), this.#cipher);
  }

  /** The members' heads: changes when any member changes, or one is added. */
  async head(): Promise<string | null> {
    if (!this.spec) return (this.members[0] as Remote).head();
    await this.discover();
    const heads = await Promise.all(this.members.map((m) => m.head()));
    return heads.some((h) => h) ? heads.map((h) => h ?? "-").join(" ") : null;
  }

  /** Reads every member and their union (refusing a repository of the pool's name that belongs to something else). */
  async state(): Promise<PoolState> {
    await this.discover();
    const spec = this.spec;
    const members = await Promise.all(this.members.map((m) => m.state()));
    if (spec) {
      for (const [i, m] of this.members.entries()) {
        const s = members[i] as RemoteState;
        const full = m.target.full;
        if (this.#verified.has(full)) continue;
        if (s.head) {
          const meta = await m.readMeta(s);
          if (meta?.pool !== spec.name)
            throw new Error(
              `${full} exists and is not part of the nubes folder “${spec.name}”: choose another name, or rename that repository.`,
            );
        }
        this.#verified.add(full);
      }
    }
    const view = await this.#merge(members);
    const files = new Map<string, PoolFile>();
    for (const [p, member] of Object.entries(view.owner)) {
      const s = members[member - 1] as RemoteState;
      const f = s.files.get(p);
      const e = view.files[p];
      if (e) files.set(p, { sha: e.sha, size: e.size, mode: f?.mode ?? "100644", member });
    }
    const blobs = new Set<string>();
    const stored = new Map<string, string>();
    for (const [i, s] of members.entries()) {
      for (const b of s.blobs) blobs.add(b);
      for (const [k, v] of s.stored ?? []) stored.set(k, v);
      for (const f of s.files.values()) if (!this.#where.has(f.sha)) this.#where.set(f.sha, i + 1);
    }
    const heads = members.map((s) => s.head);
    const first = members.find((s) => s.encrypted);
    const out: PoolState = {
      head: heads.some((h) => h) ? heads.map((h) => h ?? "-").join(" ") : null,
      tree: members.every((s) => s.tree) && members.length > 0 ? "pool" : null,
      files,
      blobs,
      hasMeta: members.length > 0 && members.every((s) => s.head && s.hasMeta),
      encrypted: !!first,
      keyBlob: first?.keyBlob ?? null,
      stored,
      foreign: members.flatMap((s) => s.foreign ?? []),
      members,
      owner: view.owner,
      fixups: view.fixups,
    };
    // A folder of one repository: its own state, as before (the rest of the app reads it).
    if (!spec && members[0]) {
      const m = members[0];
      Object.assign(out, { ...m, files, members, owner: view.owner, fixups: view.fixups });
    }
    this.#last = out;
    // Sizes are asked again for the next batch of new files (within a batch, the bytes sent count).
    this.#used = null;
    return out;
  }

  /**
   * Gets every member ready to be written: the first one exists, each has
   * its meta.json, and in an encrypted pool the key. Plain folders created
   * before nubes knew about them work the same.
   */
  async ensureMeta(state?: RemoteState): Promise<void> {
    let s = (state as PoolState | undefined)?.members ? (state as PoolState) : await this.state();
    if (this.spec && this.members.length === 0) {
      await this.#create();
      s = await this.state();
    }
    for (const [i, m] of this.members.entries()) {
      const ms = s.members?.[i];
      if (!ms?.head || !ms.hasMeta) await m.ensureMeta(ms);
    }
    if (!this.spec) return;
    s = await this.state();
    const first = s.members?.findIndex((x) => x.encrypted) ?? -1;
    if (first < 0) return;
    for (const [i, m] of this.members.entries())
      if (!s.members?.[i]?.encrypted) await this.#adopt(m, first);
  }

  /** Opens an encrypted folder with its passphrase (one for every member). */
  async unlock(state: PoolState, passphrase: string): Promise<Cipher> {
    const i = state.members?.findIndex((s) => s.encrypted) ?? -1;
    const m = this.members[i];
    if (!m || !state.members) throw new Error("This folder is not encrypted.");
    const c = await m.unlock(state.members[i] as RemoteState, passphrase);
    this.cipher = c;
    return c;
  }

  /** Makes a new, empty folder encrypted: its key, locked with `passphrase`. */
  async initEncryption(passphrase: string): Promise<Cipher> {
    if (this.spec && this.members.length === 0) await this.discover();
    if (this.spec && this.members.length === 0) await this.#create();
    const s = await this.state();
    if (s.encrypted) throw new Error("This folder is already encrypted.");
    if (s.files.size > 0)
      throw new Error(
        `This folder already has ${s.files.size} plain file${s.files.size === 1 ? "" : "s"}: encryption is for a new folder.`,
      );
    const c = await (this.members[0] as Remote).initEncryption(passphrase);
    this.cipher = c;
    return c;
  }

  /** Where a file is stored in its repository (`.age` added in an encrypted folder). */
  storedPath(path: string): string {
    return (this.members[0] as Remote).storedPath(path);
  }

  /** The nubes path of a repository path, or null if outside the folder or nubes' own. */
  nubesPath(repoPath: string): string | null {
    return (this.members[0] as Remote).nubesPath(repoPath);
  }

  /** Whether content `sha` is already stored somewhere (it is not uploaded again). */
  has(sha: string, state: RemoteState): boolean {
    return state.blobs.has(sha) || this.#where.has(sha);
  }

  async #usedBytes(): Promise<number[]> {
    if (
      this.#used &&
      Date.now() - this.#used.at < 60_000 &&
      this.#used.bytes.length === this.members.length
    )
      return this.#used.bytes.map((b, i) => b + (this.#reserved.get(i + 1) ?? 0));
    const bytes = await Promise.all(
      this.members.map((m) => this.gh.repoInfo(m.target.full).then((r) => r?.size ?? 0)),
    );
    this.#used = { at: Date.now(), bytes };
    this.#reserved.clear();
    return bytes;
  }

  #placeInput(s: PoolState, used: number[] | null, changes: PoolChange[], fixups = true) {
    const members: PoolMember[] = this.members.map((_m, i) => ({
      index: i + 1,
      used: used?.[i] ?? 0,
      files: s.members?.[i] ? snapshot(s.members[i] as RemoteState) : {},
    }));
    const owner = { ...s.owner };
    for (const [p, i] of this.#assigned) owner[p] ??= i;
    return {
      members,
      owner,
      fixups: fixups ? (s.fixups ?? []) : [],
      limit: this.spec?.maxSize ?? null,
      changes,
    };
  }

  /** The engine's merge; a single repository needs no engine (nor its download). */
  async #merge(members: RemoteState[]): Promise<View> {
    if (!this.spec) {
      const m = members[0];
      const files: Snapshot = m ? snapshot(m) : {};
      return {
        files,
        owner: Object.fromEntries(Object.keys(files).map((p) => [p, 1])),
        fixups: [],
      };
    }
    await loadEngine();
    return poolMerge({ members: members.map((s, i) => ({ index: i + 1, files: snapshot(s) })) });
  }

  /** The engine's placement; a single repository takes everything. */
  async #place(input: PlaceInput): Promise<Placement> {
    if (!this.spec) {
      const changes = [...(input.fixups ?? []), ...input.changes].map(({ path, sha, size }) => ({
        path,
        sha,
        size,
      }));
      return { members: changes.length ? [{ index: 1, changes }] : [], create: 0 };
    }
    await loadEngine();
    return poolPlace(input);
  }

  /**
   * Stores content whose plain id is `sha`, in the member that will hold
   * `path` (creating one if every member is full).
   */
  async put(data: Uint8Array, sha: string, state: RemoteState, path?: string): Promise<void> {
    const s = (state as PoolState).members
      ? (state as PoolState)
      : (this.#last ?? (await this.state()));
    let index = (path && (s.owner?.[path] ?? this.#assigned.get(path))) || 0;
    if (!index) {
      const used = this.spec ? await this.#usedBytes() : null;
      const p = await this.#place(
        this.#placeInput(s, used, [{ path: path ?? sha, sha, size: data.length }], false),
      );
      index = p.members[0]?.index ?? 1;
      while (this.members.length < index) await this.#create();
    }
    const m = this.#member(index);
    const ms = s.members?.[index - 1] ?? (await m.state());
    await m.put(data, sha, ms);
    if (path) this.#assigned.set(path, index);
    this.#where.set(sha, index);
    this.#sizes.set(sha, data.length);
    this.#reserved.set(index, (this.#reserved.get(index) ?? 0) + data.length);
  }

  /** The plain content whose id is `sha`, from the member that has it. */
  async get(sha: string): Promise<Uint8Array> {
    const i = this.#where.get(sha);
    if (i) return this.#member(i).get(sha);
    let last: unknown = new Error(`No content for ${sha}`);
    for (const m of this.members) {
      try {
        return await m.get(sha);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** The plain id of `path` at commit `rev` (of whichever member it belongs to). */
  async versionAt(path: string, rev: string): Promise<string | null> {
    const owner = this.#last?.owner?.[path];
    const order = this.members
      .map((_m, i) => i + 1)
      .sort((a, b) => (a === owner ? -1 : b === owner ? 1 : a - b));
    for (const i of order) {
      try {
        const sha = await this.#member(i).versionAt(path, rev);
        if (sha) {
          this.#where.set(sha, i);
          return sha;
        }
      } catch (err) {
        if (!(err instanceof GitHubError) || (err.status !== 404 && err.status !== 422)) throw err;
      }
    }
    return null;
  }

  /**
   * Commits `changes` (nubes paths, plain ids) on `state`: one commit per
   * member that changes, those that receive files first. RefMovedError if a
   * member moved meanwhile (the caller reads again and retries; what was
   * already committed is then seen as done). Returns the new head.
   */
  async commit(changes: TreeChange[], message: string, state: RemoteState): Promise<string> {
    const s = state as PoolState;
    if (!s.members) throw new Error("state not read by this pool");
    const sizeOf = (sha: string | null) =>
      sha
        ? (this.#sizes.get(sha) ?? [...s.files.values()].find((f) => f.sha === sha)?.size ?? 0)
        : 0;
    const wanted = changes.map((c) => ({ path: c.path, sha: c.sha, size: sizeOf(c.sha) }));
    const needsRoom =
      !!this.spec && wanted.some((c) => c.sha && !s.owner?.[c.path] && !this.#assigned.has(c.path));
    const placement = await this.#place(
      this.#placeInput(s, needsRoom ? await this.#usedBytes() : null, wanted),
    );
    if (placement.create > 0) {
      for (let k = 0; k < placement.create; k++) await this.#create();
      throw new RefMovedError(); // read again, with the new members
    }
    const modes = new Map(changes.map((c) => [c.path, c.mode]));
    const heads = (s.members ?? []).map((m) => m.head);
    for (const a of placement.members) {
      const m = this.#member(a.index);
      // A member created by `put` during this change is not in `s` yet.
      const ms = s.members[a.index - 1] ?? (await m.state());
      const out: TreeChange[] = [];
      for (const c of a.changes) {
        if (c.sha && !m.has(c.sha, ms) && this.#where.get(c.sha) !== a.index) {
          // Content stored in another member (a move, a restored version): copy it.
          await m.put(await this.get(c.sha), c.sha, ms);
          this.#where.set(c.sha, a.index);
        }
        const mode = modes.get(c.path) ?? ms.files.get(c.path)?.mode;
        out.push({ path: c.path, sha: c.sha, ...(mode ? { mode } : {}) });
      }
      heads[a.index - 1] = await m.commit(out, message, ms);
      for (const c of a.changes) this.#assigned.delete(c.path);
    }
    if (!this.spec) return heads[0] ?? "";
    return heads.map((h) => h ?? "-").join(" ");
  }

  /**
   * Reads the members, asks `build` for the changes to make on that state,
   * and commits them; starts over if a member moved meanwhile.
   * Returns the new head (or the old one when there was nothing to change).
   */
  async apply(
    build: (state: PoolState) => TreeChange[] | Promise<TreeChange[]>,
    message: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      let state = await this.state();
      if (!state.head || !state.hasMeta) {
        await this.ensureMeta(state);
        state = await this.state();
      }
      const changes = await build(state);
      if ((changes.length === 0 && !state.fixups?.length) || !state.head || !state.tree)
        return state.head;
      try {
        return await this.commit(changes, message, state);
      } catch (err) {
        if (err instanceof RefMovedError) continue;
        throw err;
      }
    }
    throw new RefMovedError();
  }

  /** Commits that touched `path` (a file or folder, "" for the whole folder), newest first, every member merged. */
  async history(path: string, perPage = 30): Promise<CommitInfo[]> {
    const owner = this.#last?.owner?.[path];
    const from = owner ? [this.#member(owner)] : this.members;
    const lists = await Promise.all(
      from.map(async (m) => {
        const p = path
          ? this.#last?.files.has(path)
            ? m.storedPath(path)
            : m.full(path)
          : m.prefix;
        const list = await this.gh.history(m.target.full, m.target.branch, p, 1, perPage);
        return list.map((c) => ({ ...c, repo: m.target.full }));
      }),
    );
    return lists
      .flat()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, perPage);
  }

  /** What a commit of `history` changed. */
  commitFiles(c: CommitInfo): Promise<CommitFiles> {
    return this.gh.commitFiles(c.repo ?? (this.members[0] as Remote).target.full, c.sha);
  }

  /** Each member's size, as GitHub reports it. */
  async sizes(): Promise<MemberSize[]> {
    await this.discover();
    return Promise.all(
      this.members.map(async (m) => ({
        repo: m.target.full,
        size: (await this.gh.repoInfo(m.target.full))?.size ?? 0,
      })),
    );
  }
}
