/**
 * Two-way sync of a local folder from the browser, with the File System
 * Access API (Chrome, Edge, Opera on desktop). Same engine and same rules as
 * `nubes sync`: plan with nubes-core, remote side in one commit, then the
 * local side, then store the new base (in IndexedDB, with the folder handle).
 *
 * Safari (macOS, iPadOS) and Firefox do not let a page keep write access to
 * a folder, so there the app offers upload and zip download instead.
 */
import { blobShaOf, Ignore, loadEngine, type Plan, plan, type Snapshot } from "../engine";
import { RefMovedError, type TreeChange } from "../github/client";
import type { Remote, RemoteState } from "../github/repo";
import { idbDel, idbGet, idbSet } from "../store/idb";

interface FileState {
  sha: string;
  size: number;
  /** File.lastModified when `sha` was known to match it; 0 otherwise. */
  mtime: number;
}

interface Base {
  head: string | null;
  files: Record<string, FileState>;
}

export interface LinkedFolder {
  handle: FileSystemDirectoryHandle;
  name: string;
  base: Base;
  lastSync: number;
}

interface DirHandle {
  name: string;
  kind: "directory";
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
}

interface FileHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(d: Blob | BufferSource): Promise<void>;
    close(): Promise<void>;
  }>;
}

type Picker = (o: { mode: "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;

export function canSyncFolder(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: Picker }).showDirectoryPicker === "function";
}

const key = (r: Remote) => `folder:${r.target.full}:${r.target.branch}:${r.prefix}`;

export async function linkedFolder(r: Remote): Promise<LinkedFolder | undefined> {
  return idbGet<LinkedFolder>(key(r));
}

