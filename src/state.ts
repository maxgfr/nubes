/**
 * App state (signals) and the actions that change the repository. Every
 * change is one commit, built on the branch as it is at that moment and
 * retried if another device committed meanwhile. The branch is polled while
 * the page is visible, so what other devices push shows up on its own.
 */
import { batch, computed, signal } from "@preact/signals";
import {
  blobShaOf,
  gitBlobSha,
  Ignore,
  isSafePath,
  loadEngine,
  MAX_BLOB,
  plan,
  type Snapshot,
} from "./engine";
import { GitHub, GitHubError, type TreeChange } from "./github/client";
import { Remote, type RemoteState } from "./github/repo";
import {
  addPending,
  clearPinCache,
  dropPending,
  forgetOffline,
  isPinned,
  loadPins,
  loadSnapshot,
  pendingFiles,
  pinnedBlob,
  savePins,
  saveSnapshot,
  syncPinCache,
} from "./store/offline";
import { deviceName, type Link, loadLink, loadToken, saveLink, saveToken } from "./store/settings";
import { stamp } from "./sync/folder";
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
  | "pending"
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
/** Files added offline, waiting for the network. */
export const pendingCount = signal(0);
/** Folders of the current link kept offline ("" for everything). */
export const pins = signal<string[]>(link.value ? loadPins(link.value) : []);
/** Progress of saving pinned folders for offline use. */
export const pinStatus = signal<string | null>(null);

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
  const l = link.value;
  if (l) void pendingFiles(l).then((p) => (pendingCount.value = p.length));
  if (l && globalThis.navigator?.onLine === false) {
    // Offline: open the folder as last seen; the login is read once back online.
    session.value = { gh: new GitHub(saved.token), login: "" };
    online.value = false;
    void loadEngine();
    void refresh(true);
    return;
  }
  try {
    await signIn(saved.token, saved.remember);
    if (link.value) await refresh(true);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 401) saveToken(null);
    else if (link.value) {
      // Offline: keep the token, show the last tree seen.
      session.value = { gh: new GitHub(saved.token), login: "" };
      void refresh(true);
    }
    fail(err);
  }
}

export async function signOut(): Promise<void> {
  saveToken(null);
  const l = link.value;
  if (l) await forgetOffline(l);
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
    pins.value = next ? loadPins(next) : [];
    pendingCount.value = 0;
  });
  if (next) {
    pendingCount.value = (await pendingFiles(next)).length;
    await refresh(true);
  }
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
      // The last tree seen, at once (offline, or while the network answers).
      const l = link.value;
      if (!remoteState.value && l) {
        const saved = await loadSnapshot(l);
        if (saved && !remoteState.value && link.value === l) remoteState.value = saved;
      }
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
      if (l && link.value === l) void saveSnapshot(l, s);
      void updatePins();
      if (pendingCount.value > 0) void flushPending();
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
    void flushPending();
    const s = session.value;
    // Opened offline: the login is still unknown.
    if (s && !s.login)
      void s.gh.user().then(
        (login) => (session.value = { ...s, login }),
        () => {},
      );
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
  const l = link.value;
  const kept = l ? await pinnedBlob(l, sha) : null;
  const blob = kept
    ? new Blob([kept], { type })
    : new Blob([(await r.gh.blob(r.target.full, sha)) as BlobPart], { type });
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
    (u) => !["done", "unchanged", "skipped", "error", "pending"].includes(u.status),
  );
}

export interface PickedFile {
  /** Path relative to the folder it is dropped in. */
  path: string;
  file: File;
}

type Picked = UploadItem & { file: Blob };

/** Keeps files for later (IndexedDB) and shows them as waiting. */
async function queueOffline(items: Picked[]): Promise<void> {
  const l = link.value;
  if (!l || items.length === 0) return;
  pendingCount.value = await addPending(
    l,
    items.map((i) => ({ path: i.path, file: i.file })),
  );
  for (const it of items) setUpload(it.id, { status: "pending", note: "sent when back online" });
}

/**
 * Uploads files into `dir` as a single commit. Unchanged files and blobs
 * the repository already has are not sent again. Without a network, the
 * files are kept on this device and sent when it comes back.
 */
export function upload(picked: PickedFile[], dir = cwd.value): Promise<void> {
  return uploadNow(picked, dir).then(() => undefined);
}

