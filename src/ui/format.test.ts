import { expect, test } from "bun:test";
import { basename, dirname, humanSize, joinPath, kindOf, timeAgo } from "./format";

test("format helpers", () => {
  expect(humanSize(10)).toBe("10 B");
  expect(humanSize(1536)).toBe("1.5 KB");
  expect(humanSize(50 * 1024 * 1024)).toBe("50 MB");
  expect(basename("a/b/c.txt")).toBe("c.txt");
  expect(dirname("a/b/c.txt")).toBe("a/b");
  expect(dirname("c.txt")).toBe("");
  expect(joinPath("", "x")).toBe("x");
  expect(kindOf("Photo.JPG")).toBe("image");
  expect(kindOf("notes.md")).toBe("text");
  expect(kindOf("README")).toBe("text");
  expect(kindOf("a.bin")).toBe("other");
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(timeAgo("2026-11-05T11:59:50Z", now)).toBe("just now");
  expect(timeAgo("2026-11-05T09:00:00Z", now)).toBe("3 h ago");
});
