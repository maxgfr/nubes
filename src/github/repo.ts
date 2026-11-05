/**
 * A nubes folder inside a GitHub repository: one branch, and optionally a
 * prefix (a sub-folder of the repository). Paths here are relative to the
 * prefix; the repository-wide `.nubes/meta.json` marks it as a nubes repo.
 */
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

export interface RemoteState {
  /** The branch's commit, null while the repository is empty. */
  head: string | null;
  tree: string | null;
  /** Files under the prefix, by path relative to it. Symlinks and submodules are left out. */
  files: Map<string, RemoteFile>;
  /** Every blob id in the tree: uploading one of these again is never needed. */
  blobs: Set<string>;
  /** Whether `.nubes/meta.json` exists at the repository root. */
  hasMeta: boolean;
}

export const META_PATH = ".nubes/meta.json";

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

export class Remote {
  readonly prefix: string;

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

  async state(): Promise<RemoteState> {
    const { full, branch } = this.target;
    const head = await this.gh.head(full, branch);
    const files = new Map<string, RemoteFile>();
    const blobs = new Set<string>();
    if (!head) return { head, tree: null, files, blobs, hasMeta: false };
    const tree = await this.gh.commitTree(full, head);
    const strip = this.prefix ? `${this.prefix}/` : "";
    let hasMeta = false;
    for (const e of await this.gh.tree(full, tree)) {
      if (e.type !== "blob") continue;
      blobs.add(e.sha);
      if (e.path === META_PATH) hasMeta = true;
      // Symlinks (120000) are not files nubes can sync.
      if (e.mode === "120000") continue;
      if (strip && !e.path.startsWith(strip)) continue;
      // nubes' own metadata is not one of the user's files.
      if (!strip && e.path.startsWith(".nubes/")) continue;
      files.set(e.path.slice(strip.length), { sha: e.sha, size: e.size ?? 0, mode: e.mode });
    }
    return { head, tree, files, blobs, hasMeta };
  }

  /** Writes `.nubes/meta.json` if missing; creates the first commit of an empty repository. */
  async ensureMeta(state?: RemoteState): Promise<void> {
    const s = state ?? (await this.state());
    if (s.hasMeta) return;
    await this.gh.putFile(
      this.target.full,
      this.target.branch,
      META_PATH,
      new TextEncoder().encode(metaJson()),
      "nubes: initialize",
    );
  }

  /**
   * Commits `changes` on top of `head` (whose tree is `tree`) and moves the
   * branch, only if nobody moved it in between (RefMovedError otherwise).
   */
  async commit(
    changes: TreeChange[],
    message: string,
    head: string,
    tree: string,
  ): Promise<string> {
    const { full, branch } = this.target;
    const newTree = await this.gh.createTree(
      full,
      tree,
      changes.map((c) => ({ ...c, path: this.full(c.path) })),
    );
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
        return await this.commit(changes, message, state.head, state.tree);
      } catch (err) {
        if (err instanceof RefMovedError) continue;
        throw err;
      }
    }
    throw new RefMovedError();
  }
}

export { GitHub };
