/**
 * An in-memory GitHub: the REST endpoints nubes uses, with real git blob
 * ids, fast-forward-only ref updates and GitHub's quirks (an empty
 * repository refuses the git data API, a tree deletion of a missing path is
 * an error). Used by the unit tests, the Playwright tests (through
 * page.route) and the CLI integration tests (as an HTTP server).
 */
import { createHash } from "node:crypto";

type Obj =
  | { type: "blob"; data: Uint8Array }
  | { type: "tree"; entries: Map<string, { mode: string; sha: string }> }
  | { type: "commit"; tree: string; parents: string[]; message: string; date: string };

interface Repo {
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, Obj>;
  refs: Map<string, string>;
}

export interface FakeGitHub {
  handle(req: Request): Promise<Response>;
  /** Creates an empty repository. */
  addRepo(full: string, opts?: { private?: boolean; branch?: string }): void;
  /** Files of a branch, path → text (test helper). */
  files(full: string, branch?: string): Record<string, string>;
  /** Commits a set of files directly (test helper): path → content, null deletes. */
  push(full: string, files: Record<string, string | null>, message?: string): string;
  /** Number of commits reachable from the branch. */
  commitCount(full: string, branch?: string): number;
  /** Runs `fn` right before the next ref update is applied (to simulate a race). */
  beforeNextRefUpdate(fn: () => void): void;
  /** Every request seen, as "METHOD /path". */
  log: string[];
  tokens: Set<string>;
  /** Tokens that can read but not write (fine-grained token with Contents: Read-only). */
  readOnly: Set<string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function sha1(type: string, body: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`${type} ${body.length}\0`);
  h.update(body);
  return h.digest("hex");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, message: string): Response {
  return json({ message }, status);
}

