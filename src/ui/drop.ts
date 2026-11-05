/**
 * Files from a drop or a file picker, with their relative paths. Folders
 * dropped (Chromium, Firefox, Safari including iPadOS) are walked through
 * the FileSystemEntry API.
 */
import type { PickedFile } from "../state";

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FileEntryLike extends EntryLike {
  file(ok: (f: File) => void, err: (e: unknown) => void): void;
}
interface DirEntryLike extends EntryLike {
  createReader(): { readEntries(ok: (e: EntryLike[]) => void, err: (e: unknown) => void): void };
}

function readAll(dir: DirEntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader();
  const out: EntryLike[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns at most 100 entries per call: read until empty.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: EntryLike, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => (entry as FileEntryLike).file(ok, err));
    out.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry as DirEntryLike)) await walk(child, out);
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: EntryLike[] = [];
  const plain: File[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== "file") continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) plain.push(f);
    }
  }
  const out: PickedFile[] = [];
  for (const e of entries) await walk(e, out);
  for (const f of plain) out.push({ path: f.name, file: f });
  if (out.length === 0) for (const f of [...dt.files]) out.push({ path: f.name, file: f });
  return out;
}

/** Files from an <input type=file> (with `webkitdirectory`, paths include the folder). */
export function filesFromInput(input: HTMLInputElement): PickedFile[] {
  return [...(input.files ?? [])].map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
}

/** Whether this browser can pick a whole folder in a file input. */
export function canPickFolder(): boolean {
  if (typeof document === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return !ios && "webkitdirectory" in document.createElement("input");
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * A name for a pasted image or a camera photo. Their own names are generic
 * ("image.png", "image.jpg"), so they get the date: "Photo 2026-11-05
 * 14.03.27.jpg". A real file name (a file copied in Finder) is kept.
 */
export function capturedName(file: File, prefix: string, index = 0, now = new Date()): string {
  if (file.name && !/^image(\s*\d*)?\.\w+$/i.test(file.name)) return file.name;
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
  const ext = EXT[file.type] ?? file.name.split(".").pop() ?? "bin";
  return `${prefix} ${when}${index ? ` (${index + 1})` : ""}.${ext}`;
}

export function isAppleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
