import { expect, test } from "bun:test";
import { isPinned, linkKey } from "./offline";

test("a path is pinned when it is a pinned folder or inside one", () => {
  expect(isPinned([], "a.txt")).toBe(false);
  expect(isPinned([""], "any/thing.txt")).toBe(true);
  expect(isPinned(["docs"], "docs")).toBe(true);
  expect(isPinned(["docs"], "docs/a/b.txt")).toBe(true);
  expect(isPinned(["docs"], "docs2/a.txt")).toBe(false);
  expect(isPinned(["docs/old"], "docs/a.txt")).toBe(false);
});

test("offline data is kept per repository, branch and folder", () => {
  expect(linkKey({ repo: "o/r", branch: "main", prefix: "" })).not.toBe(
    linkKey({ repo: "o/r", branch: "main", prefix: "sub" }),
  );
});