export async function linkFolder(r: Remote): Promise<LinkedFolder> {
  const pick = (globalThis as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  const handle = await pick({ mode: "readwrite", id: "nubes" });
  const linked: LinkedFolder = {
    handle,
    name: handle.name,
    base: { head: null, files: {} },
    lastSync: 0,
  };
  await idbSet(key(r), linked);
  return linked;
}

export async function unlinkFolder(r: Remote): Promise<void> {
  await idbDel(key(r));
}

/** True if the page may write to the folder; asks only when `ask` (needs a click). */
export async function hasPermission(l: LinkedFolder, ask: boolean): Promise<boolean> {
  const h = l.handle as unknown as DirHandle;
  if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return ask && (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

async function dirFor(
  root: DirHandle,
  path: string,
  create: boolean,
): Promise<[DirHandle, string]> {
  const parts = path.split("/");
  const name = parts.pop() as string;
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return [d, name];
}

async function readFile(root: DirHandle, path: string): Promise<File> {
  const [d, name] = await dirFor(root, path, false);
  return (await d.getFileHandle(name)).getFile();
}

async function writeFile(root: DirHandle, path: string, data: Blob): Promise<File> {
  const [d, name] = await dirFor(root, path, true);
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
  return fh.getFile();
}

async function deleteFile(root: DirHandle, path: string): Promise<void> {
  const [d, name] = await dirFor(root, path, false);
  await d.removeEntry(name);
}

interface Scanned {
  sha: string;
  size: number;
  mtime: number;
}

async function scan(root: DirHandle, base: Base, ignore: Ignore): Promise<Map<string, Scanned>> {
  const out = new Map<string, Scanned>();
  const walk = async (d: DirHandle, prefix: string) => {
    for await (const [name, h] of d.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind === "directory") {
        if (!ignore.isDirIgnored(path)) await walk(h, path);
        continue;
      }
      if (ignore.isIgnored(path)) continue;
      const f = await h.getFile();
      const cached = base.files[path];
      const sha =
        cached && cached.mtime !== 0 && cached.mtime === f.lastModified && cached.size === f.size
          ? cached.sha
          : await blobShaOf(f);
      out.set(path, { sha, size: f.size, mtime: f.lastModified });
    }
  };
  await walk(root, "");
  return out;
}

/** The time in conflict copy names (UTC, minutes), as the CLI writes it. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export interface FolderSyncResult {
  plan: Plan;
  committed: boolean;
}

/**
 * One sync. `fetch` reads a blob; `progress` reports what is happening.
 * Throws if the folder cannot be written (call hasPermission first).
 */
export async function syncFolder(
  r: Remote,
  l: LinkedFolder,
  device: string,
  progress: (text: string) => void = () => {},
): Promise<FolderSyncResult> {
  await loadEngine();
  const root = l.handle as unknown as DirHandle;
  for (let attempt = 0; attempt < 5; attempt++) {
    progress("Reading the repository");
    let rs: RemoteState = await r.state();
    if (!rs.head || !rs.hasMeta) {
      await r.ensureMeta(rs);
      rs = await r.state();
    }
    let ignoreText = "";
    try {
      ignoreText = await (await readFile(root, ".nubesignore")).text();
    } catch {
      // No .nubesignore.
    }
    const ignore = new Ignore(ignoreText);
    progress("Reading the folder");
    let local: Map<string, Scanned>;
    try {
      local = await scan(root, l.base, ignore);
    } finally {
      ignore.free();
    }
    const snap = (m: Iterable<[string, { sha: string; size: number }]>): Snapshot => {
      const o: Snapshot = {};
      for (const [p, e] of m) o[p] = { sha: e.sha, size: e.size };
      return o;
    };
    const p = plan({
      base: snap(Object.entries(l.base.files)),
      local: snap(local),
      remote: snap(rs.files),
      ignore: ignoreText.split("\n"),
      device,
      stamp: stamp(),
    });

    // Remote side: one commit.
    const changes: TreeChange[] = [];
    let n = 0;
    const toSend = p.actions.filter((a) => a.op === "upload" || (a.op === "conflict" && a.upload));
    for (const a of p.actions) {
      if (a.op === "upload" || (a.op === "conflict" && a.upload)) {
        const sha = a.op === "upload" ? a.sha : a.localSha;
        const dest = a.op === "upload" ? a.path : a.renamedTo;
        if (!rs.blobs.has(sha)) {
          progress(`Uploading ${++n}/${toSend.length}`);
          const f = await readFile(root, a.path);
          if ((await blobShaOf(f)) !== sha) throw new Error(`${a.path} changed during the sync`);
          await r.gh.createBlob(r.target.full, new Uint8Array(await f.arrayBuffer()));
        }
        changes.push({ path: dest, sha, mode: rs.files.get(dest)?.mode ?? "100644" });
      } else if (a.op === "deleteRemote") {
        changes.push({ path: a.path, sha: null });
      }
    }
    let head = rs.head;
    if (changes.length > 0 && rs.head && rs.tree) {
      progress("Committing");
      try {
        head = await r.commit(changes, `nubes: sync from ${device}`, rs.head, rs.tree);
      } catch (err) {
        if (err instanceof RefMovedError) continue;
        throw err;
      }
    }

    // Local side.
    const known = new Map<string, { sha: string; mtime: number; size: number }>(local);
    const get = async (sha: string) =>
      new Blob([(await r.gh.blob(r.target.full, sha)) as BlobPart]);
    let d = 0;
    const toGet = p.actions.filter((a) => a.op === "download" || a.op === "conflict").length;
    for (const a of p.actions) {
      if (a.op === "download") {
        progress(`Downloading ${++d}/${toGet}`);
        const f = await writeFile(root, a.path, await get(a.sha));
        known.set(a.path, { sha: a.sha, mtime: f.lastModified, size: f.size });
      } else if (a.op === "deleteLocal") {
        await deleteFile(root, a.path);
        known.delete(a.path);
      } else if (a.op === "conflict") {
        progress(`Downloading ${++d}/${toGet}`);
        const mine = await readFile(root, a.path);
        const copy = await writeFile(root, a.renamedTo, mine);
        known.set(a.renamedTo, { sha: a.localSha, mtime: copy.lastModified, size: copy.size });
        const f = await writeFile(root, a.path, await get(a.remoteSha));
        known.set(a.path, { sha: a.remoteSha, mtime: f.lastModified, size: f.size });
      }
    }

    const recent = Date.now() - 2000;
    const files: Record<string, FileState> = {};
    for (const [path, e] of Object.entries(p.nextBase)) {
      const k = known.get(path);
      const ok = k && k.sha === e.sha && k.mtime < recent;
      files[path] = { sha: e.sha, size: e.size, mtime: ok ? k.mtime : 0 };
    }
    l.base = { head, files };
    l.lastSync = Date.now();
    await idbSet(key(r), l);
    return { plan: p, committed: changes.length > 0 };
  }
  throw new Error("the repository kept changing during the sync; try again");
}
