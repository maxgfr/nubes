import { expect, test } from "bun:test";
import { filesUnder, listDir } from "./listing";

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
