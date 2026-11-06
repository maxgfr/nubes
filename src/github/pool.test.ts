/**
 * A folder spread over repositories (`<name>-1`, `<name>-2`…), from the web
 * client: creation, spill-over, edits that stay put, moves across members,
 * duplicate clean-up and one key for an encrypted pool.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeGitHub } from "../../test/fake-github";
import { gitBlobSha, loadEngineSync } from "../engine";
import { GitHub } from "./client";
import { Pool, type PoolState } from "./pool";

setDefaultTimeout(30_000);
loadEngineSync(readFileSync(join(import.meta.dir, "../engine/pkg/nubes_engine_bg.wasm")));

const PASS = "correct horse battery staple";
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const own = (files: Record<string, string>) =>
  Object.keys(files)
    .filter((p) => !p.startsWith(".nubes/"))
    .sort();

function setup(fake = createFakeGitHub()) {
  const gh = new GitHub("test-token", {
    api: "https://api.test",
    fetch: (input, init) => fake.handle(new Request(input, init)),
    sleep: async () => {},
  });
  const pool = () => new Pool(gh, { owner: "octo", name: "box", maxSize: 1024 ** 3 });
  return { fake, gh, pool };
}

/** Uploads and commits files through `p` (as the app does). */
async function write(p: Pool, files: Record<string, string | null>) {
  return p.apply(async (s) => {
    const out = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) out.push({ path, sha: null });
      else {
        const data = bytes(content);
        const sha = gitBlobSha(data);
        await p.put(data, sha, s, path);
        out.push({ path, sha });
      }
    }
    return out;
  }, "test");
}

describe("pool", () => {
  test("the first repository is created on first use; a full one spills into the next", async () => {
    const { fake, pool } = setup();
    const p = pool();
    await write(p, { "a.txt": "A" });
    expect(fake.hasRepo("octo/box-1")).toBe(true);
    expect(JSON.parse(fake.files("octo/box-1")[".nubes/meta.json"] as string)).toMatchObject({
      version: 3,
      pool: "box",
      index: 1,
      maxSize: 1024 ** 3,
    });

    fake.setSize("octo/box-1", 2 * 1024 ** 3);
    await p.state();
    await write(p, { "b.txt": "B", "a.txt": "A2" });
    expect(own(fake.files("octo/box-1"))).toEqual(["a.txt"]);
    expect(fake.files("octo/box-1")["a.txt"]).toBe("A2");
    expect(own(fake.files("octo/box-2"))).toEqual(["b.txt"]);

    // Another tab sees one folder, and reads each file from its repository.
    const other = pool();
    const s = await other.state();
    expect([...s.files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    expect(s.files.get("b.txt")?.member).toBe(2);
    expect(text(await other.get(s.files.get("b.txt")?.sha as string))).toBe("B");
    expect((await other.sizes()).map((m) => m.repo)).toEqual(["octo/box-1", "octo/box-2"]);
    expect((await other.history("")).map((c) => c.repo)).toContain("octo/box-2");
  });

  test("a move to a full repository's sibling copies the content; a duplicate path is cleaned up", async () => {
    const { fake, pool } = setup();
    const p = pool();
    await write(p, { "x.txt": "one" });
    fake.setSize("octo/box-1", 2 * 1024 ** 3);
    await write(p, { "y.txt": "two" });
    // Move x.txt (in box-1, full) to a new path: it fits nowhere but box-2.
    await p.apply((s: PoolState) => {
      const f = s.files.get("x.txt");
      return f
        ? [
            { path: "moved/x.txt", sha: f.sha },
            { path: "x.txt", sha: null },
          ]
        : [];
    }, "move");
    expect(own(fake.files("octo/box-1"))).toEqual([]);
    expect(fake.files("octo/box-2")["moved/x.txt"]).toBe("one");

    // Two devices added dup.txt to both repositories.
    fake.push("octo/box-1", { "dup.txt": "first" });
    fake.push("octo/box-2", { "dup.txt": "second" });
    const s = await p.state();
    expect(s.files.get("dup.txt")?.member).toBe(1);
    await p.apply(() => [], "clean up");
    const two = own(fake.files("octo/box-2"));
    expect(two).not.toContain("dup.txt");
    const copy = two.find((f) => f.startsWith("dup.conflict-")) as string;
    expect(fake.files("octo/box-2")[copy]).toBe("second");
  });

  test("an encrypted pool: one passphrase, the key follows into new repositories", async () => {
    const { fake, pool } = setup();
    const p = pool();
    await p.initEncryption(PASS);
    await write(p, { "secret.txt": "one" });
    fake.setSize("octo/box-1", 2 * 1024 ** 3);
    await write(p, { "more.txt": "two" });
    const key1 = fake.files("octo/box-1")[".nubes/key.age"];
    expect(fake.files("octo/box-2")[".nubes/key.age"]).toBe(key1 as string);
    expect(fake.files("octo/box-2")["more.txt.age"]).not.toContain("two");

    const other = pool();
    const s = await other.state();
    expect(s.encrypted).toBe(true);
    await other.unlock(s, PASS);
    expect(text(await other.get(s.files.get("more.txt")?.sha as string))).toBe("two");
    expect(text(await other.get(s.files.get("secret.txt")?.sha as string))).toBe("one");
  });

  test("a repository of that name that is not a nubes pool is refused", async () => {
    const fake = createFakeGitHub();
    fake.addRepo("octo/box-1");
    fake.push("octo/box-1", { "README.md": "mine" });
    const { pool } = setup(fake);
    await expect(pool().state()).rejects.toThrow(/not part of the nubes folder/);
  });
});