/** Like `upload`; true when the files were handled (sent, unchanged or refused), false when they wait for the network. */
function uploadNow(picked: { path: string; file: Blob }[], dir: string): Promise<boolean> {
  const items: Picked[] = picked.map((p) => ({
    id: ++uploadId,
    path: joinPath(dir, p.path.normalize("NFC")),
    size: p.file.size,
    status: "queued",
    file: p.file,
  }));
  uploads.value = [...uploads.value, ...items.map(({ file: _f, ...u }) => u)];
  const final = new Set<number>();
  const label = `Uploading ${items.length} file${items.length === 1 ? "" : "s"}`;
  return serial(label, async () => {
    if (!online.value) {
      await queueOffline(items);
      return false;
    }
    try {
      await send();
      return true;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      online.value = false;
      await queueOffline(items.filter((i) => !final.has(i.id)));
      return false;
    }
  }).then((ok) => ok ?? true);

  async function send(): Promise<void> {
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
    const settle = (id: number, patch: Partial<UploadItem>) => {
      final.add(id);
      setUpload(id, patch);
    };
    const worker = async () => {
      while (next < items.length) {
        const it = items[next++] as Picked;
        try {
          if (!isSafePath(it.path)) {
            settle(it.id, { status: "error", note: "invalid name" });
            continue;
          }
          if (ignore.isIgnored(it.path)) {
            settle(it.id, { status: "skipped", note: "ignored" });
            continue;
          }
          if (it.size > MAX_BLOB) {
            settle(it.id, { status: "error", note: "over GitHub's 100 MB limit" });
            continue;
          }
          setUpload(it.id, { status: "hashing" });
          const sha = await blobShaOf(it.file);
          const existing = s.files.get(it.path);
          if (existing?.sha === sha) {
            settle(it.id, { status: "unchanged" });
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
          // The network went away: the whole batch waits for it.
          if (err instanceof TypeError) throw err;
          settle(it.id, { status: "error", note: describeError(err) });
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
      for (const c of ready) settle(c.id, { status: "done" });
      const dirs = new Set(draftDirs.value);
      for (const c of ready) for (const d of dirs) if (c.path.startsWith(`${d}/`)) dirs.delete(d);
      draftDirs.value = dirs;
    } catch (err) {
      if (!(err instanceof TypeError))
        for (const c of ready) settle(c.id, { status: "error", note: describeError(err) });
      throw err;
    }
  }
}

let flushing = false;

/** Sends the files added offline, once the network is back. */
export async function flushPending(): Promise<void> {
  const l = link.value;
  if (flushing || !l || !online.value || !remote.value) return;
  flushing = true;
  try {
    const list = await pendingFiles(l);
    pendingCount.value = list.length;
    if (list.length === 0) return;
    // The new rows of this upload replace the waiting ones.
    uploads.value = uploads.value.filter((u) => u.status !== "pending");
    if (await uploadNow(list, "")) {
      pendingCount.value = await dropPending(l, new Set(list.map((p) => p.id)));
    }
  } finally {
    flushing = false;
  }
}

/** Keeps a folder ("" for everything) on this device, or stops keeping it. */
export function setPinned(dir: string, on: boolean): void {
  const l = link.value;
  if (!l) return;
  const next = on ? [...new Set([...pins.value, dir])] : pins.value.filter((d) => d !== dir);
  pins.value = next;
  savePins(l, next);
  // Asks the browser not to evict the offline copies (Safari would after weeks unused).
  if (on) void globalThis.navigator?.storage?.persist?.().catch(() => false);
  void updatePins();
  const name = dir ? basename(dir) : "Everything";
  toast(on ? `${name} is kept on this device` : `${name} is no longer kept offline`);
}

let pinning = false;
let pinAgain = false;

/** Brings the offline copies in line with the pinned folders and the current tree. */
export async function updatePins(): Promise<void> {
  const l = link.value;
  if (!l) return;
  if (pinning) {
    pinAgain = true;
    return;
  }
  pinning = true;
  try {
    do {
      pinAgain = false;
      const s = remoteState.value;
      if (!s) break;
      const wanted = new Set<string>();
      for (const [p, f] of s.files) if (isPinned(pins.value, p)) wanted.add(f.sha);
      if (wanted.size === 0 && pins.value.length === 0) {
        await clearPinCache(l);
        continue;
      }
      await syncPinCache(
        l,
        wanted,
        (sha) => fetchBlob(sha),
        (done, total) => {
          pinStatus.value = `Saving for offline use (${done}/${total})`;
        },
      );
    } while (pinAgain);
  } catch (err) {
    if (!(err instanceof TypeError)) fail(err);
  } finally {
    pinning = false;
    pinStatus.value = null;
  }
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

/** The changes that move `from` (a file or folder) to `to`, on state `s`. */
function moveChanges(s: RemoteState, from: string, to: string): TreeChange[] {
  if (!isSafePathLoose(to)) throw new Error(`“${to}” is not a valid name`);
  if (to === from || to.startsWith(`${from}/`))
    throw new Error(`${basename(from)} cannot go inside itself`);
  const src = filesUnder(s.files, from);
  if (src.length === 0) throw new Error(`${basename(from)} no longer exists`);
  if (filesUnder(s.files, to).length > 0) throw new Error(`${to} already exists`);
  const out: TreeChange[] = [];
  for (const p of src) {
    const f = s.files.get(p);
    if (!f) continue;
    out.push({ path: to + p.slice(from.length), sha: f.sha, mode: f.mode }, { path: p, sha: null });
  }
  return out;
}

/** Renames or moves a file or folder. Content is not re-uploaded. */
export function move(from: string, to: string): Promise<void> {
  return serial("Moving", async () => {
    await commit(
      (s) => moveChanges(s, from, to),
      `nubes: move ${from} to ${to} (from ${deviceName()})`,
    );
  }).then(() => undefined);
}

/** Moves files and folders into `dir` ("" for the top folder), in one commit. */
export function moveInto(paths: string[], dir: string): Promise<void> {
  return serial("Moving", async () => {
    const moving = paths.filter(
      (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") !== dir,
    );
    if (moving.length === 0) return;
    await commit(
      (s) => moving.flatMap((p) => moveChanges(s, p, joinPath(dir, basename(p)))),
      `nubes: move ${moving.length} item${moving.length === 1 ? "" : "s"} to ${dir || "the top folder"} (from ${deviceName()})`,
    );
    toast(
      `Moved ${moving.length} item${moving.length === 1 ? "" : "s"} to ${dir || "the top folder"}`,
    );
  }).then(() => undefined);
}

/**
 * Saves edited text over `path`, which held `baseSha` when the edit began.
 * If it changed elsewhere meanwhile, the edit is saved as a conflict copy
 * beside it (the engine's rule, as for a sync). Returns where it went.
 */
export function saveText(
  path: string,
  baseSha: string | null,
  text: string,
): Promise<string | null> {
  return serial("Saving", async () => {
    await loadEngine();
    const r = remote.value;
    if (!r) throw new Error("not connected");
    const data = new TextEncoder().encode(text);
    const sha = gitBlobSha(data);
    let target = path;
    await commit(
      async (s) => {
        const now: Snapshot = {};
        for (const [p, f] of s.files) now[p] = { sha: f.sha, size: f.size };
        const base: Snapshot = { ...now };
        if (baseSha) base[path] = { sha: baseSha, size: 0 };
        else delete base[path];
        const p = plan({
          base,
          local: { ...now, [path]: { sha, size: data.length } },
          remote: now,
          device: deviceName(),
          stamp: stamp(),
        });
        const a = p.actions.find((x) => x.path === path);
        if (!a) return [];
        if (a.op === "conflict") target = a.renamedTo;
        else if (a.op === "upload") target = path;
        else throw new Error(`${basename(path)} cannot be saved here`);
        if (!s.blobs.has(sha)) await r.gh.createBlob(r.target.full, data);
        return [{ path: target, sha, mode: s.files.get(path)?.mode ?? "100644" }];
      },
      message({ [baseSha ? "updated" : "added"]: 1 }),
    );
    toast(
      target === path
        ? `Saved ${basename(path)}`
        : `${basename(path)} changed elsewhere meanwhile: your text is saved as ${basename(target)}`,
    );
    return target;
  }).then((t) => t ?? null);
}

/** Brings back a deleted file as it was in commit `before`. Its content is still in the repository. */
export function restoreDeleted(path: string, before: string): Promise<boolean> {
  return serial("Restoring", async () => {
    const r = remote.value;
    if (!r) throw new Error("not connected");
    const sha = await r.gh.fileAt(r.target.full, r.full(path), before);
    if (!sha) throw new Error(`${basename(path)} is not in that version`);
    await commit((s) => {
      if (s.files.has(path)) throw new Error(`${path} exists again`);
      return [{ path, sha, mode: "100644" }];
    }, `nubes: restore ${path} (from ${deviceName()})`);
    toast(`Restored ${path}`);
    return true;
  }).then((ok) => ok ?? false);
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
export function downloadZip(dir: string): Promise<void> {
  const s = remoteState.value;
  const l = link.value;
  if (!s || !l) return Promise.resolve();
  const paths = dir ? filesUnder(s.files, dir) : [...s.files.keys()];
  return zipFiles(paths, dir, `${dir ? basename(dir) : l.repo.split("/")[1]}.zip`);
}

/** Downloads some files and folders of `dir` as one zip. */
export function downloadSelection(items: string[], dir: string): Promise<void> {
  const s = remoteState.value;
  if (!s) return Promise.resolve();
  const paths = [...new Set(items.flatMap((p) => filesUnder(s.files, p)))];
  const name = items.length === 1 ? basename(items[0] as string) : dir ? basename(dir) : "files";
  return zipFiles(paths, dir, `${name}.zip`);
}

/** Zips `paths`, named relative to `dir`. */
async function zipFiles(paths: string[], dir: string, name: string): Promise<void> {
  const s = remoteState.value;
  if (!s || paths.length === 0) return;
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
    saveBlob(blob, name);
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
