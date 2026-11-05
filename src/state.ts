/**
 * App state (signals) and the actions that change the repository. Every
 * change is one commit, built on the branch as it is at that moment and
 * retried if another device committed meanwhile. The branch is polled while
 * the page is visible, so what other devices push shows up on its own.
 */
import { batch, computed, signal } from "@preact/signals";
import { blobShaOf, Ignore, isSafePath, loadEngine, MAX_BLOB } from "./engine";
import { GitHub, GitHubError, type TreeChange } from "./github/client";
import { Remote, type RemoteState } from "./github/repo";
import { deviceName, type Link, loadLink, loadToken, saveLink, saveToken } from "./store/settings";
import { basename, joinPath } from "./ui/format";
import { filesUnder } from "./ui/listing";

export const POLL_MS = 30_000;

export interface Session {
  gh: GitHub;
  login: string;
}

export type UploadStatus =
  | "queued"
  | "hashing"
  | "uploading"
  | "ready"
  | "committing"
  | "done"
  | "unchanged"
  | "skipped"
  | "error";

export interface UploadItem {
  id: number;
  path: string;
  size: number;
  status: UploadStatus;
  note?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

export const session = signal<Session | null>(null);
export const link = signal<Link | null>(loadLink());
export const remoteState = signal<RemoteState | null>(null);
export const loading = signal(false);
export const lastChecked = signal(0);
export const online = signal(globalThis.navigator?.onLine ?? true);
export const cwd = signal("");
/** Folders created in the UI that hold no file yet (git has no empty folders). */
export const draftDirs = signal<Set<string>>(new Set());
export const uploads = signal<UploadItem[]>([]);
export const toasts = signal<Toast[]>([]);
export const busy = signal<string | null>(null);

export const remote = computed(() => {
  const s = session.value;
  const l = link.value;
  return s && l ? new Remote(s.gh, { full: l.repo, branch: l.branch, prefix: l.prefix }) : null;
});

let toastId = 0;
export function toast(text: string, tone: Toast["tone"] = "info"): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, tone }];
  setTimeout(() => dismissToast(id), tone === "error" ? 9000 : 4500);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function describeError(err: unknown): string {
  if (err instanceof GitHubError) {
    if (err.status === 401) return "GitHub refused the token (expired or revoked). Sign in again.";
    if (err.status === 403)
      return `GitHub refused: ${err.message}. The token needs “Contents: Read and write” on this repository.`;
    if (err.status === 404) return "Repository not found, or the token cannot access it.";
    return `GitHub error ${err.status}: ${err.message}`;
  }
  if (err instanceof TypeError) return "Network error: check your connection.";
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown): void {
  toast(describeError(err), "error");
  if (err instanceof GitHubError && err.status === 401) void signOut();
}

// --- Session -------------------------------------------------------------

/** Checks a token with GitHub and opens a session. */
export async function signIn(token: string, remember: boolean): Promise<void> {
  const gh = new GitHub(token.trim());
  const login = await gh.user();
  saveToken(token.trim(), remember);
  session.value = { gh, login };
  void loadEngine();
}

/** Restores the session saved on this device, if any. */
export async function resume(): Promise<void> {
  const saved = loadToken();
  if (!saved) return;
  try {
    await signIn(saved.token, saved.remember);
    if (link.value) await refresh(true);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 401) saveToken(null);
    else if (link.value) {
      // Offline: keep the token, show the error.
      session.value = { gh: new GitHub(saved.token), login: "" };
    }
    fail(err);
  }
}

export async function signOut(): Promise<void> {
  saveToken(null);
  batch(() => {
    session.value = null;
    remoteState.value = null;
    cwd.value = "";
  });
}

export async function chooseRepo(next: Link | null): Promise<void> {
  saveLink(next);
  batch(() => {
    link.value = next;
    remoteState.value = null;
    cwd.value = "";
    draftDirs.value = new Set();
  });
  if (next) await refresh(true);
}

// --- Reading -------------------------------------------------------------

let refreshing: Promise<void> | null = null;

/**
 * Re-reads the branch. Unless `force`, only one request (the branch head)
 * is spent when nothing changed.
 */