export function createFakeGitHub(opts: { login?: string; tokens?: string[] } = {}): FakeGitHub {
  const login = opts.login ?? "octo";
  const tokens = new Set(opts.tokens ?? ["test-token"]);
  const readOnly = new Set<string>();
  const repos = new Map<string, Repo>();
  const log: string[] = [];
  let refHook: (() => void) | null = null;

  const put = (r: Repo, o: Obj): string => {
    let sha: string;
    if (o.type === "blob") sha = sha1("blob", o.data);
    else if (o.type === "tree") {
      const body = [...o.entries].sort(([a], [b]) => (a < b ? -1 : 1));
      sha = sha1("tree", enc.encode(JSON.stringify(body)));
    } else sha = sha1("commit", enc.encode(JSON.stringify(o)));
    r.objects.set(sha, o);
    return sha;
  };

  const get = <T extends Obj["type"]>(r: Repo, sha: string, type: T) => {
    const o = r.objects.get(sha);
    return o && o.type === type ? (o as Extract<Obj, { type: T }>) : undefined;
  };

  /** path → {mode, sha} for every blob under a tree. */
  const flatten = (
    r: Repo,
    tree: string,
    prefix = "",
    out = new Map<string, { mode: string; sha: string }>(),
  ) => {
    const t = get(r, tree, "tree");
    if (!t) return out;
    for (const [name, e] of t.entries) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (e.mode === "040000") flatten(r, e.sha, p, out);
      else out.set(p, e);
    }
    return out;
  };

  const build = (r: Repo, files: Map<string, { mode: string; sha: string }>): string => {
    const root = new Map<string, unknown>();
    for (const [path, e] of files) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.get(part);
        if (!(next instanceof Map)) {
          next = new Map();
          dir.set(part, next);
        }
        dir = next as Map<string, unknown>;
      }
      dir.set(parts[parts.length - 1] as string, e);
    }
    const write = (dir: Map<string, unknown>): string => {
      const entries = new Map<string, { mode: string; sha: string }>();
      for (const [name, v] of dir) {
        if (v instanceof Map)
          entries.set(name, { mode: "040000", sha: write(v as Map<string, unknown>) });
        else entries.set(name, v as { mode: string; sha: string });
      }
      return put(r, { type: "tree", entries });
    };
    return write(root);
  };

  const commitFiles = (
    r: Repo,
    branch: string,
    files: Map<string, { mode: string; sha: string }>,
    message: string,
  ) => {
    const head = r.refs.get(branch);
    const tree = build(r, files);
    const c = put(r, {
      type: "commit",
      tree,
      parents: head ? [head] : [],
      message,
      date: new Date(Date.now() + r.objects.size).toISOString(),
    });
    r.refs.set(branch, c);
    return c;
  };

  const repoOf = (owner: string, name: string) => repos.get(`${owner}/${name}`.toLowerCase());

  const branchFiles = (r: Repo, branch: string) => {
    const head = r.refs.get(branch);
    const c = head ? get(r, head, "commit") : undefined;
    return c ? flatten(r, c.tree) : new Map<string, { mode: string; sha: string }>();
  };

  const routes: [
    string,
    RegExp,
    (
      r: Repo | undefined,
      m: RegExpMatchArray,
      req: Request,
      url: URL,
    ) => Promise<Response> | Response,
  ][] = [
    ["GET", /^\/user$/, () => json({ login })],
    [
      "GET",
      /^\/user\/repos$/,
      () =>
        json(
          [...repos.values()].map((r) => ({
            full_name: `${r.owner}/${r.name}`,
            default_branch: r.defaultBranch,
            private: r.private,
            permissions: { push: true },
          })),
        ),
    ],
    [
      "GET",
      /^\/repos\/([^/]+)\/([^/]+)$/,
      (r) =>
        r
          ? json({
              full_name: `${r.owner}/${r.name}`,
              default_branch: r.defaultBranch,
              private: r.private,
              permissions: { push: true },
            })
          : err(404, "Not Found"),
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/,
      (r, m) => {
        if (!r) return err(404, "Not Found");
        if (r.refs.size === 0) return err(409, "Git Repository is empty.");
        const sha = r.refs.get(decodeURIComponent(m[1] as string));
        return sha ? json({ object: { sha, type: "commit" } }) : err(404, "Not Found");
      },
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/,
      (r, m) => {
        const c = r && get(r, m[1] as string, "commit");
        return c
          ? json({
              sha: m[1],
              tree: { sha: c.tree },
              parents: c.parents.map((sha) => ({ sha })),
              message: c.message,
            })
          : err(404, "Not Found");
      },
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/git\/trees\/([0-9a-f]{40})$/,
      (r, m, _req, url) => {
        const t = r && get(r, m[1] as string, "tree");
        if (!r || !t) return err(404, "Not Found");
        const out: { path: string; mode: string; type: string; sha: string; size?: number }[] = [];
        const walk = (tree: string, prefix: string, recursive: boolean) => {
          const tt = get(r, tree, "tree");
          if (!tt) return;
          for (const [name, e] of [...tt.entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (e.mode === "040000") {
              out.push({ path: p, mode: e.mode, type: "tree", sha: e.sha });
              if (recursive) walk(e.sha, p, true);
            } else {
              const b = get(r, e.sha, "blob");
              out.push({
                path: p,
                mode: e.mode,
                type: "blob",
                sha: e.sha,
                size: b?.data.length ?? 0,
              });
            }
          }
        };
        walk(m[1] as string, "", url.searchParams.has("recursive"));
        return json({ sha: m[1], tree: out, truncated: false });
      },
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]{40})$/,
      (r, m, req) => {
        const b = r && get(r, m[1] as string, "blob");
        if (!b) return err(404, "Not Found");
        if ((req.headers.get("accept") ?? "").includes("raw"))
          return new Response(new Uint8Array(b.data));
        return json({
          sha: m[1],
          size: b.data.length,
          encoding: "base64",
          content: Buffer.from(b.data).toString("base64"),
        });
      },
    ],
    [
      "POST",
      /^\/repos\/[^/]+\/[^/]+\/git\/blobs$/,
      async (r, _m, req) => {
        if (!r) return err(404, "Not Found");
        if (r.refs.size === 0) return err(409, "Git Repository is empty.");
        const body = (await req.json()) as { content: string; encoding: string };
        const data =
          body.encoding === "base64"
            ? new Uint8Array(Buffer.from(body.content, "base64"))
            : enc.encode(body.content);
        return json({ sha: put(r, { type: "blob", data }) }, 201);
      },
    ],
    [
      "POST",
      /^\/repos\/[^/]+\/[^/]+\/git\/trees$/,
      async (r, _m, req) => {
        if (!r) return err(404, "Not Found");
        if (r.refs.size === 0) return err(409, "Git Repository is empty.");
        const body = (await req.json()) as {
          base_tree?: string;
          tree: { path: string; mode: string; type: string; sha: string | null }[];
        };
        const files = body.base_tree
          ? flatten(r, body.base_tree)
          : new Map<string, { mode: string; sha: string }>();
        if (body.base_tree && !get(r, body.base_tree, "tree"))
          return err(422, "base_tree is not a tree");
        for (const e of body.tree) {
          if (e.sha === null) {
            const under = [...files.keys()].filter(
              (p) => p === e.path || p.startsWith(`${e.path}/`),
            );
            if (under.length === 0)
              return err(422, `GitRPC::BadObjectState: ${e.path} does not exist`);
            for (const p of under) files.delete(p);
          } else {
            if (!get(r, e.sha, "blob")) return err(422, `tree.sha ${e.sha} is not a valid blob`);
            for (const p of files.keys()) {
              if (p.startsWith(`${e.path}/`) || e.path.startsWith(`${p}/`)) {
                return err(422, `GitRPC::BadObjectState: ${e.path} clashes with ${p}`);
              }
            }
            files.set(e.path, { mode: e.mode, sha: e.sha });
          }
        }
        return json({ sha: build(r, files) }, 201);
      },
    ],
    [
      "POST",
      /^\/repos\/[^/]+\/[^/]+\/git\/commits$/,
      async (r, _m, req) => {
        if (!r) return err(404, "Not Found");
        const body = (await req.json()) as { message: string; tree: string; parents: string[] };
        if (!get(r, body.tree, "tree")) return err(422, "tree is not a tree");
        for (const p of body.parents)
          if (!get(r, p, "commit")) return err(422, "parent is not a commit");
        const sha = put(r, {
          type: "commit",
          tree: body.tree,
          parents: body.parents,
          message: body.message,
          date: new Date(Date.now() + r.objects.size).toISOString(),
        });
        return json({ sha }, 201);
      },
    ],
    [
      "PATCH",
      /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/,
      async (r, m, req) => {
        if (!r) return err(404, "Not Found");
        const body = (await req.json()) as { sha: string; force?: boolean };
        const branch = decodeURIComponent(m[1] as string);
        if (refHook) {
          const fn = refHook;
          refHook = null;
          fn();
        }
        const current = r.refs.get(branch);
        if (!current) return err(422, "Reference does not exist");
        const c = get(r, body.sha, "commit");
        if (!c) return err(422, "Object does not exist");
        // Fast-forward: the current head must be an ancestor of the new commit.
        const ancestors = new Set<string>();
        const stack = [body.sha];
        while (stack.length) {
          const s = stack.pop() as string;
          if (ancestors.has(s)) continue;
          ancestors.add(s);
          stack.push(...(get(r, s, "commit")?.parents ?? []));
        }
        if (!body.force && !ancestors.has(current)) return err(422, "Update is not a fast forward");
        r.refs.set(branch, body.sha);
        return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
      },
    ],
    [
      "PUT",
      /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
      async (r, m, req) => {
        if (!r) return err(404, "Not Found");
        const body = (await req.json()) as {
          message: string;
          content: string;
          branch?: string;
          sha?: string;
        };
        const branch = body.branch ?? r.defaultBranch;
        const path = decodeURIComponent(m[1] as string);
        const files = branchFiles(r, branch);
        const existing = files.get(path);
        if (existing && body.sha !== existing.sha)
          return err(409, `${path} does not match ${body.sha ?? "(none)"}`);
        const blob = put(r, {
          type: "blob",
          data: new Uint8Array(Buffer.from(body.content, "base64")),
        });
        files.set(path, { mode: "100644", sha: blob });
        const commit = commitFiles(r, branch, files, body.message);
        return json(
          { content: { path, sha: blob }, commit: { sha: commit } },
          existing ? 200 : 201,
        );
      },
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
      (r, m, _req, url) => {
        if (!r) return err(404, "Not Found");
        const ref = url.searchParams.get("ref") ?? r.defaultBranch;
        const commit =
          r.refs.get(ref) ??
          (/^[0-9a-f]{4,40}$/.test(ref)
            ? [...r.objects.keys()].find((k) => k.startsWith(ref))
            : undefined) ??
          ref;
        const c = get(r, commit, "commit");
        if (!c) return err(404, "No commit found for the ref");
        const e = flatten(r, c.tree).get(decodeURIComponent(m[1] as string));
        return e ? json({ type: "file", sha: e.sha, path: m[1] }) : err(404, "Not Found");
      },
    ],
    [
      "GET",
      /^\/repos\/[^/]+\/[^/]+\/commits$/,
      (r, _m, _req, url) => {
        if (!r) return err(404, "Not Found");
        if (r.refs.size === 0) return err(409, "Git Repository is empty.");
        const start = r.refs.get(url.searchParams.get("sha") ?? r.defaultBranch);
        const path = url.searchParams.get("path") ?? "";
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const out: unknown[] = [];
        const inPath = (files: Map<string, { sha: string }>) =>
          [...files]
            .filter(([p]) => !path || p === path || p.startsWith(`${path}/`))
            .map(([p, e]) => `${p}:${e.sha}`)
            .join(",");
        let sha = start;
        while (sha) {
          const c = get(r, sha, "commit");
          if (!c) break;
          const parent = c.parents[0];
          const pc = parent ? get(r, parent, "commit") : undefined;
          const now = inPath(flatten(r, c.tree));
          const before = pc ? inPath(flatten(r, pc.tree)) : "";
          if (now !== before) {
            out.push({
              sha,
              commit: { message: c.message, author: { name: login, date: c.date } },
              author: { login },
            });
          }
          sha = parent;
        }
        return json(out.slice((page - 1) * perPage, page * perPage));
      },
    ],
  ];

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    log.push(`${req.method} ${url.pathname}`);
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^(Bearer|token)\s+/i, "");
    if (!tokens.has(token)) return err(401, "Bad credentials");
    if (req.method !== "GET" && readOnly.has(token))
      return err(403, "Resource not accessible by personal access token");
    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)/);
      const r = repoMatch ? repoOf(repoMatch[1] as string, repoMatch[2] as string) : undefined;
      return fn(r, m, req, url);
    }
    return err(404, `fake GitHub: no route for ${req.method} ${url.pathname}`);
  }

  return {
    handle,
    log,
    tokens,
    readOnly,
    addRepo(full, o = {}) {
      const [owner, name] = full.split("/") as [string, string];
      repos.set(full.toLowerCase(), {
        owner,
        name,
        private: o.private ?? true,
        defaultBranch: o.branch ?? "main",
        objects: new Map(),
        refs: new Map(),
      });
    },
    files(full, branch) {
      const r = repos.get(full.toLowerCase());
      if (!r) throw new Error(`no repo ${full}`);
      const out: Record<string, string> = {};
      for (const [p, e] of branchFiles(r, branch ?? r.defaultBranch)) {
        out[p] = dec.decode(get(r, e.sha, "blob")?.data ?? new Uint8Array());
      }
      return out;
    },
    push(full, changes, message = "test push") {
      const r = repos.get(full.toLowerCase());
      if (!r) throw new Error(`no repo ${full}`);
      const files = branchFiles(r, r.defaultBranch);
      for (const [p, text] of Object.entries(changes)) {
        if (text === null) files.delete(p);
        else
          files.set(p, { mode: "100644", sha: put(r, { type: "blob", data: enc.encode(text) }) });
      }
      return commitFiles(r, r.defaultBranch, files, message);
    },
    commitCount(full, branch) {
      const r = repos.get(full.toLowerCase());
      if (!r) return 0;
      let n = 0;
      let sha = r.refs.get(branch ?? r.defaultBranch);
      while (sha) {
        n++;
        sha = get(r, sha, "commit")?.parents[0];
      }
      return n;
    },
    beforeNextRefUpdate(fn) {
      refHook = fn;
    },
  };
}

/** Serves a fake GitHub over HTTP (for the CLI tests). */
export function serveFakeGitHub(fake: FakeGitHub, port = 0) {
  return Bun.serve({ port, fetch: (req) => fake.handle(req) });
}
