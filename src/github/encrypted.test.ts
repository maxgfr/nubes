import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeGitHub } from "../../test/fake-github";
import { gitBlobSha, loadEngineSync } from "../engine";
import { GitHub } from "./client";
import { LockedError, Remote } from "./repo";

setDefaultTimeout(30_000);
loadEngineSync(readFileSync(join(import.meta.dir, "../engine/pkg/nubes_engine_bg.wasm")));

const PASS = "correct horse battery staple";
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function setup(prefix = "") {
  const fake = createFakeGitHub();
  fake.addRepo("octo/files");
  const gh = new GitHub("test-token", {
    api: "https://api.test",
    fetch: (input, init) => fake.handle(new Request(input, init)),
    sleep: async () => {},
  });
  const remote = () => new Remote(gh, { full: "octo/files", branch: "main", prefix });
  return { fake, gh, remote };
}

/** Uploads and commits files through `r` (as the app and the CLI do). */
async function write(r: Remote, files: Record<string, string | null>) {
  return r.apply(async (s) => {
    const out = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) out.push({ path, sha: null });
      else {
        const data = bytes(content);
        const sha = gitBlobSha(data);
        await r.put(data, sha, s);
        out.push({ path, sha });
      }
    }
    return out;
  }, "test");
}

describe("encrypted folder", () => {
  test("files are stored as <path>.age with a manifest; the state shows plain paths and ids", async () => {
    const { fake, remote } = setup();
    const a = remote();
    await a.initEncryption(PASS);
    await write(a, { "notes/secret.md": "the plan", "b.txt": "B" });

    const stored = fake.files("octo/files");
    expect(Object.keys(stored).sort()).toEqual([
      ".nubes/key.age",
      ".nubes/manifest.json",
      ".nubes/meta.json",
      "b.txt.age",
      "notes/secret.md.age",
    ]);
    // GitHub sees neither the content nor the key.
    expect(stored["notes/secret.md.age"]).not.toContain("the plan");
    expect(stored[".nubes/key.age"]).not.toContain("AGE-SECRET-KEY");
    expect(JSON.parse(stored[".nubes/meta.json"] as string)).toMatchObject({
      version: 2,
      mode: "age",
    });
    const manifest = JSON.parse(stored[".nubes/manifest.json"] as string);
    expect(manifest.files["b.txt"]).toMatchObject({ plainSha: gitBlobSha(bytes("B")), size: 1 });

    const s = await a.state();
    expect(s.encrypted).toBe(true);
    expect([...s.files.keys()].sort()).toEqual(["b.txt", "notes/secret.md"]);
    expect(s.files.get("b.txt")?.sha).toBe(gitBlobSha(bytes("B")));
    expect(text(await a.get(gitBlobSha(bytes("the plan"))))).toBe("the plan");
  });

  test("another device unlocks with the passphrase; without it, it can list but not read", async () => {
    const { remote } = setup("vault");
    const a = remote();
    await a.initEncryption(PASS);
    await write(a, { "x.txt": "hidden" });

    const b = remote();
    const s = await b.state();
    expect([...s.files.keys()]).toEqual(["x.txt"]);
    const sha = s.files.get("x.txt")?.sha as string;
    await expect(b.get(sha)).rejects.toBeInstanceOf(LockedError);
    await expect(b.unlock(s, "wrong passphrase")).rejects.toThrow("Wrong passphrase");
    await b.unlock(s, PASS);
    expect(text(await b.get(sha))).toBe("hidden");
    expect(b.cipher?.secret).toBe(a.cipher?.secret);
  });

  test("a move reuses the encrypted blob; a delete leaves the manifest", async () => {
    const { fake, remote } = setup();
    const a = remote();
    await a.initEncryption(PASS);
    await write(a, { "a.txt": "A" });
    const blobs = () => fake.log.filter((l) => l === "POST /repos/octo/files/git/blobs").length;
    const before = blobs();
    await a.apply((s) => {
      const f = s.files.get("a.txt");
      return f
        ? [
            { path: "moved/a.txt", sha: f.sha },
            { path: "a.txt", sha: null },
          ]
        : [];
    }, "move");
    // Only the new manifest was uploaded.
    expect(blobs()).toBe(before + 1);
    expect(Object.keys(fake.files("octo/files"))).toContain("moved/a.txt.age");
    await write(a, { "moved/a.txt": null });
    const s = await a.state();
    expect(s.files.size).toBe(0);
    expect(s.manifest?.files).toEqual({});
  });

  test("an old version is found through the manifest of that commit", async () => {
    const { remote } = setup();
    const a = remote();
    await a.initEncryption(PASS);
    const v1 = (await write(a, { "n.md": "v1" })) as string;
    await write(a, { "n.md": "v2" });
    const b = remote();
    await b.unlock(await b.state(), PASS);
    const old = await b.versionAt("n.md", v1);
    expect(old).toBe(gitBlobSha(bytes("v1")));
    expect(text(await b.get(old as string))).toBe("v1");
  });

  test("only an empty folder can become encrypted; files not written by nubes are left alone", async () => {
    const { fake, remote } = setup();
    fake.push("octo/files", { "plain.txt": "p" });
    await expect(remote().initEncryption(PASS)).rejects.toThrow("already has 1 plain file");

    const other = setup();
    const a = other.remote();
    await a.initEncryption(PASS);
    other.fake.push("octo/files", { "README.md": "added on github.com" });
    const s = await a.state();
    expect(s.files.size).toBe(0);
    expect(s.foreign).toEqual(["README.md"]);
  });
});
