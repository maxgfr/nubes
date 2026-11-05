/** Turns the flat file map of a repository into the rows of one folder. */
import type { RemoteFile } from "../github/repo";

export interface Row {
  kind: "folder" | "file";
  name: string;
  path: string;
  size: number;
  /** Files inside (folders only). */
  count: number;
  sha?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function listDir(
  files: ReadonlyMap<string, RemoteFile>,
  dir: string,
  extraDirs: Iterable<string> = [],
): Row[] {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map<string, Row>();
  const rows: Row[] = [];
  for (const [path, f] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      rows.push({ kind: "file", name: rest, path, size: f.size, count: 0, sha: f.sha });
      continue;
    }
    const name = rest.slice(0, slash);
    const row = folders.get(name) ?? {
      kind: "folder",
      name,
      path: prefix + name,
      size: 0,
      count: 0,
    };
    row.size += f.size;
    row.count += 1;
    folders.set(name, row);
  }
  for (const d of extraDirs) {
    if (!d.startsWith(prefix)) continue;
    const name = d.slice(prefix.length).split("/")[0];
    if (name && !folders.has(name))
      folders.set(name, { kind: "folder", name, path: prefix + name, size: 0, count: 0 });
  }
  const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);
  return [...[...folders.values()].sort(byName), ...rows.sort(byName)];
}

/** Every file at or under `path` (a file or a folder). */
export function filesUnder(files: ReadonlyMap<string, RemoteFile>, path: string): string[] {
  if (files.has(path)) return [path];
  const prefix = `${path}/`;
  return [...files.keys()].filter((p) => p.startsWith(prefix));
}

export function totals(files: ReadonlyMap<string, RemoteFile>): { count: number; size: number } {
  let size = 0;
  for (const f of files.values()) size += f.size;
  return { count: files.size, size };
}
