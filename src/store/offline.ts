/**
 * What lets the app work without a network, per linked folder:
 * - the last tree seen (IndexedDB), so the listing shows up offline;
 * - files added offline (IndexedDB), sent when the network comes back;
 * - folders kept offline: their files in Cache Storage (`nubes-pins:<link>`),
 *   by blob id, so a preview or a download needs no network.
 */
import type { RemoteState } from "../github/repo";
import { idbDel, idbGet, idbSet } from "./idb";
import type { Link } from "./settings";

export const linkKey = (l: Link) => `${l.repo}#${l.branch}#${l.prefix}`;

// --- Last tree seen ------------------------------------------------------

export function saveSnapshot(l: Link, s: RemoteState): Promise<void> {
  return idbSet(`tree:${linkKey(l)}`, s).then(
    () => undefined,
    () => undefined,
  );
}

export function loadSnapshot(l: Link): Promise<RemoteState | undefined> {
  return idbGet<RemoteState>(`tree:${linkKey(l)}`).catch(() => undefined);
}

/** Forgets what this device keeps of a folder (on sign-out), except files not sent yet. */
export async function forgetOffline(l: Link): Promise<void> {
  await idbDel(`tree:${linkKey(l)}`).catch(() => undefined);
  await clearPinCache(l);
}

// --- Uploads waiting for the network -------------------------------------

export interface PendingFile {
  id: string;
  /** Path in the nubes folder. */
  path: string;
  file: Blob;
}

/**
 * As stored: bytes, not a Blob. WebKit refuses Blobs in IndexedDB in
 * private browsing ("Error preparing Blob/File data").
 */
interface StoredPending {
  id: string;
  path: string;
  data: ArrayBuffer;
  type: string;
}

const pendingKey = (l: Link) => `pending:${linkKey(l)}`;

async function stored(l: Link): Promise<StoredPending[]> {
  return (await idbGet<StoredPending[]>(pendingKey(l)).catch(() => undefined)) ?? [];
}

export async function pendingFiles(l: Link): Promise<PendingFile[]> {
  return (await stored(l)).map((p) => ({
    id: p.id,
    path: p.path,
    file: new Blob([p.data], { type: p.type }),
  }));
}

/** Queues files (a later file for the same path replaces the earlier one); returns the queue length. */
export async function addPending(l: Link, files: { path: string; file: Blob }[]): Promise<number> {
  const byPath = new Map((await stored(l)).map((p) => [p.path, p]));
  for (const f of files) {
    byPath.set(f.path, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      path: f.path,
      data: await f.file.arrayBuffer(),
      type: f.file.type,
    });
  }
  await idbSet(pendingKey(l), [...byPath.values()]);
  return byPath.size;
}

/** Removes sent files; returns what is left. */
export async function dropPending(l: Link, ids: ReadonlySet<string>): Promise<number> {
  const left = (await stored(l)).filter((p) => !ids.has(p.id));
  await idbSet(pendingKey(l), left);
  return left.length;
}

// --- Folders kept offline ------------------------------------------------

const PINS_KEY = "nubes.pins.v1";
export const PIN_CACHE_PREFIX = "nubes-pins";
const pinCacheName = (l: Link) => `${PIN_CACHE_PREFIX}:${linkKey(l)}`;

function allPins(): Record<string, string[]> {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(PINS_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** Folders of this link kept offline ("" is the whole folder). */
export function loadPins(l: Link): string[] {
  const v = allPins()[linkKey(l)];
  return Array.isArray(v) ? v.filter((d) => typeof d === "string") : [];
}

export function savePins(l: Link, dirs: string[]): void {
  const all = allPins();
  if (dirs.length) all[linkKey(l)] = dirs;
  else delete all[linkKey(l)];
  try {
    globalThis.localStorage?.setItem(PINS_KEY, JSON.stringify(all));
  } catch {
    // Storage full or disabled: pins last for this visit only.
  }
}

/** Whether `path` is a pinned folder or inside one. */
export function isPinned(pins: readonly string[], path: string): boolean {
  return pins.some((d) => d === "" || path === d || path.startsWith(`${d}/`));
}

const hasCaches = () => typeof globalThis.caches !== "undefined";
// Cache keys must be URLs; these are never fetched.
const pinUrl = (sha: string) => `https://nubes.invalid/blob/${sha}`;

export async function pinnedBlob(l: Link, sha: string): Promise<Blob | null> {
  if (!hasCaches()) return null;
  try {
    const hit = await (await caches.open(pinCacheName(l))).match(pinUrl(sha));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

/**
 * Makes the cache hold exactly `wanted` (blob ids): drops the others, then
 * fetches the missing ones. Returns how many are stored.
 */
export async function syncPinCache(
  l: Link,
  wanted: ReadonlySet<string>,
  fetchBlob: (sha: string) => Promise<Blob>,
  progress: (done: number, total: number) => void,
): Promise<number> {
  if (!hasCaches()) return 0;
  const cache = await caches.open(pinCacheName(l));
  const have = new Set<string>();
  for (const req of await cache.keys()) {
    const sha = req.url.slice(req.url.lastIndexOf("/") + 1);
    if (wanted.has(sha)) have.add(sha);
    else await cache.delete(req);
  }
  const missing = [...wanted].filter((s) => !have.has(s));
  let done = 0;
  for (const sha of missing) {
    progress(done, missing.length);
    await cache.put(pinUrl(sha), new Response(await fetchBlob(sha)));
    done++;
  }
  return have.size + done;
}

export async function clearPinCache(l: Link): Promise<void> {
  if (hasCaches()) await caches.delete(pinCacheName(l)).catch(() => false);
}