export function refresh(force = false): Promise<void> {
  refreshing ??= (async () => {
    const r = remote.value;
    if (!r) return;
    loading.value = true;
    try {
      const current = remoteState.value;
      if (!force && current) {
        const head = await r.gh.head(r.target.full, r.target.branch);
        if (head === current.head) {
          lastChecked.value = Date.now();
          online.value = true;
          return;
        }
      }
      const s = await r.state();
      batch(() => {
        remoteState.value = s;
        lastChecked.value = Date.now();
        online.value = true;
      });
    } catch (err) {
      if (err instanceof TypeError) online.value = false;
      else fail(err);
    } finally {
      loading.value = false;
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Polls the branch while the page is visible; re-checks on focus and when back online. */
export function startPolling(): () => void {
  const tick = () => {
    if (document.visibilityState === "visible" && !busy.value) void refresh();
  };
  const timer = setInterval(tick, POLL_MS);
  const onVisible = () => tick();
  const onOnline = () => {
    online.value = true;
    tick();
  };
  const onOffline = () => {
    online.value = false;
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

const blobCache = new Map<string, Blob>();
let blobCacheBytes = 0;

/** A file's content (cached in memory, up to ~150 MB). */
export async function fetchBlob(sha: string, type = "application/octet-stream"): Promise<Blob> {
  const hit = blobCache.get(sha);
  if (hit) return hit.type === type ? hit : new Blob([hit], { type });
  const r = remote.value;
  if (!r) throw new Error("not connected");
  const bytes = await r.gh.blob(r.target.full, sha);
  const blob = new Blob([bytes as BlobPart], { type });
  while (blobCacheBytes + blob.size > 150 * 1024 * 1024 && blobCache.size) {
    const [k, v] = blobCache.entries().next().value as [string, Blob];
    blobCache.delete(k);
    blobCacheBytes -= v.size;
  }
  if (blob.size < 50 * 1024 * 1024) {
    blobCache.set(sha, blob);
    blobCacheBytes += blob.size;
  }
  return blob;
}

/** The `.nubesignore` at the root of the nubes folder, if any. */
async function ignoreText(s: RemoteState): Promise<string> {
  const f = s.files.get(".nubesignore");
  if (!f) return "";
  return (await fetchBlob(f.sha)).text();
}

// --- Writing -------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Runs repository changes one after another. */
function serial<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const run = queue.then(async () => {
    busy.value = label;
    try {
      return await fn();
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      busy.value = null;
    }
  });
  queue = run;
  return run;
}

function message(parts: Record<string, number>): string {
  const text = Object.entries(parts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return `nubes: ${text || "update"} (from ${deviceName()})`;
}

/** Applies changes built on the current branch, then re-reads it. */
async function commit(
  build: (s: RemoteState) => TreeChange[] | Promise<TreeChange[]>,
  msg: string,
): Promise<boolean> {
  const r = remote.value;
  if (!r) throw new Error("not connected");
  let changed = false;
  await r.apply(async (s) => {
    const changes = await build(s);
    changed = changes.length > 0;
    return changes;
  }, msg);
  await refresh(true);
  return changed;
}

let uploadId = 0;

function setUpload(id: number, patch: Partial<UploadItem>): void {
  uploads.value = uploads.value.map((u) => (u.id === id ? { ...u, ...patch } : u));
}

export function clearFinishedUploads(): void {
  uploads.value = uploads.value.filter(
    (u) => !["done", "unchanged", "skipped", "error"].includes(u.status),
  );
}

export interface PickedFile {
  /** Path relative to the folder it is dropped in. */
  path: string;
  file: File;
}

/**
 * Uploads files into `dir` as a single commit. Unchanged files and blobs
 * the repository already has are not sent again.
 */
export function upload(picked: PickedFile[], dir = cwd.value): Promise<void> {
  const items: (UploadItem & { file: File })[] = picked.map((p) => ({
    id: ++uploadId,
    path: joinPath(dir, p.path.normalize("NFC")),
    size: p.file.size,
    status: "queued",
    file: p.file,
  }));
  uploads.value = [...uploads.value, ...items.map(({ file: _f, ...u }) => u)];
  return serial(`Uploading ${items.length} file${items.length === 1 ? "" : "s"}`, async () => {
    await loadEngine();
    const r = remote.value;
    if (!r) throw new Error("not connected");
    let s = remoteState.value ?? (await r.state());
    if (!s.head || !s.hasMeta) {
      await r.ensureMeta(s);
      s = await r.state();
    }
    const ignore = new Ignore(await ignoreText(s));
    const ready: (TreeChange & { id: number })[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const it = items[next++] as UploadItem & { file: File };
        try {
          if (!isSafePath(it.path)) {
            setUpload(it.id, { status: "error", note: "invalid name" });
            continue;
          }
          if (ignore.isIgnored(it.path)) {
            setUpload(it.id, { status: "skipped", note: "ignored" });
            continue;
          }
          if (it.size > MAX_BLOB) {
            setUpload(it.id, { status: "error", note: "over GitHub's 100 MB limit" });
            continue;
          }
          setUpload(it.id, { status: "hashing" });
          const sha = await blobShaOf(it.file);
          const existing = s.files.get(it.path);
          if (existing?.sha === sha) {
            setUpload(it.id, { status: "unchanged" });
            continue;
          }
          if (!s.blobs.has(sha)) {
            setUpload(it.id, { status: "uploading" });
            const got = await r.gh.createBlob(
              r.target.full,
              new Uint8Array(await it.file.arrayBuffer()),
            );
            if (got !== sha) throw new Error(`GitHub stored ${got}, expected ${sha}`);
          }
          ready.push({ id: it.id, path: it.path, sha, mode: existing?.mode ?? "100644" });
          setUpload(it.id, { status: "ready" });
        } catch (err) {
          setUpload(it.id, { status: "error", note: describeError(err) });
        }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      ignore.free();
    }
    if (ready.length === 0) return;
    for (const c of ready) setUpload(c.id, { status: "committing" });
    const added = ready.filter((c) => !s.files.has(c.path)).length;
    try {
      await commit(
        (now) =>
          ready
            .filter((c) => now.files.get(c.path)?.sha !== c.sha)
            .map(({ path, sha, mode }) => ({ path, sha, ...(mode ? { mode } : {}) })),
        message({ added, updated: ready.length - added }),
      );
      for (const c of ready) setUpload(c.id, { status: "done" });
      const dirs = new Set(draftDirs.value);
      for (const c of ready) for (const d of dirs) if (c.path.startsWith(`${d}/`)) dirs.delete(d);
      draftDirs.value = dirs;
    } catch (err) {
      for (const c of ready) setUpload(c.id, { status: "error", note: describeError(err) });
      throw err;
    }
  }).then(() => undefined);
}

/** Deletes files and folders (everything under them) in one commit. */
export function remove(paths: string[]): Promise<void> {
  return serial("Deleting", async () => {
    let n = 0;
    await commit(
      (s) => {
        const all = new Set(paths.flatMap((p) => filesUnder(s.files, p)));
        n = all.size;
        return [...all].map((path) => ({ path, sha: null }));
      },
      message({ deleted: paths.length }),
    );
    const drafts = new Set(draftDirs.value);
    for (const p of paths) drafts.delete(p);
    draftDirs.value = drafts;
    toast(
      n === 1
        ? "Deleted 1 file (still in the history)"
        : `Deleted ${n} files (still in the history)`,
    );
  }).then(() => undefined);
}

/** Renames or moves a file or folder. Content is not re-uploaded. */
export function move(from: string, to: string): Promise<void> {
  return serial("Moving", async () => {
    if (!isSafePathLoose(to)) throw new Error(`“${to}” is not a valid name`);
    await commit((s) => {
      const src = filesUnder(s.files, from);
      if (src.length === 0) throw new Error(`${basename(from)} no longer exists`);
      if (filesUnder(s.files, to).length > 0) throw new Error(`${to} already exists`);
      const out: TreeChange[] = [];
      for (const p of src) {
        const f = s.files.get(p);
        if (!f) continue;
        const dest = to + p.slice(from.length);
        out.push({ path: dest, sha: f.sha, mode: f.mode }, { path: p, sha: null });
      }
      return out;
    }, `nubes: move ${from} to ${to} (from ${deviceName()})`);
  }).then(() => undefined);
}

/** Makes an older version of a file the current one. */
export function restoreVersion(path: string, sha: string): Promise<void> {
  return serial("Restoring", async () => {
    const changed = await commit((s) => {
      const f = s.files.get(path);
      return f?.sha === sha ? [] : [{ path, sha, mode: f?.mode ?? "100644" }];
    }, `nubes: restore ${path} (from ${deviceName()})`);
    toast(changed ? `Restored ${basename(path)}` : `${basename(path)} already has that content`);
  }).then(() => undefined);
}

function isSafePathLoose(p: string): boolean {
  return (
    p.length > 0 && !p.startsWith("/") && p.split("/").every((c) => c && c !== "." && c !== "..")
  );
}

export function addDraftDir(path: string): void {
  draftDirs.value = new Set([...draftDirs.value, path]);
}

/** Saves a Blob through a temporary link (works on iPadOS Safari too). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadFile(path: string): Promise<void> {
  const f = remoteState.value?.files.get(path);
  if (!f) return;
  try {
    busy.value = `Downloading ${basename(path)}`;
    saveBlob(await fetchBlob(f.sha), basename(path));
  } catch (err) {
    fail(err);
  } finally {
    busy.value = null;
  }
}

/** Downloads a folder (or everything) as a zip. */
export async function downloadZip(dir: string): Promise<void> {
  const s = remoteState.value;
  const l = link.value;
  if (!s || !l) return;
  const paths = dir ? filesUnder(s.files, dir) : [...s.files.keys()];
  if (paths.length === 0) return;
  try {
    const { zip } = await import("./ui/zip");
    let done = 0;
    busy.value = `Preparing zip (0/${paths.length})`;
    const strip = dir ? `${dir}/` : "";
    const blob = await zip(
      paths.map((p) => ({
        name: p.slice(strip.length),
        read: async () => {
          const f = s.files.get(p);
          const b = f ? await fetchBlob(f.sha) : new Blob([]);
          busy.value = `Preparing zip (${++done}/${paths.length})`;
          return new Uint8Array(await b.arrayBuffer());
        },
      })),
    );
    saveBlob(blob, `${dir ? basename(dir) : l.repo.split("/")[1]}.zip`);
  } catch (err) {
    fail(err);
  } finally {
    busy.value = null;
  }
}

export const isEmptyRepo = computed(() => {
  const s = remoteState.value;
  return !!s && s.files.size === 0;
});
