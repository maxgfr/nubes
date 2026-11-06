import { expect, test } from "bun:test";
import { createFakeGitHub } from "../test/fake-github";
import { changeDates, deletedFiles, deviceOf, recentCommits, relative } from "./changes";
import { GitHub } from "./github/client";
import { Pool } from "./github/pool";
import { capturedName } from "./ui/drop";

function setup(prefix = "") {
  const fake = createFakeGitHub();
  fake.addRepo("octo/files");
  const gh = new GitHub("test-token", {
    api: "https://api.test",
    fetch: (input, init) => fake.handle(new Request(input, init)),
    sleep: async () => {},
  });
  return { fake, remote: new Pool(gh, null, { full: "octo/files", branch: "main", prefix }) };
}

test("deleted files are found in recent commits, unless they are back", async () => {
  const { fake, remote } = setup();
  fake.push("octo/files", { "a.txt": "A", "b.txt": "B", "c.txt": "C", ".nubes/meta.json": "{}" });
  fake.push("octo/files", { "a.txt": null, "b.txt": null }, "nubes: 2 deleted (from ipad)");
  fake.push("octo/files", { "b.txt": "B again" });
  const commits = await recentCommits(remote);
  expect(commits).toHaveLength(3);
  const s = await remote.state();
  const gone = deletedFiles(commits, "", s.files);
  expect(gone.map((d) => d.path)).toEqual(["a.txt"]);
  // `before` is the commit that still has it.
  expect(await remote.gh.fileAt("octo/files", "a.txt", gone[0]?.before as string)).not.toBeNull();
  expect(changeDates(commits, "").get("b.txt")).toBe(commits[0]?.date);
  expect(changeDates(commits, "").has("a.txt")).toBe(false);
});

test("a prefix limits what is reported to the nubes folder", async () => {
  const { fake, remote } = setup("cloud");
  fake.push("octo/files", { "cloud/x.txt": "x", "other/y.txt": "y" });
  fake.push("octo/files", { "cloud/x.txt": null, "other/y.txt": null });
  const commits = await recentCommits(remote);
  expect(deletedFiles(commits, "cloud", new Map()).map((d) => d.path)).toEqual(["x.txt"]);
  expect(relative("cloud", "cloud/a/b")).toBe("a/b");
  expect(relative("cloud", "cloudy/a")).toBeNull();
  expect(relative("", ".nubes/meta.json")).toBeNull();
});

test("the device a commit came from", () => {
  expect(deviceOf("nubes: 2 added (from ipad)")).toBe("ipad");
  expect(deviceOf("nubes: sync from mac-mini")).toBe("mac-mini");
  expect(deviceOf("nubes: move a to b (from web)\n\nbody")).toBe("web");
  expect(deviceOf("Initial commit")).toBeNull();
});

test("pasted and camera images get a dated name; real names are kept", () => {
  const at = new Date(2026, 10, 5, 14, 3, 7);
  const f = (name: string, type: string) => new File(["x"], name, { type });
  expect(capturedName(f("image.png", "image/png"), "Pasted", 0, at)).toBe(
    "Pasted 2026-11-05 14.03.07.png",
  );
  expect(capturedName(f("image.jpg", "image/jpeg"), "Photo", 1, at)).toBe(
    "Photo 2026-11-05 14.03.07 (2).jpg",
  );
  expect(capturedName(f("", "image/heic"), "Photo", 0, at)).toBe("Photo 2026-11-05 14.03.07.heic");
  expect(capturedName(f("receipt.pdf", "application/pdf"), "Pasted", 0, at)).toBe("receipt.pdf");
});
