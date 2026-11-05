/**
 * What recent commits changed, for the "Recently deleted" panel, the date
 * sort and the activity feed. A commit never changes, so what it changed is
 * cached in IndexedDB: the 100 latest commits cost 100 requests once, then
 * one per new commit.
 */
import type { CommitFiles, CommitInfo, GitHub } from "./github/client";
import type { Remote } from "./github/repo";
import { idbGet, idbSet } from "./store/idb";

/** How far back the panels look. */
export const RECENT = 100;

export interface RecentCommit extends CommitInfo, CommitFiles {}

async function filesOf(gh: GitHub, full: string, sha: string): Promise<CommitFiles> {
  const key = `commit:${full}:${sha}`;
  const hit = await idbGet<CommitFiles>(key).catch(() => undefined);
  if (hit) return hit;
  const got = await gh.commitFiles(full, sha);
  await idbSet(key, got).catch(() => undefined);
  return got;
}

/** The latest commits of the branch with the files each one changed, newest first. */
export async function recentCommits(r: Remote, limit = RECENT): Promise<RecentCommit[]> {
  const { full, branch } = r.target;
  const list = await r.gh.history(full, branch, r.prefix, 1, Math.min(limit, 100));
  const out: RecentCommit[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const c = list[i] as CommitInfo;
      out[i] = { ...c, ...(await filesOf(r.gh, full, c.sha)) };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return out;
}

/** A repository path as a path of the nubes folder, or null if outside it (or nubes' own). */
export type ToNubes = (repoPath: string) => string | null;

/** For a plain folder at `prefix` (an encrypted one: `Remote.nubesPath`). */
export function relative(prefix: string, path: string): string | null {
  const rel = !prefix ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
  return rel === null || rel.startsWith(".nubes/") ? null : rel;
}

const mapper = (m: string | ToNubes): ToNubes =>
  typeof m === "string" ? (p) => relative(m, p) : m;

export interface Deleted {
  /** Path in the nubes folder. */
  path: string;
  /** When it was deleted. */
  date: string;
  message: string;
  /** The commit before the deletion, where the file still is. */
  before: string;
}

/** Files deleted by recent commits and not back since, latest deletion first. */
export function deletedFiles(
  commits: RecentCommit[],
  prefix: string | ToNubes,
  current: ReadonlyMap<string, unknown>,
): Deleted[] {
  const toNubes = mapper(prefix);
  const seen = new Set<string>();
  const out: Deleted[] = [];
  for (const c of commits) {
    for (const f of c.files) {
      if (f.status !== "removed" || !c.parent) continue;
      const path = toNubes(f.path);
      if (!path || seen.has(path) || current.has(path)) continue;
      seen.add(path);
      out.push({ path, date: c.date, message: c.message, before: c.parent });
    }
  }
  return out;
}

/** When each file was last changed, as far back as the commits go. */
export function changeDates(
  commits: RecentCommit[],
  prefix: string | ToNubes,
): Map<string, string> {
  const toNubes = mapper(prefix);
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      const path = toNubes(f.path);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      // Deleted since: older dates are those of another file.
      if (f.status !== "removed") out.set(path, c.date);
    }
  }
  return out;
}

/** The device a nubes commit came from ("(from ipad)", "sync from mac"), if it says. */
export function deviceOf(message: string): string | null {
  const first = message.split("\n")[0] ?? "";
  const m = /\(from ([^)]+)\)\s*$/.exec(first) ?? /^nubes: sync from (.+)$/.exec(first);
  return m ? (m[1] as string).trim() : null;
}
