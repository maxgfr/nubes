/**
 * A small GitHub REST client: just the git data, contents and commits
 * endpoints nubes needs, with a fine-grained token. Runs in the browser
 * (fetch) and under Bun (tests). Retries rate limits and transient errors;
 * never retries a ref update, whose refusal is meaningful.
 */

export const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The branch moved since it was read: re-read, re-plan, retry. */
export class RefMovedError extends Error {
  constructor() {
    super("the branch moved while committing");
    this.name = "RefMovedError";
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** A change to apply in a commit: `sha: null` deletes the path. */
export interface TreeChange {
  path: string;
  mode?: string;
  sha: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  api?: string;
  fetch?: FetchLike;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Json = Record<string, unknown>;

export class GitHub {
  readonly api: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(token: string, opts: ClientOptions = {}) {
    this.#token = token;
    this.api = (opts.api ?? API).replace(/\/$/, "");
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = opts.sleep ?? sleepReal;
  }

  async #send(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    const idempotent = method === "GET" || path.endsWith("/git/blobs");
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(`${this.api}${path}`, {
          method,
          headers: {
            accept,
            authorization: `Bearer ${this.#token}`,
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
        });
      } catch (err) {
        // Offline for sure: fail now rather than after 7 s of retries.
        if (idempotent && attempt < 3 && globalThis.navigator?.onLine !== false) {
          await this.#sleep(1000 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res.ok) return res;
      const wait = retryDelay(res, attempt, idempotent);
      if (wait !== null) {
        await this.#sleep(wait);
        continue;
      }
      let message = res.statusText;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) message = j.message;
      } catch {
        // Not JSON: keep the status text.
      }
      throw new GitHubError(res.status, message, path);
    }
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#send(method, path, body);
    return (await res.json()) as T;
  }

  /** The login the token belongs to. */
  async user(): Promise<string> {
    const u = await this.#json<{ login: string }>("GET", "/user");
    return u.login;
  }

  /** Repositories the token can see, most recently pushed first. */
  async repos(): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    for (let page = 1; page <= 5; page++) {
      const list = await this.#json<Json[]>(
        "GET",
        `/user/repos?per_page=100&sort=pushed&page=${page}`,
      );
      out.push(...list.map(repoInfo));
      if (list.length < 100) break;
    }
    return out;
  }

  async repo(full: string): Promise<RepoInfo> {
    return repoInfo(await this.#json<Json>("GET", `/repos/${full}`));
  }

  /**
   * Whether the token can really write to the repository. `permissions.push`
   * describes the account, not a fine-grained token, so this creates an
   * empty blob: harmless (never referenced by a tree) and refused with 403
   * when the token only has Contents: Read. An empty repository refuses the
   * git data API (409): nothing can be checked there before the first commit.
   */
  async canWrite(full: string): Promise<boolean> {
    try {
      await this.createBlob(full, new Uint8Array());
      return true;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) return true;
      if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) return false;
      throw err;
    }
  }

  /** The commit a branch points to, or null if the branch (or the whole repository) is empty. */
  async head(full: string, branch: string): Promise<string | null> {
    try {
      const r = await this.#json<{ object: { sha: string } }>(
        "GET",
        `/repos/${full}/git/ref/heads/${encodeRef(branch)}`,
      );
      return r.object.sha;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    }
  }

  async commitTree(full: string, commit: string): Promise<string> {
    const c = await this.#json<{ tree: { sha: string } }>(
      "GET",
      `/repos/${full}/git/commits/${commit}`,
    );
    return c.tree.sha;
  }

  /** Every entry under `tree`, recursively (walking subtrees if GitHub truncates the listing). */
  async tree(full: string, tree: string): Promise<TreeEntry[]> {
    const r = await this.#json<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      `/repos/${full}/git/trees/${tree}?recursive=1`,
    );
    if (!r.truncated) return r.tree;
    return this.#walk(full, tree, "");
  }

  async #walk(full: string, tree: string, prefix: string): Promise<TreeEntry[]> {
    const r = await this.#json<{ tree: TreeEntry[] }>("GET", `/repos/${full}/git/trees/${tree}`);
    const out: TreeEntry[] = [];
    for (const e of r.tree) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      out.push({ ...e, path });
      if (e.type === "tree") out.push(...(await this.#walk(full, e.sha, path)));
    }
    return out;
  }

  /** A blob's raw bytes. */
  async blob(full: string, sha: string): Promise<Uint8Array> {
    const res = await this.#send(
      "GET",
      `/repos/${full}/git/blobs/${sha}`,
      undefined,
      "application/vnd.github.raw+json",
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async createBlob(full: string, data: Uint8Array): Promise<string> {
    const r = await this.#json<{ sha: string }>("POST", `/repos/${full}/git/blobs`, {
      content: toBase64(data),
      encoding: "base64",
    });
    return r.sha;
  }

  async createTree(full: string, base: string | null, changes: TreeChange[]): Promise<string> {
    const r = await this.#json<{ sha: string }>("POST", `/repos/${full}/git/trees`, {
      ...(base ? { base_tree: base } : {}),
      tree: changes.map((c) => ({
        path: c.path,
        mode: c.mode ?? "100644",
        type: "blob",
        sha: c.sha,
      })),
    });
    return r.sha;
  }

  async createCommit(
    full: string,
    message: string,
    tree: string,
    parents: string[],
  ): Promise<string> {
    const r = await this.#json<{ sha: string }>("POST", `/repos/${full}/git/commits`, {
      message,
      tree,
      parents,
    });
    return r.sha;
  }

  /** Moves the branch to `commit`, only if that is a fast-forward. */
  async updateRef(full: string, branch: string, commit: string): Promise<void> {
    try {
      await this.#send("PATCH", `/repos/${full}/git/refs/heads/${encodeRef(branch)}`, {
        sha: commit,
        force: false,
      });
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 422 || err.status === 409)) {
        throw new RefMovedError();
      }
      throw err;
    }
  }

  /**
   * Creates or replaces one file through the contents API. The git data API
   * refuses to work on an empty repository; this endpoint creates its first commit.
   */
  async putFile(
    full: string,
    branch: string,
    path: string,
    data: Uint8Array,
    message: string,
  ): Promise<string> {
    const r = await this.#json<{ commit: { sha: string } }>(
      "PUT",
      `/repos/${full}/contents/${encodePath(path)}`,
      { message, content: toBase64(data), branch },
    );
    return r.commit.sha;
  }

  /** The blob id of `path` at `ref`, or null if it does not exist there. */
  async fileAt(full: string, path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.#json<{ sha: string; type: string }>(
        "GET",
        `/repos/${full}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
      return r.type === "file" ? r.sha : null;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /** Commits that touched `path` (a file or folder), newest first. */
  async history(full: string, branch: string, path: string, page = 1): Promise<CommitInfo[]> {
    const q = new URLSearchParams({ sha: branch, per_page: "30", page: String(page) });
    if (path) q.set("path", path);
    const list = await this.#json<
      {
        sha: string;
        commit: { message: string; author: { name: string; date: string } | null };
        author: { login: string } | null;
      }[]
    >("GET", `/repos/${full}/commits?${q}`);
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      date: c.commit.author?.date ?? "",
      author: c.author?.login ?? c.commit.author?.name ?? "",
    }));
  }
}

function repoInfo(j: Json): RepoInfo {
  const perms = (j.permissions ?? {}) as { push?: boolean };
  return {
    fullName: String(j.full_name),
    defaultBranch: String(j.default_branch ?? "main"),
    private: Boolean(j.private),
    canPush: perms.push ?? true,
  };
}

/** How long to wait before retrying, or null to give up. */
function retryDelay(res: Response, attempt: number, idempotent: boolean): number | null {
  if (attempt >= 3) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if ((res.status === 403 || res.status === 429) && retryAfter > 0) {
    return retryAfter <= 60 ? retryAfter * 1000 : null;
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
    return reset > 0 && reset <= 60_000 ? reset + 1000 : null;
  }
  if (res.status === 429) return 2000 * 2 ** attempt;
  if (idempotent && res.status >= 500) return 1000 * 2 ** attempt;
  return null;
}

function encodeRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Base64 without building a giant intermediate string when the platform can help. */
export function toBase64(data: Uint8Array): string {
  const native = (data as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(data);
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
