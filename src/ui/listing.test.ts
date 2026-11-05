import { expect, test } from "bun:test";
import { filesUnder, listDir, searchFiles, sortRows } from "./listing";

const f = (size: number) => ({ sha: "x", size, mode: "100644" });
const files = new Map([
  ["b.txt", f(1)],
  ["a10.txt", f(2)],
  ["a2.txt", f(3)],
  ["docs/x.md", f(4)],
  ["docs/sub/y.md", f(5)],
]);

test("folders first, natural order, folder sizes", () => {
  const rows = listDir(files, "", ["photos"]);
  expect(rows.map((r) => r.name)).toEqual(["docs", "photos", "a2.txt", "a10.txt", "b.txt"]);
  expect(rows[0]).toMatchObject({ kind: "folder", size: 9, count: 2 });
  expect(listDir(files, "docs").map((r) => r.path)).toEqual(["docs/sub", "docs/x.md"]);
});

test("filesUnder", () => {
  expect(filesUnder(files, "docs").sort()).toEqual(["docs/sub/y.md", "docs/x.md"]);
  expect(filesUnder(files, "b.txt")).toEqual(["b.txt"]);
  expect(filesUnder(files, "do")).toEqual([]);
});

test("search matches every word anywhere in the path", () => {
  expect(searchFiles(files, "").map((r) => r.path)).toEqual([]);
  expect(searchFiles(files, "MD").map((r) => r.path)).toEqual(["docs/x.md", "docs/sub/y.md"]);
  expect(searchFiles(files, "docs sub").map((r) => r.path)).toEqual(["docs/sub/y.md"]);
  expect(searchFiles(files, "a txt").map((r) => r.name)).toEqual(["a2.txt", "a10.txt"]);
});

test("sorting keeps folders first; by size, or by date with unknown dates last", () => {
  const rows = listDir(files, "");
  expect(sortRows(rows, "size").map((r) => r.name)).toEqual(["docs", "a2.txt", "a10.txt", "b.txt"]);
  const dates = new Map([
    ["b.txt", "2026-01-03T00:00:00Z"],
    ["a10.txt", "2026-01-01T00:00:00Z"],
    ["docs/sub/y.md", "2026-01-02T00:00:00Z"],
  ]);
  expect(sortRows(rows, "date", dates).map((r) => r.name)).toEqual([
    "docs",
    "b.txt",
    "a10.txt",
    "a2.txt",
  ]);
  expect(sortRows(rows, "name").map((r) => r.name)).toEqual(["docs", "a2.txt", "a10.txt", "b.txt"]);
});
